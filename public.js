// api/routes/public.js — no login needed
const router = require('express').Router();
const { z } = require('zod');
const { anon } = require('./supabase');
const { ah, idParam, HttpError } = require('./util');

router.get('/health', (req, res) => res.json({ ok: true, service: 'avian-market-api' }));

const listQuery = z.object({
  search: z.string().max(60).optional(),
  min: z.coerce.number().nonnegative().optional(),
  max: z.coerce.number().nonnegative().optional(),
  status: z.enum(['Available', 'Reserved']).optional(),
});

// Public catalog: ONLY Available/Reserved birds (the database view enforces this)
router.get('/birds', ah(async (req, res) => {
  const q = listQuery.parse(req.query);
  let query = anon.from('public_birds').select('*').order('sort_order');
  if (q.search) {
    const s = q.search.replace(/[^\p{L}\p{N} \-/]/gu, ' ').trim();
    if (s) query = query.or(`listing_name.ilike.%${s}%,species_common.ilike.%${s}%,scientific_name.ilike.%${s}%`);
  }
  if (q.min !== undefined) query = query.gte('price_php', q.min);
  if (q.max !== undefined) query = query.lte('price_php', q.max);
  if (q.status) query = query.eq('status', q.status);
  const { data, error } = await query;
  if (error) throw error;
  res.json({ birds: data });
}));

router.get('/birds/:id', ah(async (req, res) => {
  const id = idParam(req);
  const { data, error } = await anon.from('public_birds').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'Bird not found.');
  res.json({ bird: data });
}));

module.exports = router;
