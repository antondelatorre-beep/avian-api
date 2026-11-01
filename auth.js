// api/middleware/auth.js
const { service, asUser } = require('./supabase');

// Checks the login token. On success adds:
//   req.user  = the Supabase user
//   req.db    = a database client that acts AS that user (Row Level Security applies)
//   req.admin = their admin profile (or null if they are a buyer)
async function requireUser(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Please log in.' });

    const { data, error } = await service.auth.getUser(token);
    if (error || !data || !data.user) return res.status(401).json({ error: 'Your session has expired. Please log in again.' });

    req.user = data.user;
    req.token = token;
    req.db = asUser(token);

    const { data: adm } = await service
      .from('admin_profiles').select('id,full_name,role,is_active').eq('id', data.user.id).maybeSingle();
    req.admin = adm && adm.is_active ? adm : null;
    next();
  } catch (e) {
    next(e);
  }
}

// requireAdmin()                    -> any active admin
// requireAdmin('super_admin', ...)  -> only those roles
const requireAdmin = (...roles) => (req, res, next) => {
  if (!req.admin) return res.status(403).json({ error: 'Management access required.' });
  if (roles.length && !roles.includes(req.admin.role)) {
    return res.status(403).json({ error: 'Your role does not have permission for this.' });
  }
  next();
};

module.exports = { requireUser, requireAdmin };
