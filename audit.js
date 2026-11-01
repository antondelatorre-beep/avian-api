// api/lib/audit.js — writes to audit_logs (only the API can write there)
const { service } = require('./supabase');

async function audit(req, action, entityType, entityId, details) {
  try {
    const { error } = await service.from('audit_logs').insert({
      actor_id: req.user ? req.user.id : null,
      action,
      entity_type: entityType || null,
      entity_id: entityId ? String(entityId) : null,
      details: details || null,
      ip_address: req.ip || null,
    });
    if (error) console.error('Audit log failed:', error.message);
  } catch (e) {
    console.error('Audit log failed:', e.message);
  }
}

module.exports = { audit };
