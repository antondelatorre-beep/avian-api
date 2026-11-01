// api/routes/account.js — anything for a logged-in person (buyers, and chat for staff too)
const router = require('express').Router();
const { z } = require('zod');
const { service, anon } = require('./supabase');
const { requireUser: auth } = require('./auth');
const { ah, HttpError, idParam, uuid, birdNames } = require('./util');
const { strict } = require('./limits');
const { audit } = require('./audit');
const { notifyBuyer, notifyAdmins, notifyAdminUser } = require('./notify');

const CHAT_ROLES = ['super_admin', 'customer_support', 'application_reviewer'];
const phone = z.string().trim().regex(/^\+?[0-9][0-9 \-]{6,18}$/, 'Enter a valid contact number');

// ---------------------------------------------------------------- profile
router.get('/me', auth, ah(async (req, res) => {
  const { data: profile } = await req.db.from('buyer_profiles')
    .select('id,full_name,email,contact_number,preferred_language').eq('id', req.user.id).maybeSingle();
  res.json({
    user: { id: req.user.id, email: req.user.email },
    profile,
    admin: req.admin ? { role: req.admin.role, full_name: req.admin.full_name } : null,
  });
}));

const profileSchema = z.object({
  full_name: z.string().trim().min(2).max(100).optional(),
  contact_number: phone.optional(),
  preferred_language: z.enum(['en', 'fil']).optional(),
}).strict();

router.patch('/me', auth, ah(async (req, res) => {
  const patch = profileSchema.parse(req.body);
  if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to update.');
  const { data, error } = await req.db.from('buyer_profiles').update(patch)
    .eq('id', req.user.id).select('id,full_name,email,contact_number,preferred_language').single();
  if (error) throw error;
  res.json({ profile: data });
}));

// ---------------------------------------------------------------- applications
const appSchema = z.object({
  bird_id: uuid,
  buyer_name: z.string().trim().min(2).max(100),
  contact_number: phone,
  handling_experience: z.string().trim().min(1).max(2000),
  previous_ownership: z.string().trim().min(1).max(2000),
  current_ownership: z.string().trim().min(1).max(2000),
  care_experience: z.string().trim().max(2000).optional(),
  additional_info: z.string().trim().max(2000).optional(),
}).strict(); // unknown fields (like "status") are rejected

router.post('/applications', auth, strict, ah(async (req, res) => {
  if (req.admin) throw new HttpError(403, 'Management accounts cannot submit buyer applications.');
  const b = appSchema.parse(req.body);

  const { data: bird } = await anon.from('public_birds')
    .select('id,listing_name').eq('id', b.bird_id).eq('status', 'Available').maybeSingle();
  if (!bird) throw new HttpError(404, 'This bird is not currently open for applications.');

  const { data: app, error } = await service.from('applications')
    .insert({ ...b, buyer_id: req.user.id, email: req.user.email }).select('id').single();
  if (error) {
    if (error.code === '23505') throw new HttpError(409, 'You already have an active application for this bird.');
    throw error;
  }
  // The database trigger has already created the private conversation
  const { data: conv } = await service.from('conversations').select('id').eq('application_id', app.id).maybeSingle();

  await audit(req, 'application.submit', 'application', app.id, { bird: bird.listing_name });
  notifyAdmins(['super_admin', 'application_reviewer', 'customer_support'], 'new_application',
    'New application', `${b.buyer_name} applied for ${bird.listing_name}.`, `/applications/${app.id}`);

  res.status(201).json({ application_id: app.id, conversation_id: conv ? conv.id : null });
}));

router.get('/applications', auth, ah(async (req, res) => {
  const { data, error } = await req.db.from('applications')
    .select('id,bird_id,status,handling_experience,previous_ownership,current_ownership,care_experience,additional_info,created_at,updated_at')
    .eq('buyer_id', req.user.id).order('created_at', { ascending: false });
  if (error) throw error;
  const names = await birdNames(data.map((a) => a.bird_id));
  const { data: convs } = await req.db.from('conversations').select('id,application_id,status')
    .eq('buyer_id', req.user.id);
  const convBy = Object.fromEntries((convs || []).map((c) => [c.application_id, c]));
  res.json({
    applications: data.map((a) => ({
      ...a,
      listing_name: names[a.bird_id] || null,
      conversation_id: convBy[a.id] ? convBy[a.id].id : null,
      conversation_status: convBy[a.id] ? convBy[a.id].status : null,
    })),
  });
}));

// ---------------------------------------------------------------- conversations & messages
async function getConversation(req, id) {
  const { data, error } = await req.db.from('conversations')
    .select('id,buyer_id,assigned_to,status,application_id').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'Conversation not found.');
  return data;
}

router.get('/conversations', auth, ah(async (req, res) => {
  const { data, error } = await req.db.from('conversations')
    .select('id,application_id,status,last_message_at,created_at')
    .eq('buyer_id', req.user.id).order('last_message_at', { ascending: false, nullsFirst: false });
  if (error) throw error;
  res.json({ conversations: data });
}));

router.get('/conversations/:id/messages', auth, ah(async (req, res) => {
  const id = idParam(req);
  await getConversation(req, id);
  const before = z.string().datetime().optional().parse(req.query.before);
  let q = req.db.from('messages')
    .select('id,sender_id,sender_type,body,read_at,created_at,message_attachments(id,file_name,mime_type,size_bytes,file_path)')
    .eq('conversation_id', id).order('created_at', { ascending: false }).limit(200);
  if (before) q = q.lt('created_at', before);
  const { data, error } = await q;
  if (error) throw error;
  res.json({ messages: data.reverse() });
}));

const MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const messageSchema = z.object({
  body: z.string().trim().max(4000).optional(),
  attachments: z.array(z.object({
    path: z.string().max(300),
    name: z.string().trim().min(1).max(200),
    mime: z.enum(MIME),
    size: z.number().int().min(1).max(10 * 1024 * 1024),
  }).strict()).max(5).optional(),
}).strict().refine((m) => m.body || (m.attachments && m.attachments.length), 'Write a message or attach a file.');

router.post('/conversations/:id/messages', auth, strict, ah(async (req, res) => {
  const id = idParam(req);
  const input = messageSchema.parse(req.body);
  const conv = await getConversation(req, id);

  const isStaff = !!req.admin;
  if (isStaff && !CHAT_ROLES.includes(req.admin.role)) throw new HttpError(403, 'Your role cannot send chat messages.');
  if (!isStaff && conv.status === 'Closed') throw new HttpError(409, 'This conversation is closed.');
  const senderType = isStaff ? 'admin' : 'buyer';

  for (const a of input.attachments || []) {
    if (!a.path.startsWith(`${id}/`) || a.path.includes('..')) throw new HttpError(400, 'Invalid attachment path.');
  }

  const { data: msg, error } = await req.db.from('messages')
    .insert({ conversation_id: id, sender_id: req.user.id, sender_type: senderType, body: input.body || null })
    .select('id,sender_id,sender_type,body,read_at,created_at').single();
  if (error) throw error;

  let attachments = [];
  if (input.attachments && input.attachments.length) {
    const { data, error: aerr } = await req.db.from('message_attachments')
      .insert(input.attachments.map((a) => ({
        message_id: msg.id, file_path: a.path, file_name: a.name, mime_type: a.mime, size_bytes: a.size,
      }))).select('id,file_name,mime_type,size_bytes,file_path');
    if (aerr) throw aerr;
    attachments = data;
  }

  // Notify the other side — only for the FIRST unread message, to avoid spam
  const { count } = await service.from('messages').select('id', { count: 'exact', head: true })
    .eq('conversation_id', id).eq('sender_type', senderType).is('read_at', null);
  if (count === 1) {
    if (senderType === 'buyer') {
      if (conv.assigned_to) {
        notifyAdminUser(conv.assigned_to, 'new_message', 'New buyer message', 'A buyer sent a new message.', `/chat/${id}`);
      } else {
        notifyAdmins(CHAT_ROLES, 'new_message', 'New buyer message', 'A buyer sent a new message.', `/chat/${id}`);
      }
    } else {
      notifyBuyer(conv.buyer_id, 'new_message', {
        en: { title: 'New message from Avian Market PH', body: 'Our team replied to your application. Log in to read it.' },
        fil: { title: 'Bagong mensahe mula sa Avian Market PH', body: 'Sumagot ang aming team sa iyong aplikasyon. Mag-log in para mabasa.' },
      }, `/messages/${id}`);
    }
  }
  res.status(201).json({ message: { ...msg, message_attachments: attachments } });
}));

router.post('/conversations/:id/read', auth, ah(async (req, res) => {
  const id = idParam(req);
  await getConversation(req, id);
  const { error } = await req.db.rpc('mark_conversation_read', { p_conversation_id: id });
  if (error) throw error;
  res.json({ ok: true });
}));

// Short-lived link to a private attachment (storage rules still apply to the person)
router.get('/attachments/url', auth, ah(async (req, res) => {
  const q = z.object({ conversation_id: uuid, path: z.string().max(300) }).parse(req.query);
  if (!q.path.startsWith(`${q.conversation_id}/`) || q.path.includes('..')) throw new HttpError(400, 'Invalid path.');
  const { data, error } = await req.db.storage.from('chat-attachments').createSignedUrl(q.path, 300);
  if (error || !data) throw new HttpError(404, 'File not found.');
  res.json({ url: data.signedUrl, expires_in: 300 });
}));

// ---------------------------------------------------------------- orders & delivery
router.get('/orders', auth, ah(async (req, res) => {
  const { data: orders, error } = await req.db.from('orders')
    .select('id,order_number,bird_id,price_php,order_status,payment_status,created_at,completed_at')
    .eq('buyer_id', req.user.id).order('created_at', { ascending: false });
  if (error) throw error;
  const names = await birdNames(orders.map((o) => o.bird_id));
  let deliveries = [];
  if (orders.length) {
    const r = await req.db.from('deliveries')
      .select('order_id,recipient_name,contact_number,address,instructions,latitude,longitude,status,tracking_notes,updated_at')
      .in('order_id', orders.map((o) => o.id));
    if (r.error) throw r.error;
    deliveries = r.data;
  }
  const delBy = Object.fromEntries(deliveries.map((d) => [d.order_id, d]));
  res.json({ orders: orders.map((o) => ({ ...o, listing_name: names[o.bird_id] || null, delivery: delBy[o.id] || null })) });
}));

const deliverySchema = z.object({
  recipient_name: z.string().trim().min(2).max(100),
  contact_number: phone,
  address: z.string().trim().min(10).max(500),
  instructions: z.string().trim().max(1000).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
}).strict();

async function ownOrder(req, orderId) {
  const { data, error } = await req.db.from('orders')
    .select('id,order_number,price_php,order_status,payment_status').eq('id', orderId).eq('buyer_id', req.user.id).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'Order not found.');
  return data;
}

router.put('/orders/:id/delivery', auth, strict, ah(async (req, res) => {
  const id = idParam(req);
  const d = deliverySchema.parse(req.body);
  const order = await ownOrder(req, id);
  if (order.order_status === 'Cancelled') throw new HttpError(409, 'This order was cancelled.');

  const { data: existing } = await service.from('deliveries').select('status').eq('order_id', id).maybeSingle();
  if (existing && !['Not Arranged', 'Awaiting Verification'].includes(existing.status)) {
    throw new HttpError(409, 'Delivery is already being arranged. Please message our team to change the details.');
  }
  const { error } = await service.from('deliveries').upsert(
    { order_id: id, ...d, status: 'Awaiting Verification' }, { onConflict: 'order_id' });
  if (error) throw error;

  await audit(req, 'delivery.buyer_update', 'order', id, null); // address itself is not logged
  notifyAdmins(['super_admin', 'customer_support'], 'delivery_details', 'Delivery details received',
    `Delivery details were submitted for order ${order.order_number}.`, `/delivery`);
  res.json({ ok: true });
}));

const proofSchema = z.object({
  proof_path: z.string().max(300),
  method: z.string().trim().max(50).optional(),
  reference_number: z.string().trim().max(100).optional(),
}).strict();

router.post('/orders/:id/payment-proof', auth, strict, ah(async (req, res) => {
  const id = idParam(req);
  const p = proofSchema.parse(req.body);
  const order = await ownOrder(req, id);
  if (!p.proof_path.startsWith(`${id}/`) || p.proof_path.includes('..')) throw new HttpError(400, 'Invalid file path.');
  if (!['Awaiting Payment', 'Rejected'].includes(order.payment_status)) {
    throw new HttpError(409, 'Payment is not open for submission on this order.');
  }
  // The amount is ALWAYS the order price from the database — never anything the buyer sends
  const { error } = await service.from('payments').insert({
    order_id: id, amount_php: order.price_php, method: p.method || null,
    reference_number: p.reference_number || null, proof_path: p.proof_path,
    status: 'Submitted for Verification', submitted_at: new Date().toISOString(),
  });
  if (error) throw error;
  await audit(req, 'payment.proof_submitted', 'order', id, null);
  notifyAdmins(['super_admin', 'customer_support'], 'payment_submitted', 'Payment submitted',
    `Payment proof submitted for order ${order.order_number}.`, '/payments');
  res.status(201).json({ ok: true });
}));

// ---------------------------------------------------------------- notifications
router.get('/notifications', auth, ah(async (req, res) => {
  const { data, error } = await req.db.from('notifications')
    .select('id,type,title,body,link,read_at,created_at')
    .eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  res.json({ notifications: data, unread: data.filter((n) => !n.read_at).length });
}));

router.post('/notifications/read', auth, ah(async (req, res) => {
  const { ids } = z.object({ ids: z.array(uuid).max(100).optional() }).strict().parse(req.body);
  let q = req.db.from('notifications').update({ read_at: new Date().toISOString() })
    .eq('user_id', req.user.id).is('read_at', null);
  if (ids && ids.length) q = q.in('id', ids);
  const { error } = await q;
  if (error) throw error;
  res.json({ ok: true });
}));

module.exports = router;
