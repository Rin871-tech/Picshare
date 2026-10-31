const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const postRoutes = require('./routes/posts');
const conversationRoutes = require('./routes/conversations');
const locationRoutes = require('./routes/locations');
const attachSocketHandlers = require('./socketHandler');

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT) || 4000;

// ── Security guard ────────────────────────────────────────────────────────────
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be configured with at least 32 characters. Copy .env.example to .env and set it.');
  process.exit(1);
}

// ── CORS ──────────────────────────────────────────────────────────────────────
const defaultOrigins = [
  'http://localhost:4000',
  'http://127.0.0.1:4000',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];
const configuredOrigins = ([process.env.CLIENT_ORIGIN, (process.env.MOBILE_CLIENT_ORIGINS ?? 'https://localhost,capacitor://localhost')].filter(Boolean).join(',')).split(',').map(s => s.trim()).filter(Boolean);
const allowedOrigins = process.env.NODE_ENV === 'production' ? configuredOrigins : Array.from(new Set([...defaultOrigins, ...configuredOrigins]));
if (process.env.NODE_ENV === 'production' && !String(process.env.CLIENT_ORIGIN || '').trim()) throw new Error('CLIENT_ORIGIN is required in production.');

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  },
  // Prevent cross-site WebSocket hijacking
  allowRequest: (req, cb) => cb(null, !req.headers.origin || allowedOrigins.includes(req.headers.origin)),
  maxHttpBufferSize: 100000,
  transports: ['websocket', 'polling']
});

app.set('io', io);
attachSocketHandlers(io);

// ── Express middleware ────────────────────────────────────────────────────────
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) { if (!/^[0-5]$/.test(process.env.TRUST_PROXY)) throw new Error('TRUST_PROXY must be a verified proxy hop count from 0 to 5.'); app.set('trust proxy', Number(process.env.TRUST_PROXY)); }
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  contentSecurityPolicy: false
}));
app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(compression());
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

// Static files
app.use(require('./utils/media').decorate);
app.get('/uploads/:file', async (req, res, next) => {
  try {
    if (!/^[a-f0-9-]+\.(jpg|png|webp|gif)$/.test(req.params.file)) return res.sendStatus(404);
    let viewer;
    if (req.query.media) {
      const payload = require('jsonwebtoken').verify(req.query.media, process.env.JWT_SECRET);
      if (payload.media !== `/uploads/${req.params.file}`) return res.sendStatus(403);
      viewer = payload.sub;
    }
    const post = await require('./models/Post').findOne({ imageUrl: `/uploads/${req.params.file}` });
    if (post) {
      if (!viewer) return res.status(403).json({ error: 'Use an authorized media link.' });
      await require('./utils/privacy').assertView(post.author, viewer);
      res.set('Cache-Control', 'private, no-store');
      return res.sendFile(path.join(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'), req.params.file));
    }
    const avatar = await require('./models/User').exists({ avatarUrl: `/uploads/${req.params.file}` });
    if (!avatar) return res.sendStatus(404);
    res.sendFile(path.join(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'), req.params.file));
  } catch (error) { if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') return res.sendStatus(403); next(error); }
});
// Serve vanilla frontend at root
app.use(express.static(path.join(__dirname, '..', 'frontend'), { extensions: ['html'] }));

// ── Rate limiters ─────────────────────────────────────────────────────────────
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
const messageLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });
const locationLimiter = rateLimit({ windowMs: 10 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });

app.use('/api', rateLimit({ windowMs: 60000, limit: 180, standardHeaders: 'draft-7', legacyHeaders: false }));
const uploadLimiter = rateLimit({ windowMs: 600000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
app.use('/api', (req, res, next) => req.method === 'POST' && req.is('multipart/form-data') ? uploadLimiter(req, res, next) : next());

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/ai', rateLimit({ windowMs: 60000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false }), require('./routes/ai'));
app.use('/api/conversations', messageLimiter, conversationRoutes);
app.use('/api/locations', locationLimiter, locationRoutes);
app.use('/api/notifications', require('./routes/notifications'));
app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'PicShare API', realtime: 'socket.io' }));
app.use('/api', require('./routes/community'));
app.use('/api', require('./routes/social'));


// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON payload.' });
  if (err.name === 'MulterError') return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
    error: err.code === 'LIMIT_FILE_SIZE' ? `Image must be smaller than ${process.env.MAX_UPLOAD_MB || 5} MB.` : 'Upload could not be processed.'
  });
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
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error('Request failed:', err.name || 'Error');
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});


/* ── MongoDB + start ─────────────────────────────────────────────── */
async function start() {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    throw new Error('MONGODB_URI is missing from the environment.');
  }

  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 15000
  });

  console.log('PicShare database connected.');

  const storyCleanup = setInterval(() => {
    require('./routes/community')
      .cleanupStories()
      .catch(() => {});
  }, 60000);

  storyCleanup.unref();

  server.on('close', () => clearInterval(storyCleanup));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  console.log(`PicShare listening on port ${PORT}.`);
}

if (require.main === module) {
  start().catch((error) => {
    // Redact credentials and connection strings before logging.
    const redact = (value) => String(value || '')
      .replace(
        /mongodb(?:\+srv)?:\/\/[^\s"'`]+/gi,
        '[REDACTED_MONGODB_URI]'
      )
      .replace(
        /(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*[^,\s]+/gi,
        '$1=[REDACTED]'
      );

    console.error('PicShare startup failed:', {
      name: error?.name || 'Error',
      code: error?.code || error?.cause?.code || null,
      message: redact(error?.message),
      stack: redact(error?.stack)
    });

    process.exitCode = 1;
  });
}

module.exports = { app, server, io, start };

