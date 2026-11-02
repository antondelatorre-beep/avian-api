// api/middleware/errors.js — turns any error into a safe, readable JSON reply
const { ZodError } = require('zod');

function notFound(req, res) {
  res.status(404).json({ error: 'Not found.' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Please check the information you entered.',
      details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request could not be read.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large.' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });

  switch (err.code) {
    case '23505': return res.status(409).json({ error: 'That record already exists.' });
    case '23514': return res.status(400).json({ error: 'That change breaks a safety rule (for example, a bird cannot be Available or Reserved until its identity and documentation are verified).' });
    case '23503': return res.status(400).json({ error: 'A related record was not found.' });
    case '42501': return res.status(403).json({ error: 'You do not have permission to do that.' });
    case 'PGRST116': return res.status(404).json({ error: 'Not found, or you do not have permission.' });
    case 'P0001': return res.status(400).json({ error: err.message }); // our own database rule messages
    default: break;
  }
  console.error('Unexpected error:', err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
}

module.exports = { notFound, errorHandler };
