const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const router = express.Router();

function issueToken(user) {
  return jwt.sign({ sub: user.id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '2h' });
}

async function generateUniqueUsername(email = '', name = '') {
  let base = (email ? email.split('@')[0] : '') || name || 'user';
  base = base.toLowerCase().replace(/[^a-z0-9_.]/g, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, 18);
  if (base.length < 3) base = `user_${base}`.slice(0, 18);
  if (base.length < 3) base = 'user';

  let candidate = base;
  let counter = 1;
  while (await User.exists({ username: candidate })) {
    const suffix = counter < 10 ? String(counter) : Math.floor(1000 + Math.random() * 9000).toString();
    candidate = `${base.slice(0, 24 - suffix.length - 1)}_${suffix}`;
    counter++;
    if (counter > 50) {
      candidate = `u_${Date.now().toString(36).slice(-6)}_${Math.floor(Math.random() * 999)}`;
      break;
    }
  }
  return candidate;
}

// Return public authentication configuration for frontend initialization
router.get('/config', (_req, res) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || ''
  });
});

router.post('/register', asyncHandler(async (req, res) => {
  let { username, name, email, password } = req.body || {};
  username = String(username || '').trim().toLowerCase();
  name = String(name || '').trim();
  email = String(email || '').trim().toLowerCase();

  if (!username) {
    return res.status(400).json({ error: 'Username is required.' });
  }
  if (!/^[a-z0-9_.]{3,24}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3–24 characters and use letters, numbers, dots, or underscores.' });
  }
  if (!name || name.length < 1 || name.length > 60) {
    return res.status(400).json({ error: 'Full name is required and must be under 60 characters.' });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
  }
  if (password.length > 72) {
    return res.status(400).json({ error: 'Password cannot exceed 72 characters.' });
  }

  // Check username and email collisions separately with clear 409 responses
  if (await User.exists({ username })) {
    return res.status(409).json({ error: 'That username is already taken. Please choose another.' });
  }
  if (await User.exists({ email })) {
    return res.status(409).json({ error: 'An account with that email already exists. Please log in instead.' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  try {
    const user = await User.create({ username, name, email, passwordHash });
    return res.status(201).json({ token: issueToken(user), user: user.toJSON() });
  } catch (err) {
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
      const msg = Object.values(err.errors).map(e => e.message)[0] || 'Invalid input.';
      return res.status(400).json({ error: msg });
    }
    throw err;
  }
}));

router.post('/login', asyncHandler(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = req.body?.password;
  if (!email || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const user = await User.findOne({ email }).select('+passwordHash');
  if (!user || !user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  res.json({ token: issueToken(user), user: user.toJSON() });
}));

router.post('/google', asyncHandler(async (req, res) => {
  const credential = req.body?.credential || req.body?.idToken || req.body?.token;
  if (!credential || typeof credential !== 'string') {
    return res.status(400).json({ error: 'Google credential token is required.' });
  }

  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  if (!googleClientId) {
    return res.status(500).json({ error: 'Google authentication is not configured on the server. Please set GOOGLE_CLIENT_ID.' });
  }

  const client = new OAuth2Client(googleClientId);
  let payload;
  try {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: googleClientId
    });
    payload = ticket.getPayload();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired Google token. Please sign in again.' });
  }

  if (!payload || !payload.sub) {
    return res.status(401).json({ error: 'Invalid Google token payload.' });
  }

  if (!payload.email) {
    return res.status(400).json({ error: 'Google account does not provide an email address.' });
  }

  if (!payload.email_verified) {
    return res.status(403).json({ error: 'Google account email is not verified. Please verify your email with Google first.' });
  }

  const googleId = String(payload.sub).trim();
  const email = String(payload.email).trim().toLowerCase();
  const name = String(payload.name || payload.given_name || email.split('@')[0] || 'Member').trim().slice(0, 60);
  const avatarUrl = payload.picture ? String(payload.picture).trim() : '';

  // 1. Find existing user by Google ID
  let user = await User.findOne({ googleId });

  // 2. If not found by Google ID, find by verified email and safely link accounts
  if (!user) {
    user = await User.findOne({ email });
    if (user) {
      if (user.googleId && user.googleId !== googleId) {
        return res.status(409).json({ error: 'This email is already linked to a different Google account.' });
      }
      user.googleId = googleId;
      if (!user.avatarUrl && avatarUrl) {
        user.avatarUrl = avatarUrl;
      }
      await user.save();
    }
  }

  // 3. If still not found, create a new Google-authenticated user
  if (!user) {
    const username = await generateUniqueUsername(email, name);
    try {
      user = await User.create({
        username,
        name,
        email,
        googleId,
        avatarUrl
      });
    } catch (err) {
      if (err.code === 11000) {
        // Retry with a guaranteed random username suffix if a collision occurred
        const fallbackUsername = `user_${Date.now().toString(36)}_${Math.floor(Math.random() * 1000)}`;
        user = await User.create({
          username: fallbackUsername.slice(0, 24),
          name,
          email,
          googleId,
          avatarUrl
        });
      } else {
        throw err;
      }
    }
  }

  res.json({ token: issueToken(user), user: user.toJSON() });
}));

module.exports = router;

