// api/lib/notify.js — website notifications + Resend emails.
// Nothing here may ever break the main action, so every function swallows its own errors.
const { service } = require('./supabase');

async function sendEmail(to, subject, text) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.FROM_EMAIL;
  if (!key || !from || !to) return; // email not set up yet: skip quietly
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text }), // plain text only: no HTML injection
    });
    if (!r.ok) console.error('Resend error', r.status);
  } catch (e) {
    console.error('Email failed:', e.message);
  }
}

// msg = { en: {title, body}, fil: {title, body} } — sent in the buyer's chosen language
async function notifyBuyer(userId, type, msg, link, opts = {}) {
  try {
    const { data: p } = await service
      .from('buyer_profiles').select('email,preferred_language').eq('id', userId).maybeSingle();
    const m = msg[p && p.preferred_language === 'fil' ? 'fil' : 'en'];
    await service.from('notifications').insert({ user_id: userId, type, title: m.title, body: m.body, link: link || null });
    if (opts.email !== false && p && p.email) {
      const site = process.env.CUSTOMER_SITE_URL || '';
      await sendEmail(p.email, `${m.title} — Avian Market PH`,
        `${m.body}\n\n${site}${link || ''}\n\nAvian Market PH · Ibonyarri Co.`);
    }
  } catch (e) {
    console.error('notifyBuyer failed:', e.message);
  }
}

async function notifyAdminUser(userId, type, title, body, link) {
  try {
    await service.from('notifications').insert({ user_id: userId, type, title, body, link: link || null });
  } catch (e) {
    console.error('notifyAdminUser failed:', e.message);
  }
}

async function notifyAdmins(roles, type, title, body, link, opts = {}) {
  try {
    const { data } = await service
      .from('admin_profiles').select('id').eq('is_active', true).in('role', roles);
    if (data && data.length) {
      await service.from('notifications').insert(
        data.map((a) => ({ user_id: a.id, type, title, body, link: link || null })));
    }
    if (opts.email !== false && process.env.ADMIN_NOTIFY_EMAIL) {
      await sendEmail(process.env.ADMIN_NOTIFY_EMAIL, `${title} — Avian Market PH admin`, body);
    }
  } catch (e) {
    console.error('notifyAdmins failed:', e.message);
  }
}

module.exports = { sendEmail, notifyBuyer, notifyAdmins, notifyAdminUser };
