// api/routes/admin.js — management: inventory, documents, applications, chat, orders, payments, delivery
const router = require('express').Router();
const { z } = require('zod');
const { service } = require('./supabase');
const { requireUser, requireAdmin: need } = require('./auth');
const { ah, HttpError, idParam, uuid, birdNames, buyerNames } = require('./util');
const { audit } = require('./audit');
const { notifyBuyer } = require('./notify');

router.use(requireUser);

const INV = ['super_admin', 'inventory_manager'];
const REV = ['super_admin', 'application_reviewer'];
const CHAT = ['super_admin', 'customer_support', 'application_reviewer'];
const ORD = ['super_admin', 'customer_support'];

const BIRD_STATUS = ['Draft', 'Pending Verification', 'Available', 'Reserved', 'Sold', 'Archived'];
const DOC_STATUS = ['Not Started', 'In Review', 'Verified', 'Rejected'];
const APP_STATUS = ['Not Reviewed', 'Chat in Progress', 'Additional Information Required', 'Suitable', 'Not Suitable', 'Final Review'];
const DELIVERY_STATUS = ['Not Arranged', 'Awaiting Verification', 'Transport Coordination', 'Ready for Dispatch', 'In Transit', 'Delivered', 'Cancelled'];

const s = (n) => z.string().trim().max(n).transform((v) => (v === '' ? null : v)).nullable().optional();
const httpsUrl = z.string().trim().max(1000).url().refine((v) => v.startsWith('https://'), 'Must start with https://').nullable().optional();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional();

// ======================================================================= OVERVIEW (counts only, no money)
router.get('/overview', need(), ah(async (req, res) => {
  const count = async (table, f) => {
    let q = service.from(table).select('id', { count: 'exact', head: true });
    if (f) q = f(q);
    const { count: c, error } = await q;
    if (error) throw error;
    return c;
  };
  const [birds, published, drafts, pendingApps, openChats, unread, awaitingPay] = await Promise.all([
    count('birds'),
    count('birds', (q) => q.in('status', ['Available', 'Reserved'])),
    count('birds', (q) => q.eq('status', 'Draft')),
    count('applications', (q) => q.eq('status', 'Not Reviewed')),
    count('conversations', (q) => q.eq('status', 'Open')),
    count('messages', (q) => q.eq('sender_type', 'buyer').is('read_at', null)),
    count('orders', (q) => q.in('payment_status', ['Awaiting Payment', 'Submitted for Verification'])),
  ]);
  res.json({ total_birds: birds, published_birds: published, draft_birds: drafts,
    applications_not_reviewed: pendingApps, open_conversations: openChats,
    unread_buyer_messages: unread, orders_awaiting_payment: awaitingPay });
}));

// ======================================================================= BIRD INVENTORY
const birdShape = z.object({
  listing_name: z.string().trim().min(2).max(100),
  species_common: s(150),
  scientific_name: s(150),
  species_note: s(500),
  description: s(5000),
  price_php: z.number().min(0).max(1000000),
  image_url: httpsUrl,
  image_attribution_text: s(1000),
  image_photographer: s(300),
  image_source_page: httpsUrl,
  image_license: s(150),
  image_license_url: httpsUrl,
  image_license_verified: z.boolean(),
  status: z.enum(BIRD_STATUS),
  identity_verified: z.boolean(),
  documentation_status: z.enum(DOC_STATUS),
  provenance_info: s(3000),
  care_info: s(5000),
  sort_order: z.number().int().min(0).max(10000),
});
const birdCreate = birdShape.omit({ image_license_verified: true, status: true, identity_verified: true, documentation_status: true })
  .partial({ species_common: true, scientific_name: true, species_note: true, description: true, image_url: true,
    image_attribution_text: true, image_photographer: true, image_source_page: true, image_license: true,
    image_license_url: true, provenance_info: true, care_info: true, sort_order: true }).strict();
const birdPatch = birdShape.partial().strict();

router.get('/birds', need(), ah(async (req, res) => {
  const { data, error } = await req.db.from('birds').select('*').order('sort_order');
  if (error) throw error;
  res.json({ birds: data });
}));

router.post('/birds', need(...INV), ah(async (req, res) => {
  const b = birdCreate.parse(req.body);
  const { data, error } = await req.db.from('birds')
    .insert({ ...b, status: 'Draft', created_by: req.user.id, updated_by: req.user.id }).select().single();
  if (error) throw error;
  await audit(req, 'bird.create', 'bird', data.id, { listing_name: data.listing_name });
  res.status(201).json({ bird: data });
}));

// A license can only be marked verified when the credit details are complete
function checkImageRules(b) {
  if (!b.image_license_verified) return;
  const publicDomain = /public domain|cc0/i.test(b.image_license || '');
  const ok = b.image_url && b.image_source_page && b.image_attribution_text && b.image_license
    && b.image_license_url && (publicDomain || b.image_photographer);
  if (!ok) {
    throw new HttpError(400, 'To verify an image license, fill in the image URL, source page, attribution text, photographer, license name and license URL first.');
  }
}

async function checkVerificationRules(birdId, cur, next, db) {
  if (next.identity_verified && !cur.identity_verified) {
    const { count } = await db.from('bird_documents').select('id', { count: 'exact', head: true })
      .eq('bird_id', birdId).eq('doc_type', 'species_identification').eq('verification_status', 'Verified');
    if (!count) throw new HttpError(400, 'Identity can only be verified after a species-identification document is marked Verified.');
  }
  if (next.documentation_status === 'Verified' && cur.documentation_status !== 'Verified') {
    const { data } = await db.from('bird_documents').select('verification_status').eq('bird_id', birdId);
    const docs = data || [];
    const clean = docs.some((d) => d.verification_status === 'Verified')
      && docs.every((d) => d.verification_status === 'Verified');
    if (!clean) throw new HttpError(400, 'Documentation can only be Verified when the bird has at least one document and every document is Verified (none Pending, Rejected or Expired).');
  }
}

router.patch('/birds/:id', need(...INV), ah(async (req, res) => {
  const id = idParam(req);
  const patch = birdPatch.parse(req.body);
  if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to update.');
  const { data: cur, error: e1 } = await req.db.from('birds').select('*').eq('id', id).maybeSingle();
  if (e1) throw e1;
  if (!cur) throw new HttpError(404, 'Bird not found.');
  const next = { ...cur, ...patch };
  checkImageRules(next);
  await checkVerificationRules(id, cur, next, req.db);
  const { data, error } = await req.db.from('birds')
    .update({ ...patch, updated_by: req.user.id }).eq('id', id).select().single();
  if (error) throw error;
  await audit(req, 'bird.update', 'bird', id, { fields: Object.keys(patch), from_status: cur.status, to_status: data.status });
  res.json({ bird: data });
}));
// (There is deliberately no delete route: set status to Archived instead.)

// ======================================================================= WILDLIFE DOCUMENTATION
const DOC_TYPES = ['species_identification', 'source_provenance', 'captive_bred', 'ownership',
  'denr_permit', 'commercial_authorization', 'transport_permit', 'other'];
const docShape = z.object({
  doc_type: z.enum(DOC_TYPES),
  title: z.string().trim().min(1).max(200),
  file_path: z.string().trim().max(300).nullable().optional(),
  issuing_authority: s(200),
  reference_number: s(100),
  issued_on: isoDate,
  expires_on: isoDate,
  verification_notes: s(3000),
});
const docCreate = docShape.strict();
const docPatch = docShape.extend({ verification_status: z.enum(['Pending', 'Verified', 'Rejected', 'Expired']) }).partial().strict();

function checkDocPath(path, birdId) {
  if (path && (!path.startsWith(`${birdId}/`) || path.includes('..'))) throw new HttpError(400, 'Invalid file path.');
}

router.get('/birds/:id/documents', need(...INV, 'read_only_analyst'), ah(async (req, res) => {
  const id = idParam(req);
  const { data, error } = await req.db.from('bird_documents').select('*').eq('bird_id', id).order('created_at');
  if (error) throw error;
  const today = new Date().toISOString().slice(0, 10);
  res.json({ documents: data.map((d) => ({ ...d, is_expired: !!d.expires_on && d.expires_on < today })) });
}));

router.post('/birds/:id/documents', need(...INV), ah(async (req, res) => {
  const id = idParam(req);
  const d = docCreate.parse(req.body);
  checkDocPath(d.file_path, id);
  const { data, error } = await req.db.from('bird_documents')
    .insert({ ...d, bird_id: id, created_by: req.user.id }).select().single();
  if (error) throw error;
  await audit(req, 'document.create', 'bird_document', data.id, { bird_id: id, doc_type: d.doc_type });
  res.status(201).json({ document: data });
}));

router.patch('/documents/:id', need(...INV), ah(async (req, res) => {
  const id = idParam(req);
  const patch = docPatch.parse(req.body);
  if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to update.');
  const { data: cur, error: e1 } = await req.db.from('bird_documents').select('id,bird_id').eq('id', id).maybeSingle();
  if (e1) throw e1;
  if (!cur) throw new HttpError(404, 'Document not found.');
  checkDocPath(patch.file_path, cur.bird_id);
  const update = { ...patch };
  if (patch.verification_status) { update.reviewed_by = req.user.id; update.reviewed_at = new Date().toISOString(); }
  const { data, error } = await req.db.from('bird_documents').update(update).eq('id', id).select().single();
  if (error) throw error;

  // A document that is no longer Verified pulls its bird back out of public view
  if (patch.verification_status && patch.verification_status !== 'Verified') {
    const { data: bird } = await req.db.from('birds').select('status,documentation_status').eq('id', cur.bird_id).single();
    if (bird && bird.documentation_status === 'Verified') {
      const downgrade = { documentation_status: 'In Review', updated_by: req.user.id };
      if (['Available', 'Reserved'].includes(bird.status)) downgrade.status = 'Pending Verification';
      await req.db.from('birds').update(downgrade).eq('id', cur.bird_id);
      await audit(req, 'bird.auto_unpublish', 'bird', cur.bird_id, { reason: 'document ' + patch.verification_status });
    }
  }
  await audit(req, 'document.update', 'bird_document', id, { fields: Object.keys(patch), verification_status: patch.verification_status });
  res.json({ document: data });
}));

router.get('/documents/:id/url', need(...INV), ah(async (req, res) => {
  const id = idParam(req);
  const { data: doc, error } = await req.db.from('bird_documents').select('file_path').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!doc || !doc.file_path) throw new HttpError(404, 'No file attached.');
  const { data, error: e2 } = await req.db.storage.from('wildlife-documents').createSignedUrl(doc.file_path, 120);
  if (e2 || !data) throw new HttpError(404, 'File not found.');
  await audit(req, 'document.view', 'bird_document', id, null);
  res.json({ url: data.signedUrl, expires_in: 120 });
}));

// ======================================================================= BUYERS
router.get('/buyers', need('super_admin', 'customer_support', 'application_reviewer'), ah(async (req, res) => {
  const { data, error } = await req.db.from('buyer_profiles')
    .select('id,full_name,email,contact_number,preferred_language,created_at').order('created_at', { ascending: false }).limit(500);
  if (error) throw error;
  res.json({ buyers: data });
}));

// ======================================================================= APPLICATIONS
router.get('/applications', need(...CHAT), ah(async (req, res) => {
  const status = z.enum(APP_STATUS).optional().parse(req.query.status);
  let q = req.db.from('applications').select('*').order('created_at', { ascending: false }).limit(500);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw error;
  const names = await birdNames(data.map((a) => a.bird_id));
  const { data: convs } = await req.db.from('conversations').select('id,application_id')
    .in('application_id', data.map((a) => a.id).concat(['00000000-0000-0000-0000-000000000000']));
  const convBy = Object.fromEntries((convs || []).map((c) => [c.application_id, c.id]));
  res.json({ applications: data.map((a) => ({ ...a, listing_name: names[a.bird_id] || null, conversation_id: convBy[a.id] || null })) });
}));

const appPatch = z.object({
  status: z.enum(APP_STATUS).optional(),
  assigned_to: uuid.nullable().optional(),
}).strict();

router.patch('/applications/:id', need(...REV), ah(async (req, res) => {
  const id = idParam(req);
  const patch = appPatch.parse(req.body);
  if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to update.');
  const { data: cur, error: e1 } = await req.db.from('applications')
    .select('id,status,buyer_id,bird_id').eq('id', id).maybeSingle();
  if (e1) throw e1;
  if (!cur) throw new HttpError(404, 'Application not found.');
  const { data, error } = await req.db.from('applications').update(patch).eq('id', id).select().single();
  if (error) throw error;
  await audit(req, 'application.update', 'application', id, { from: cur.status, to: data.status, assigned_to: patch.assigned_to });

  if (patch.status && patch.status !== cur.status) {
    const names = await birdNames([cur.bird_id]);
    const bird = names[cur.bird_id] || 'your chosen bird';
    notifyBuyer(cur.buyer_id, 'application_status', {
      en: { title: 'Application update', body: `Your application for ${bird} is now: ${patch.status}.` },
      fil: { title: 'Update sa aplikasyon', body: `Ang aplikasyon mo para sa ${bird} ay ngayon: ${patch.status}.` },
    }, '/applications');
  }
  res.json({ application: data });
}));

// Internal notes — buyers can never read these (database rules + this route is staff-only)
router.get('/applications/:id/notes', need(...CHAT), ah(async (req, res) => {
  const id = idParam(req);
  const { data, error } = await req.db.from('application_notes').select('*').eq('application_id', id).order('created_at');
  if (error) throw error;
  const { data: authors } = await service.from('admin_profiles').select('id,full_name')
    .in('id', data.map((n) => n.author_id).concat(['00000000-0000-0000-0000-000000000000']));
  const by = Object.fromEntries((authors || []).map((a) => [a.id, a.full_name]));
  res.json({ notes: data.map((n) => ({ ...n, author_name: by[n.author_id] || null })) });
}));

router.post('/applications/:id/notes', need(...CHAT), ah(async (req, res) => {
  const id = idParam(req);
  const { note } = z.object({ note: z.string().trim().min(1).max(4000) }).strict().parse(req.body);
  const { data, error } = await req.db.from('application_notes')
    .insert({ application_id: id, author_id: req.user.id, note }).select().single();
  if (error) throw error;
  await audit(req, 'application.note', 'application', id, null);
  res.status(201).json({ note: data });
}));

// ======================================================================= LIVE CHAT (admin inbox)
router.get('/conversations', need(...CHAT), ah(async (req, res) => {
  const status = z.enum(['Open', 'Closed']).optional().parse(req.query.status);
  let q = req.db.from('conversations')
    .select('id,application_id,buyer_id,assigned_to,status,last_message_at,created_at')
    .order('last_message_at', { ascending: false, nullsFirst: false }).limit(200);
  if (status) q = q.eq('status', status);
  const { data: convs, error } = await q;
  if (error) throw error;
  const ids = convs.map((c) => c.id);
  const unreadBy = {};
  let apps = [];
  if (ids.length) {
    const { data: unread } = await service.from('messages').select('conversation_id')
      .in('conversation_id', ids).eq('sender_type', 'buyer').is('read_at', null).limit(5000);
    (unread || []).forEach((m) => { unreadBy[m.conversation_id] = (unreadBy[m.conversation_id] || 0) + 1; });
    const r = await service.from('applications').select('id,status,bird_id').in('id', convs.map((c) => c.application_id));
    apps = r.data || [];
  }
  const appBy = Object.fromEntries(apps.map((a) => [a.id, a]));
  const [buyers, birds] = await Promise.all([buyerNames(convs.map((c) => c.buyer_id)), birdNames(apps.map((a) => a.bird_id))]);
  res.json({
    conversations: convs.map((c) => ({
      ...c,
      unread_count: unreadBy[c.id] || 0,
      buyer_name: buyers[c.buyer_id] || null,
      application_status: appBy[c.application_id] ? appBy[c.application_id].status : null,
      listing_name: appBy[c.application_id] ? birds[appBy[c.application_id].bird_id] || null : null,
    })),
  });
}));

const convPatch = z.object({
  status: z.enum(['Open', 'Closed']).optional(),
  assigned_to: uuid.nullable().optional(),
}).strict();

router.patch('/conversations/:id', need(...CHAT), ah(async (req, res) => {
  const id = idParam(req);
  const patch = convPatch.parse(req.body);
  if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to update.');
  if (patch.assigned_to) {
    const { data: a } = await service.from('admin_profiles').select('id')
      .eq('id', patch.assigned_to).eq('is_active', true).in('role', CHAT).maybeSingle();
    if (!a) throw new HttpError(400, 'That person cannot be assigned to chats.');
  }
  const { data, error } = await req.db.from('conversations').update(patch).eq('id', id).select().single();
  if (error) throw error;
  await audit(req, 'conversation.update', 'conversation', id, patch);
  res.json({ conversation: data });
}));

// ======================================================================= ORDERS
router.get('/orders', need(...ORD, 'inventory_manager'), ah(async (req, res) => {
  const { data, error } = await req.db.from('orders').select('*').order('created_at', { ascending: false }).limit(500);
  if (error) throw error;
  const [birds, buyers] = await Promise.all([birdNames(data.map((o) => o.bird_id)), buyerNames(data.map((o) => o.buyer_id))]);
  res.json({ orders: data.map((o) => ({ ...o, listing_name: birds[o.bird_id] || null, buyer_name: buyers[o.buyer_id] || null })) });
}));

// Only from an application already marked "Suitable". Price and buyer come from the database, not the request.
router.post('/orders', need(...ORD), ah(async (req, res) => {
  const { application_id } = z.object({ application_id: uuid }).strict().parse(req.body);
  const { data, error } = await req.db.from('orders')
    .insert({ application_id, created_by: req.user.id }).select().single();
  if (error) throw error;
  await audit(req, 'order.create', 'order', data.id, { application_id });
  notifyBuyer(data.buyer_id, 'order_created', {
    en: { title: 'Your order was created', body: `Order ${data.order_number} has been created. Our team will coordinate payment and delivery with you in chat.` },
    fil: { title: 'Nagawa na ang iyong order', body: `Nagawa na ang order ${data.order_number}. Makikipag-ugnayan ang aming team tungkol sa bayad at delivery sa chat.` },
  }, '/orders');
  res.status(201).json({ order: data });
}));

router.patch('/orders/:id', need(...ORD), ah(async (req, res) => {
  const id = idParam(req);
  const { order_status } = z.object({ order_status: z.enum(['Pending', 'Confirmed', 'Completed', 'Cancelled']) }).strict().parse(req.body);
  const { data, error } = await req.db.from('orders').update({ order_status }).eq('id', id).select().single();
  if (error) throw error; // the database blocks "Completed" unless payment is Confirmed
  await audit(req, 'order.status', 'order', id, { order_status });
  notifyBuyer(data.buyer_id, 'order_status', {
    en: { title: 'Order update', body: `Order ${data.order_number} is now: ${order_status}.` },
    fil: { title: 'Update sa order', body: `Ang order ${data.order_number} ay ngayon: ${order_status}.` },
  }, '/orders');
  res.json({ order: data });
}));

// ======================================================================= PAYMENTS (manual coordination)
router.get('/payments', need(...ORD), ah(async (req, res) => {
  const { data, error } = await req.db.from('payments').select('*').order('created_at', { ascending: false }).limit(500);
  if (error) throw error;
  res.json({ payments: data });
}));

// Starts payment coordination. Amount always = the order's price.
router.post('/payments', need(...ORD), ah(async (req, res) => {
  const b = z.object({ order_id: uuid, method: z.string().trim().max(50).optional() }).strict().parse(req.body);
  const { data: order, error: e1 } = await req.db.from('orders')
    .select('id,order_number,buyer_id,price_php,order_status,payment_status').eq('id', b.order_id).maybeSingle();
  if (e1) throw e1;
  if (!order) throw new HttpError(404, 'Order not found.');
  if (order.order_status === 'Cancelled') throw new HttpError(409, 'This order is cancelled.');
  if (!['Not Yet Coordinated', 'Rejected'].includes(order.payment_status)) {
    throw new HttpError(409, 'Payment is already being handled for this order.');
  }
  const { data, error } = await req.db.from('payments')
    .insert({ order_id: order.id, amount_php: order.price_php, method: b.method || null, status: 'Awaiting Payment' }).select().single();
  if (error) throw error;
  await audit(req, 'payment.request', 'payment', data.id, { order_id: order.id });
  notifyBuyer(order.buyer_id, 'payment_requested', {
    en: { title: 'Payment coordination', body: `Payment for order ${order.order_number} is now open. Please check your messages for instructions.` },
    fil: { title: 'Koordinasyon sa bayad', body: `Bukas na ang bayad para sa order ${order.order_number}. Tingnan ang iyong mga mensahe para sa mga tagubilin.` },
  }, '/orders');
  res.status(201).json({ payment: data });
}));

const PAY_FLOW = {
  'Not Yet Coordinated': ['Awaiting Payment'],
  'Awaiting Payment': ['Confirmed', 'Rejected'],
  'Submitted for Verification': ['Confirmed', 'Rejected'],
  'Rejected': ['Awaiting Payment'],
  'Confirmed': ['Refunded'],
  'Refunded': [],
};

// Only a Super Admin can confirm / reject / refund (also enforced by the database)
router.patch('/payments/:id', need('super_admin'), ah(async (req, res) => {
  const id = idParam(req);
  const b = z.object({
    status: z.enum(Object.keys(PAY_FLOW)).optional(),
    internal_notes: z.string().trim().max(3000).optional(),
  }).strict().parse(req.body);
  if (!Object.keys(b).length) throw new HttpError(400, 'Nothing to update.');
  const { data: cur, error: e1 } = await req.db.from('payments').select('id,status,order_id').eq('id', id).maybeSingle();
  if (e1) throw e1;
  if (!cur) throw new HttpError(404, 'Payment not found.');
  const update = { ...b };
  if (b.status && b.status !== cur.status) {
    if (!PAY_FLOW[cur.status].includes(b.status)) throw new HttpError(400, `A payment cannot go from "${cur.status}" to "${b.status}".`);
    if (['Confirmed', 'Rejected', 'Refunded'].includes(b.status)) {
      update.verified_by = req.user.id;
      update.verified_at = new Date().toISOString();
    }
  }
  const { data, error } = await req.db.from('payments').update(update).eq('id', id).select().single();
  if (error) throw error;
  await audit(req, 'payment.update', 'payment', id, { from: cur.status, to: data.status });

  if (b.status && b.status !== cur.status && ['Confirmed', 'Rejected'].includes(b.status)) {
    const { data: o } = await service.from('orders').select('buyer_id,order_number').eq('id', cur.order_id).single();
    if (o) notifyBuyer(o.buyer_id, 'payment_status', {
      en: { title: 'Payment update', body: `Payment for order ${o.order_number} was ${b.status.toLowerCase()}.` },
      fil: { title: 'Update sa bayad', body: `Ang bayad para sa order ${o.order_number} ay ${b.status === 'Confirmed' ? 'nakumpirma' : 'tinanggihan'}.` },
    }, '/orders');
  }
  res.json({ payment: data });
}));

router.get('/payments/:id/proof-url', need(...ORD), ah(async (req, res) => {
  const id = idParam(req);
  const { data: p, error } = await req.db.from('payments').select('proof_path').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!p || !p.proof_path) throw new HttpError(404, 'No proof uploaded.');
  const { data, error: e2 } = await req.db.storage.from('payment-proofs').createSignedUrl(p.proof_path, 120);
  if (e2 || !data) throw new HttpError(404, 'File not found.');
  await audit(req, 'payment.view_proof', 'payment', id, null);
  res.json({ url: data.signedUrl, expires_in: 120 });
}));

// ======================================================================= DELIVERY (no automatic courier booking)
router.get('/deliveries', need(...ORD), ah(async (req, res) => {
  const { data, error } = await req.db.from('deliveries').select('*').order('updated_at', { ascending: false }).limit(500);
  if (error) throw error;
  await audit(req, 'delivery.list_view', 'delivery', null, { rows: data.length }); // exact addresses were viewed
  res.json({ deliveries: data });
}));

const deliveryPatch = z.object({
  status: z.enum(DELIVERY_STATUS).optional(),
  transport_provider: s(200),
  transport_authorization_verified: z.boolean().optional(),
  tracking_notes: s(2000), // visible to the buyer as tracking updates — keep it free of private details
}).strict();

router.patch('/deliveries/:id', need(...ORD), ah(async (req, res) => {
  const id = idParam(req);
  const patch = deliveryPatch.parse(req.body);
  if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to update.');
  const { data: cur, error: e1 } = await req.db.from('deliveries').select('*').eq('id', id).maybeSingle();
  if (e1) throw e1;
  if (!cur) throw new HttpError(404, 'Delivery not found.');
  const next = { ...cur, ...patch };

  if (['Ready for Dispatch', 'In Transit', 'Delivered'].includes(next.status)) {
    const { data: order } = await service.from('orders').select('payment_status,order_status').eq('id', cur.order_id).single();
    if (!next.transport_authorization_verified || !next.transport_provider) {
      throw new HttpError(400, 'Before dispatch, record the specialist transport provider and confirm that transport authorization and welfare arrangements were verified.');
    }
    if (!order || order.payment_status !== 'Confirmed') throw new HttpError(400, 'Payment must be Confirmed before dispatch.');
    if (order.order_status === 'Cancelled') throw new HttpError(400, 'This order is cancelled.');
  }
  const { data, error } = await req.db.from('deliveries').update(patch).eq('id', id).select().single();
  if (error) throw error;
  await audit(req, 'delivery.update', 'delivery', id, { from: cur.status, to: data.status });

  if (patch.status && patch.status !== cur.status) {
    const { data: o } = await service.from('orders').select('buyer_id,order_number').eq('id', cur.order_id).single();
    if (o) notifyBuyer(o.buyer_id, 'delivery_status', {
      en: { title: 'Delivery update', body: `Delivery for order ${o.order_number} is now: ${patch.status}.` },
      fil: { title: 'Update sa delivery', body: `Ang delivery para sa order ${o.order_number} ay ngayon: ${patch.status}.` },
    }, '/orders');
  }
  res.json({ delivery: data });
}));

module.exports = router;
