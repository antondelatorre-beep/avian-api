// api/lib/util.js
const { z } = require('zod');
const { service } = require('./supabase');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Lets async route functions throw errors into Express's error handler.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const uuid = z.string().uuid();
const idParam = (req, name = 'id') => uuid.parse(req.params[name]);

// { birdId: 'Listing name' }
async function birdNames(ids) {
  const list = [...new Set(ids)].filter(Boolean);
  if (!list.length) return {};
  const { data, error } = await service.from('birds').select('id,listing_name').in('id', list);
  if (error) throw error;
  return Object.fromEntries(data.map((b) => [b.id, b.listing_name]));
}

// { buyerId: 'Full name' }
async function buyerNames(ids) {
  const list = [...new Set(ids)].filter(Boolean);
  if (!list.length) return {};
  const { data, error } = await service.from('buyer_profiles').select('id,full_name,email').in('id', list);
  if (error) throw error;
  return Object.fromEntries(data.map((b) => [b.id, b.full_name || b.email]));
}

module.exports = { HttpError, ah, uuid, idParam, birdNames, buyerNames };
