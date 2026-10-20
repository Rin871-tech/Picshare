const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const express = require('express');
const mongoose = require('mongoose');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const authRoutes = require('../routes/auth');

let server;
let baseUrl;

test.before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use((err, _req, res, _next) => {
    if (err.code === 11000) return res.status(409).json({ error: 'Username or email already exists.' });
    if (err.name === 'ValidationError') return res.status(400).json({ error: 'Invalid input.' });
    res.status(500).json({ error: 'Internal error' });
  });

  await new Promise(resolve => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}/api/auth`;
      resolve();
    });
  });
});

test.after(async () => {
  // Clean up test accounts
  await User.deleteMany({ email: /@autotest\.picshare\.local$/ });
  if (server) server.close();
  await mongoose.disconnect();
});

test.describe('Authentication API & Registration', () => {
  const testEmail = 'alice@autotest.picshare.local';
  const testUsername = 'alice_test';

  test.beforeEach(async () => {
    await User.deleteMany({ email: /@autotest\.picshare\.local$/ });
    await User.deleteMany({ username: { $in: ['alice_test', 'bob_test', 'testgoogleuser'] } });
  });

  test('GET /config returns public authentication configuration', async () => {
    const res = await fetch(`${baseUrl}/config`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(typeof data.googleClientId === 'string');
  });

  test('Valid registration creates MongoDB user and authenticates with JWT', async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: testUsername,
        name: 'Alice Tester',
        email: testEmail,
        password: 'password123'
      })
    });

    assert.equal(res.status, 201);
    const data = await res.json();
    assert.ok(data.token, 'Expected JWT token in response');
    assert.ok(data.user, 'Expected user object in response');
    assert.equal(data.user.username, testUsername);
    assert.equal(data.user.name, 'Alice Tester');
    assert.equal(data.user.passwordHash, undefined, 'passwordHash must not be exposed in user object');

    // Verify in MongoDB
    const dbUser = await User.findOne({ email: testEmail }).select('+passwordHash');
    assert.ok(dbUser, 'User must exist in MongoDB');
    assert.ok(dbUser.passwordHash, 'Password must be hashed in MongoDB');
    assert.notEqual(dbUser.passwordHash, 'password123', 'Password must not be stored in plaintext');
  });

  test('Registration rejects missing username with 400 Bad Request', async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Alice Tester',
        email: testEmail,
        password: 'password123'
      })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes('Username'));
  });

  test('Registration rejects invalid username characters (spaces, special chars) with 400', async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'alice test!',
        name: 'Alice Tester',
        email: testEmail,
        password: 'password123'
      })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes('Username must be 3–24 characters'));
  });

  test('Registration rejects missing full name with 400', async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: testUsername,
        name: '   ',
        email: testEmail,
        password: 'password123'
      })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes('name') || data.error.includes('Name'));
  });

  test('Registration rejects invalid email with 400', async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: testUsername,
        name: 'Alice Tester',
        email: 'invalid-email-format',
        password: 'password123'
      })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes('email'));
  });

  test('Registration rejects short password (< 8 chars) with 400', async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: testUsername,
        name: 'Alice Tester',
        email: testEmail,
        password: 'short'
      })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes('Password must be at least 8 characters'));
  });

  test('Duplicate username returns 409 Conflict', async () => {
    // Register first user
    await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: testUsername,
        name: 'Alice Tester',
        email: testEmail,
        password: 'password123'
      })
    });

    // Attempt second user with same username
    const res = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: testUsername,
        name: 'Alice Clone',
        email: 'different@autotest.picshare.local',
        password: 'password123'
      })
    });
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.ok(data.error.includes('username is already taken'));
  });

  test('Duplicate email returns 409 Conflict', async () => {
    // Register first user
    await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: testUsername,
        name: 'Alice Tester',
        email: testEmail,
        password: 'password123'
      })
    });

    // Attempt second user with different username but same email
    const res = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'alice_different',
        name: 'Alice Another',
        email: testEmail,
        password: 'password123'
      })
    });
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.ok(data.error.includes('email already exists'));
  });

  test('Local email/password login succeeds with valid credentials', async () => {
    // Register user first
    await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: testUsername,
        name: 'Alice Tester',
        email: testEmail,
        password: 'password123'
      })
    });

    const res = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: 'password123'
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.token);
    assert.equal(data.user.email, undefined);
    assert.equal(data.user.username, testUsername);
  });

  test('Local login rejects incorrect password with 401', async () => {
    await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: testUsername,
        name: 'Alice Tester',
        email: testEmail,
        password: 'password123'
      })
    });

    const res = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: 'wrongpassword'
      })
    });
    assert.equal(res.status, 401);
  });
});

test.describe('Google OAuth Endpoint', () => {
  const googleEmail = 'googleuser@autotest.picshare.local';
  const googleSub = 'google-sub-1234567890';

  test.beforeEach(async () => {
    await User.deleteMany({ email: /@autotest\.picshare\.local$/ });
    await User.deleteMany({ googleId: googleSub });
  });

  test('POST /google returns 400 when credential token is missing', async () => {
    const res = await fetch(`${baseUrl}/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes('credential'));
  });

  test('POST /google returns 401 when token is invalid or unverified', async () => {
    const res = await fetch(`${baseUrl}/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: 'invalid.fake.jwt-token' })
    });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.ok(data.error.includes('Invalid or expired Google token'));
  });

  test('POST /google creates new user without password on verified Google ID token', async () => {
    const originalVerify = OAuth2Client.prototype.verifyIdToken;
    OAuth2Client.prototype.verifyIdToken = async function () {
      return {
        getPayload: () => ({
          sub: googleSub,
          email: googleEmail,
          email_verified: true,
          name: 'Google Test User',
          picture: 'https://lh3.googleusercontent.com/test-avatar.jpg'
        })
      };
    };

    try {
      const res = await fetch(`${baseUrl}/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: 'valid.mocked.google.token' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.token, 'Must return an application JWT');
      assert.ok(data.user, 'Must return user object');
      assert.equal(data.user.name, 'Google Test User');

      // Verify user created in MongoDB with googleId and no local password
      const dbUser = await User.findOne({ googleId: googleSub }).select('+passwordHash');
      assert.ok(dbUser);
      assert.equal(dbUser.email, googleEmail);
      assert.equal(dbUser.passwordHash, undefined, 'Google-only user should have no passwordHash');
      assert.equal(dbUser.avatarUrl, 'https://lh3.googleusercontent.com/test-avatar.jpg');
    } finally {
      OAuth2Client.prototype.verifyIdToken = originalVerify;
    }
  });

  test('POST /google safely links existing local user with verified email', async () => {
    // 1. Create local account with email and password
    const localUser = await User.create({
      username: 'locallink_user',
      name: 'Local User',
      email: googleEmail,
      passwordHash: 'dummy_hash_for_testing'
    });

    const originalVerify = OAuth2Client.prototype.verifyIdToken;
    OAuth2Client.prototype.verifyIdToken = async function () {
      return {
        getPayload: () => ({
          sub: googleSub,
          email: googleEmail,
          email_verified: true,
          name: 'Local User',
          picture: 'https://lh3.googleusercontent.com/new-avatar.jpg'
        })
      };
    };

    try {
      const res = await fetch(`${baseUrl}/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: 'valid.mocked.google.token' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(String(data.user._id), String(localUser._id), 'Should link to the existing account');

      // Verify database document was updated with googleId
      const updated = await User.findById(localUser._id).select('+passwordHash');
      assert.equal(updated.googleId, googleSub);
      assert.equal(updated.passwordHash, 'dummy_hash_for_testing', 'Local password must be preserved');
    } finally {
      OAuth2Client.prototype.verifyIdToken = originalVerify;
    }
  });

  test('POST /google rejects unverified email with 403', async () => {
    const originalVerify = OAuth2Client.prototype.verifyIdToken;
    OAuth2Client.prototype.verifyIdToken = async function () {
      return {
        getPayload: () => ({
          sub: googleSub,
          email: 'unverified@autotest.picshare.local',
          email_verified: false,
          name: 'Unverified User'
        })
      };
    };

    try {
      const res = await fetch(`${baseUrl}/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: 'valid.unverified.token' })
      });
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.ok(data.error.includes('not verified'));
    } finally {
      OAuth2Client.prototype.verifyIdToken = originalVerify;
    }
  });
});
