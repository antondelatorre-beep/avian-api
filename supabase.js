// api/lib/supabase.js
// Three ways of talking to Supabase:
//   service  = full-power key (bypasses RLS). Used ONLY after the API has checked permissions.
//   anon     = publishable key, no login (sees only what the public may see).
//   asUser() = publishable key + the person's login token, so Row Level Security applies.
const { createClient } = require('@supabase/supabase-js');

const required = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  throw new Error('Missing environment variables: ' + missing.join(', '));
}

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };

const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, opts);
const anon = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, opts);

function asUser(token) {
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    ...opts,
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

// Supabase returns at most 1000 rows per request; this fetches every page.
async function fetchAll(table, columns, build) {
  const out = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    let q = service.from(table).select(columns).order('id').range(from, from + size - 1);
    if (build) q = build(q);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...data);
    if (data.length < size) break;
  }
  return out;
}

module.exports = { service, anon, asUser, fetchAll };
