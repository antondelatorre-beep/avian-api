// api/server.js — Avian Market PH API
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { general } = require('./limits');
const { notFound, errorHandler } = require('./errors');

const app = express();
app.set('trust proxy', 1); // Render sits in front of the API

app.use(helmet());

const allowed = [process.env.CUSTOMER_SITE_URL, process.env.MANAGEMENT_SITE_URL]
  .filter(Boolean)
  .map((u) => u.replace(/\/$/, ''));

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowed.includes(origin)) return cb(null, true);
    const err = new Error('Origin not allowed');
    err.status = 403;
    cb(err);
  },
  methods: ['GET', 'POST', 'PATCH', 'PUT'],
  allowedHeaders: ['Authorization', 'Content-Type'],
}));

app.use(express.json({ limit: '100kb' }));
app.use(general);

app.use('/api', require('./public'));
app.use('/api', require('./account'));
app.use('/api/admin', require('./admin'));
app.use('/api/admin', require('./admin-system'));

app.use(notFound);
app.use(errorHandler);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Avian Market API listening on port ${port}`));
