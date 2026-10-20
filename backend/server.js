const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const postRoutes = require('./routes/posts');

const app = express();
const PORT = Number(process.env.PORT) || 4000;
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be configured with at least 32 characters. Copy .env.example to .env and set it.');
  process.exit(1);
}
app.disable('x-powered-by');
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  contentSecurityPolicy: false
}));
const defaultOrigins = ['http://localhost:4000', 'http://127.0.0.1:4000', 'http://localhost:5500', 'http://127.0.0.1:5500'];
const configuredOrigins = (process.env.CLIENT_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
const allowedOrigins = Array.from(new Set([...defaultOrigins, ...configuredOrigins]));
app.use(cors({ origin: allowedOrigins, methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(compression());
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { dotfiles: 'deny', index: false, maxAge: '1d' }));
// Serve the vanilla frontend too, so the whole app can run at http://localhost:4000.
app.use(express.static(path.join(__dirname, '..', 'frontend'), { extensions: ['html'] }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }), authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/posts', postRoutes);
app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'PicShare API' }));
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON payload.' });
  if (err.name === 'MulterError') return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Image must be smaller than ${process.env.MAX_UPLOAD_MB || 5} MB.` : 'Upload could not be processed.' });
  if (err.message && err.message.startsWith('Only JPEG')) return res.status(400).json({ error: err.message });
  if (err.code === 11000) {
    if (err.keyPattern?.username || (err.message && err.message.includes('username'))) {
      return res.status(409).json({ error: 'That username is already taken. Please choose another.' });
    }
    if (err.keyPattern?.email || (err.message && err.message.includes('email'))) {
      return res.status(409).json({ error: 'An account with that email already exists. Please log in instead.' });
    }
    return res.status(409).json({ error: 'Username or email already exists.' });
  }
  if (err.name === 'ValidationError') {
    const firstMsg = err.errors ? Object.values(err.errors).map(e => e.message)[0] : null;
    return res.status(400).json({ error: firstMsg || 'Invalid input.' });
  }
  if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid input format.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/picshare')
  .then(() => app.listen(PORT, () => console.log(`PicShare API listening on http://localhost:${PORT}`)))
  .catch(err => { console.error('MongoDB connection failed:', err.message); process.exit(1); });
