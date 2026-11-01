// api/lib/limits.js — rate limiting
const rateLimit = require('express-rate-limit');

const msg = { error: 'Too many requests. Please wait a moment and try again.' };

// Whole API: 300 requests per 15 minutes per visitor
const general = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false, message: msg });

// Actions that create things (applications, messages, uploads...): 30 per minute
const strict = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: msg });

module.exports = { general, strict };
