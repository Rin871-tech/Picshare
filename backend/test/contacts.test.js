const test = require('node:test');
const assert = require('node:assert/strict');
if (!process.env.TEST_MONGODB_URI) test('Contacts integration requires disposable MongoDB', { skip: true }, () => {});
else {
  const express = require('express'), mongoose = require('mongoose'), jwt = require('jsonwebtoken');
  const User = require('../models/User'), Block = require('../models/Block');
  process.env.JWT_SECRET = 'isolated-contact-test-secret-at-least-32-characters';
  let server, base, users, tokens;
  async function request(index, path, method = 'GET', body) {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(index !== null ? { Authorization: 'Bearer ' + tokens[index] } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, ...await response.json() };
  }
  test.before(async () => {
    await mongoose.connect(process.env.TEST_MONGODB_URI);
    const stamp = Date.now();
    users = await User.create(['a','b','c'].map(letter => ({ name: letter, username: `ct_${letter}_${stamp}`, email: `${letter}_${stamp}@contacts.test`, passwordHash: 'test' })));
    tokens = users.map(user => jwt.sign({ sub: user.id }, process.env.JWT_SECRET));
    const app = express(); app.use(express.json()); app.use('/contacts', require('../routes/contacts')); app.use((err, req, res, next) => res.status(500).json({ error: 'Test server error' }));
    server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  test.after(async () => { await new Promise(resolve => server.close(resolve)); if (users) { const ids = users.map(u => u._id); await User.deleteMany({ _id: { $in: ids } }); await Block.deleteMany({ owner: { $in: ids } }); } await mongoose.disconnect(); });
  test('matching requires authentication and opt-in, hides emails and respects privacy and blocks', async () => {
    const emails = users.map(u => u.email);
    assert.equal((await request(null, '/contacts/match', 'POST', { emails })).status, 401);
    assert.deepEqual((await request(0, '/contacts/match', 'POST', { emails })).users, []);
    assert.equal((await request(1, '/contacts/preferences', 'PATCH', { discoverable: true })).status, 200);
    const matched = await request(0, '/contacts/match', 'POST', { emails: emails.map(e => e.toUpperCase()) });
    assert.equal(matched.users.length, 1); assert.equal(matched.users[0]._id, users[1].id); assert.equal(matched.users[0].email, undefined);
    await User.updateOne({ _id: users[1]._id }, { $set: { 'privacy.account': 'private' } });
    assert.deepEqual((await request(0, '/contacts/match', 'POST', { emails })).users, []);
    await User.updateOne({ _id: users[1]._id }, { $set: { 'privacy.account': 'public' } });
    await Block.create({ owner: users[1]._id, target: users[0]._id });
    assert.deepEqual((await request(0, '/contacts/match', 'POST', { emails })).users, []);
    assert.equal((await request(0, '/contacts/match', 'POST', { emails: 'bad' })).status, 400);
    assert.equal((await request(0, '/contacts/google', 'POST', {})).status, 400);
  });
}
