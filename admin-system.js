// api/routes/admin-system.js — admin users, audit logs, settings, analytics, CSV exports
const router = require('express').Router();
const { z } = require('zod');
const { service, fetchAll } = require('./supabase');
const { requireUser, requireAdmin: need } = require('./auth');
const { ah, HttpError, idParam, birdNames } = require('./util');
const { audit } = require('./audit');

router.use(requireUser);

const ROLES = ['super_admin', 'inventory_manager', 'application_reviewer', 'customer_support', 'read_only_analyst'];

// ======================================================================= ADMIN USERS (Super Admin only)
router.get('/users', need('super_admin'), ah(async (req, res) => {
  const { data, error } = await service.from('admin_profiles').select('id,full_name,email,role,is_active,created_at').order('created_at');
  if (error) throw error;
  res.json({ users: data });
}));

async function otherActiveSupers(excludeId) {
  const { count } = await service.from('admin_profiles').select('id', { count: 'exact', head: true })
    .eq('role', 'super_admin').eq('is_active', true).neq('id', excludeId);
  return count || 0;
}

router.post('/users', need('super_admin'), ah(async (req, res) => {
  const b = z.object({
    email: z.string().trim().toLowerCase().email().max(200),
    full_name: z.string().trim().min(2).max(100),
    role: z.enum(ROLES),
    password: z.string().min(12, 'Use at least 12 characters').max(72),
  }).strict().parse(req.body);

  const { data: created, error } = await service.auth.admin.createUser({
    email: b.email, password: b.password, email_confirm: true, user_metadata: { full_name: b.full_name },
  });
  if (error) throw new HttpError(400, error.message);

  const { error: e2 } = await service.from('admin_profiles')
    .insert({ id: created.user.id, full_name: b.full_name, email: b.email, role: b.role });
  if (e2) {
    await service.auth.admin.deleteUser(created.user.id); // roll back
    throw e2;
  }
  await audit(req, 'admin.create', 'admin_user', created.user.id, { email: b.email, role: b.role });
  res.status(201).json({ user: { id: created.user.id, email: b.email, full_name: b.full_name, role: b.role } });
}));

router.patch('/users/:id', need('super_admin'), ah(async (req, res) => {
  const id = idParam(req);
  const b = z.object({
    role: z.enum(ROLES).optional(),
    is_active: z.boolean().optional(),
    full_name: z.string().trim().min(2).max(100).optional(),
  }).strict().parse(req.body);
  if (!Object.keys(b).length) throw new HttpError(400, 'Nothing to update.');

  const { data: cur } = await service.from('admin_profiles').select('id,role,is_active').eq('id', id).maybeSingle();
  if (!cur) throw new HttpError(404, 'Admin not found.');

  const losesPower = (b.role && b.role !== cur.role) || b.is_active === false;
  if (id === req.user.id && losesPower) throw new HttpError(400, 'You cannot change your own role or deactivate yourself.');
  if (cur.role === 'super_admin' && cur.is_active && losesPower && (await otherActiveSupers(id)) === 0) {
    throw new HttpError(400, 'There must always be at least one active Super Admin.');
  }
  const { data, error } = await service.from('admin_profiles').update(b).eq('id', id)
    .select('id,full_name,email,role,is_active').single();
  if (error) throw error;
  await audit(req, 'admin.update', 'admin_user', id, b);
  res.json({ user: data });
}));

// ======================================================================= AUDIT LOGS & SETTINGS
router.get('/audit-logs', need('super_admin'), ah(async (req, res) => {
  const q = z.object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(req.query);
  let query = service.from('audit_logs').select('*').order('id', { ascending: false }).limit(q.limit);
  if (q.before) query = query.lt('id', q.before);
  const { data, error } = await query;
  if (error) throw error;
  res.json({ logs: data });
}));

router.get('/settings', need(), ah(async (req, res) => {
  const { data, error } = await req.db.from('settings').select('*');
  if (error) throw error;
  res.json({ settings: data });
}));

router.put('/settings/:key', need('super_admin'), ah(async (req, res) => {
  const key = z.string().regex(/^[a-z0-9_.-]{1,60}$/).parse(req.params.key);
  const { value } = z.object({ value: z.any() }).strict().parse(req.body);
  if (value === undefined || JSON.stringify(value).length > 5000) throw new HttpError(400, 'Setting value is missing or too large.');
  const { error } = await req.db.from('settings').upsert({ key, value, updated_by: req.user.id, updated_at: new Date().toISOString() });
  if (error) throw error;
  await audit(req, 'settings.update', 'setting', key, null);
  res.json({ ok: true });
}));

// ======================================================================= ANALYTICS
const TZ = 'Asia/Manila';
const dayKey = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ });
const monthKey = (d) => dayKey(d).slice(0, 7);
const yearKey = (d) => dayKey(d).slice(0, 4);
function weekKey(d) { // Monday of that week
  const [y, m, dd] = dayKey(d).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, dd));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}
const countBy = (rows, fn) => rows.reduce((a, r) => { const k = fn(r); a[k] = (a[k] || 0) + 1; return a; }, {});
const sumBy = (rows, fn, val) => rows.reduce((a, r) => { const k = fn(r); a[k] = (a[k] || 0) + Number(val(r)); return a; }, {});
const lastN = (obj, n) => Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : 1)).slice(-n).map(([period, value]) => ({ period, value }));

async function buildAnalytics() {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const [birds, apps, buyers, convs, orders, docs, msgs, unreadRes] = await Promise.all([
    fetchAll('birds', 'id,listing_name,species_common,status,identity_verified,documentation_status'),
    fetchAll('applications', 'id,status,bird_id'),
    fetchAll('buyer_profiles', 'id,created_at'),
    fetchAll('conversations', 'id,status'),
    fetchAll('orders', 'id,bird_id,order_status,payment_status,price_php,completed_at'),
    fetchAll('bird_documents', 'id,verification_status'),
    fetchAll('messages', 'id,created_at', (q) => q.gte('created_at', since)),
    service.from('messages').select('id', { count: 'exact', head: true }).eq('sender_type', 'buyer').is('read_at', null),
  ]);
  const names = await birdNames(orders.map((o) => o.bird_id).concat(apps.map((a) => a.bird_id)));

  // Revenue = Completed order + Confirmed payment. Nothing else counts.
  const paid = orders.filter((o) => o.order_status === 'Completed' && o.payment_status === 'Confirmed' && o.completed_at);
  const revenue = paid.reduce((t, o) => t + Number(o.price_php), 0);
  const bySpecies = countBy(birds.filter((b) => b.status !== 'Archived'), (b) => b.species_common || b.listing_name);
  const requested = Object.entries(countBy(apps, (a) => names[a.bird_id] || 'Unknown'))
    .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([bird, requests]) => ({ bird, requests }));
  const revenueByBird = Object.entries(sumBy(paid, (o) => names[o.bird_id] || 'Unknown', (o) => o.price_php))
    .sort((a, b) => b[1] - a[1]).map(([bird, revenue_php]) => ({ bird, revenue_php }));

  return {
    generated_at: new Date().toISOString(),
    inventory: {
      total_birds: birds.length,
      verified_identities: birds.filter((b) => b.identity_verified).length,
      draft: birds.filter((b) => b.status === 'Draft').length,
      published: birds.filter((b) => ['Available', 'Reserved'].includes(b.status)).length,
      available: birds.filter((b) => b.status === 'Available').length,
      reserved: birds.filter((b) => b.status === 'Reserved').length,
      archived: birds.filter((b) => b.status === 'Archived').length,
      pending_documentation: birds.filter((b) => b.status !== 'Archived' && b.documentation_status !== 'Verified').length,
      by_status: countBy(birds, (b) => b.status),
      by_species: bySpecies,
    },
    applications: {
      pending: apps.filter((a) => a.status === 'Not Reviewed').length,
      approved: apps.filter((a) => a.status === 'Suitable').length,
      declined: apps.filter((a) => a.status === 'Not Suitable').length,
      by_status: countBy(apps, (a) => a.status),
      most_requested_birds: requested,
    },
    buyers: {
      registered: buyers.length,
      registrations_by_month: lastN(countBy(buyers, (b) => monthKey(b.created_at)), 12),
    },
    conversations: {
      active: convs.filter((c) => c.status === 'Open').length,
      unread_messages: unreadRes.count || 0,
      messages_per_day_last_30: lastN(countBy(msgs, (m) => dayKey(m.created_at)), 31),
    },
    orders: {
      total: orders.length,
      completed: orders.filter((o) => o.order_status === 'Completed').length,
      pending_payments: orders.filter((o) => ['Awaiting Payment', 'Submitted for Verification'].includes(o.payment_status)).length,
      by_status: countBy(orders, (o) => o.order_status),
    },
    revenue: {
      confirmed_revenue_php: revenue,
      completed_paid_orders: paid.length,
      daily: lastN(sumBy(paid, (o) => dayKey(o.completed_at), (o) => o.price_php), 31),
      weekly: lastN(sumBy(paid, (o) => weekKey(o.completed_at), (o) => o.price_php), 12),
      monthly: lastN(sumBy(paid, (o) => monthKey(o.completed_at), (o) => o.price_php), 12),
      yearly: lastN(sumBy(paid, (o) => yearKey(o.completed_at), (o) => o.price_php), 10),
      by_bird: revenueByBird,
    },
    documentation: { by_status: countBy(docs, (d) => d.verification_status) },
  };
}

router.get('/analytics', need('super_admin', 'read_only_analyst'), ah(async (req, res) => {
  res.json(await buildAnalytics());
}));

// ======================================================================= CSV EXPORTS
function csvCell(v) {
  if (v === null || v === undefined) return '';
  let t = String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // stops spreadsheet formula injection
  return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}
const toCsv = (cols, rows) => '\ufeff' + [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');

const EXPORTS = {
  inventory: { roles: ['super_admin', 'inventory_manager', 'read_only_analyst'],
    cols: ['listing_name', 'species_common', 'scientific_name', 'price_php', 'status', 'identity_verified', 'documentation_status', 'image_license_verified', 'created_at'],
    load: () => fetchAll('birds', '*') },
  buyers: { roles: ['super_admin', 'customer_support'],
    cols: ['full_name', 'email', 'contact_number', 'preferred_language', 'created_at'],
    load: () => fetchAll('buyer_profiles', '*') },
  applications: { roles: ['super_admin', 'application_reviewer'],
    cols: ['buyer_name', 'email', 'contact_number', 'listing_name', 'status', 'created_at'],
    load: async () => { const a = await fetchAll('applications', '*'); const n = await birdNames(a.map((x) => x.bird_id)); return a.map((x) => ({ ...x, listing_name: n[x.bird_id] })); } },
  orders: { roles: ['super_admin', 'customer_support', 'read_only_analyst'],
    cols: ['order_number', 'listing_name', 'price_php', 'order_status', 'payment_status', 'created_at', 'completed_at'],
    load: async () => { const o = await fetchAll('orders', '*'); const n = await birdNames(o.map((x) => x.bird_id)); return o.map((x) => ({ ...x, listing_name: n[x.bird_id] })); } },
  payments: { roles: ['super_admin', 'customer_support', 'read_only_analyst'],
    cols: ['order_id', 'amount_php', 'method', 'reference_number', 'status', 'verified_at', 'created_at'],
    load: () => fetchAll('payments', '*') },
  documentation: { roles: ['super_admin', 'inventory_manager'],
    cols: ['listing_name', 'doc_type', 'title', 'reference_number', 'issued_on', 'expires_on', 'verification_status', 'reviewed_at'],
    load: async () => { const d = await fetchAll('bird_documents', '*'); const n = await birdNames(d.map((x) => x.bird_id)); return d.map((x) => ({ ...x, listing_name: n[x.bird_id] })); } },
  'analytics-monthly': { roles: ['super_admin', 'read_only_analyst'],
    cols: ['month', 'completed_paid_orders', 'confirmed_revenue_php'],
    load: async () => {
      const paid = (await fetchAll('orders', 'id,price_php,completed_at,order_status,payment_status'))
        .filter((o) => o.order_status === 'Completed' && o.payment_status === 'Confirmed' && o.completed_at);
      const cnt = countBy(paid, (o) => monthKey(o.completed_at));
      const sum = sumBy(paid, (o) => monthKey(o.completed_at), (o) => o.price_php);
      return Object.keys(cnt).sort().map((m) => ({ month: m, completed_paid_orders: cnt[m], confirmed_revenue_php: sum[m] }));
    } },
};

router.get('/export/:type', need(), ah(async (req, res) => {
  const def = EXPORTS[req.params.type];
  if (!def) throw new HttpError(404, 'Unknown export.');
  if (!def.roles.includes(req.admin.role)) throw new HttpError(403, 'Your role cannot export this data.');
  const rows = await def.load();
  await audit(req, 'export.csv', 'export', req.params.type, { rows: rows.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="avian-${req.params.type}-${dayKey(new Date())}.csv"`);
  res.send(toCsv(def.cols, rows));
}));

module.exports = router;
