const test = require('node:test');
const assert = require('node:assert/strict');
if (!process.env.TEST_MONGODB_URI) {
  test('Communications integration (set TEST_MONGODB_URI)', { skip: true }, () => {});
} else {
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { io: client } = require('socket.io-client');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Call = require('../models/Call');
const Location = require('../models/LocationSession');
const Block = require('../models/Block');
let server, io, base, people, tokens, conversation;
const sockets = [];
process.env.JWT_SECRET = 'isolated-communications-test-secret-only';
async function request(who, path, method = 'GET', body) {
  const response = await fetch(base + '/api' + path, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, ...data };
}
function event(socket, name) {
  return new Promise((resolve, reject) => { const timeout = setTimeout(() => { socket.off(name, done); reject(new Error(`Missing ${name}`)); }, 2500); function done(data) { clearTimeout(timeout); resolve(data); } socket.once(name, done); });
}
async function connect(who) {
  const socket = client(base, { auth: { token: tokens[who], messenger: true }, transports: ['websocket'], reconnection: false });
  sockets.push(socket);
  await event(socket, 'connect');
  return socket;
}
const ack = (socket, name, data) => new Promise((resolve, reject) => socket.timeout(2500).emit(name, data, (error, result) => error ? reject(error) : resolve(result)));
test.before(async () => {
  await mongoose.connect(process.env.TEST_MONGODB_URI, { serverSelectionTimeoutMS: 3000 });
  await Promise.all([User.init(), Conversation.init(), Message.init(), Block.init(), Call.init(), Location.init()]);
  const suffix = Date.now();
  people = await User.create(['a', 'b', 'c'].map(letter => ({ username: `comm_${letter}_${suffix}`, name: letter, email: `${letter}_${suffix}@comms.test.local`, passwordHash: 'test' })));
  tokens = people.map(p => jwt.sign({ sub: p.id }, process.env.JWT_SECRET, { expiresIn: '1h' }));
  const app = express(); server = http.createServer(app); io = new Server(server);
  app.set('io', io); require('../socketHandler')(io);
  app.use(express.json());
  app.use('/api/conversations', require('../routes/conversations'));
  app.use('/api/locations', require('../routes/locations'));
  app.use('/api/users', require('../routes/users'));
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/posts', require('../routes/posts'));
  app.use('/api/ai', require('../routes/ai'));
  app.use('/api/notifications', require('../routes/notifications'));
  app.use((err, req, res, next) => res.status(err.status || (err.code === 11000 ? 409 : 500)).json({ error: err.message }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  sockets.forEach(s => s.disconnect());
  if (io) await new Promise(resolve => io.close(resolve));
  if (people) {
    const ids = people.map(p => p._id);
    const conversations = await Conversation.find({ participants: { $in: ids } });
    await Message.deleteMany({ conversation: { $in: conversations.map(c => c._id) } });
    await Conversation.deleteMany({ participants: { $in: ids } });
    await Location.deleteMany({ owner: { $in: ids } });
    await Call.deleteMany({ caller: { $in: ids } });
    await Block.deleteMany({ owner: { $in: ids } });
    await require('../models/Notification').deleteMany({ recipient: { $in: ids } });
    const attachments = await require('../models/Attachment').find({ owner: { $in: ids } });
    const fs = require('fs/promises'), path = require('path');
    for (const attachment of attachments) await fs.unlink(path.join(__dirname, '..', 'uploads-private', attachment.filename)).catch(() => {});
    await require('../models/Attachment').deleteMany({ owner: { $in: ids } });
    await User.deleteMany({ _id: { $in: ids } });
  }
  await mongoose.disconnect();
});
test('canonical conversation and unauthorized access', async () => {
  const results = await Promise.all([request(0, '/conversations', 'POST', { recipientId: people[1].id }), request(1, '/conversations', 'POST', { recipientId: people[0].id })]);
  assert.equal(results[0].status, 201); assert.equal(results[1].status, 201);
  conversation = results[0].conversation._id;
  assert.equal(conversation, results[1].conversation._id);
  assert.equal((await request(2, `/conversations/${conversation}/messages`)).status, 403);
  assert.equal((await request(2, `/conversations/${conversation}/messages`, 'POST', { text: 'intrude', idempotencyKey: 'intruder-000' })).status, 403);
});
test('server publishes persisted messages; concurrent retries deduplicate; receipt requires recipient ack', async () => {
  const sender = await connect(0), recipient = await connect(1);
  const incoming = event(recipient, 'message:new');
  const body = { type: 'text', text: 'Hello', idempotencyKey: 'deduplicate-0001' };
  const responses = await Promise.all([request(0, `/conversations/${conversation}/messages`, 'POST', body), request(0, `/conversations/${conversation}/messages`, 'POST', body)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 201]);
  const { message } = await incoming;
  assert.equal(await Message.countDocuments({ conversation, idempotencyKey: body.idempotencyKey }), 1);
  assert.equal((await Message.findById(message._id)).deliveryState, 'sent');
  const delivered = event(sender, 'message:delivered');
  assert.equal((await ack(recipient, 'message:received', { conversationId: conversation, messageId: message._id })).ok, true);
  await delivered;
  assert.equal((await Message.findById(message._id)).deliveryState, 'delivered');
  const inbox = await request(1, '/conversations'); assert.equal(inbox.conversations[0].unreadCount, 1);
  assert.equal((await request(1, `/conversations/${conversation}/read`, 'PATCH', { through: message._id })).status, 200);
  assert.equal((await request(1, '/conversations')).conversations[0].unreadCount, 0);
  assert.equal((await Message.findById(message._id)).deliveryState, 'read');
});
test('equal timestamp pagination and forward reconnect recovery do not lose messages', async () => {
  const at = new Date('2026-01-01');
  const messages = await Message.create([1, 2, 3].map(n => ({ conversation, sender: people[0]._id, text: `page ${n}`, createdAt: at })));
  const sorted = messages.sort((a, b) => a.id.localeCompare(b.id));
  const previous = await request(0, `/conversations/${conversation}/messages?before=${sorted[2].id}&limit=2`);
  assert.deepEqual(previous.messages.map(m => m._id), sorted.slice(0, 2).map(m => m.id));
  const after = await request(0, `/conversations/${conversation}/messages?after=${sorted[0].id}&limit=2`);
  assert.deepEqual(after.messages.map(m => m._id), sorted.slice(1).map(m => m.id));
});
test('cross-conversation replies, edits and cursor theft rejected', async () => {
  const other = await request(0, '/conversations', 'POST', { recipientId: people[2].id });
  const message = await Message.create({ conversation: other.conversation._id, sender: people[0]._id, text: 'private' });
  assert.equal((await request(1, `/conversations/${conversation}/messages`, 'POST', { type: 'text', text: 'reply', replyTo: message.id, idempotencyKey: 'reply-invalid' })).status, 400);
  assert.equal((await request(1, `/conversations/${conversation}/messages?before=${message.id}`)).status, 400);
  assert.equal((await request(1, `/conversations/messages/${message.id}`, 'PATCH', { text: 'overwrite' })).status, 403);
});
test('location enforces owner, recipient, numeric coordinates, expiry and revocation', async () => {
  const started = await request(0, '/locations/live', 'POST', { conversationId: conversation, durationMinutes: 15 });
  assert.equal(started.status, 201); const id = started.session._id;
  assert.equal((await request(2, `/locations/live/${id}`)).status, 403);
  assert.equal((await request(1, `/locations/live/${id}`, 'PATCH', { lat: 1, lng: 2 })).status, 403);
  assert.equal((await request(0, `/locations/live/${id}`, 'PATCH', { lat: null, lng: 2 })).status, 400);
  assert.equal((await request(0, `/locations/live/${id}`, 'PATCH', { lat: 1, lng: 2 })).status, 200);
  assert.equal((await request(1, `/locations/live/${id}`)).lat, 1);
  const live = await request(0, `/conversations/${conversation}/messages`, 'POST', { type: 'live_location', location: { sessionId: id }, idempotencyKey: 'live-session-001' });
  assert.equal(live.message.location.sessionId, id);
  await request(0, `/locations/live/${id}`, 'DELETE');
  assert.equal((await request(1, `/locations/live/${id}`)).status, 410);
  assert.equal((await request(0, `/locations/live/${id}`, 'PATCH', { lat: 1, lng: 2 })).status, 410);
  const expired = await Location.create({ owner: people[0]._id, recipient: people[1]._id, conversation, lat: 1, lng: 2, expiresAt: new Date(Date.now() - 1000) });
  assert.equal((await request(1, `/locations/live/${expired.id}`)).status, 410);
  assert.equal((await Location.findById(expired.id)).lat, undefined);
});
test('socket authorization rejects nonparticipants, typing injection and arbitrary calls', async () => {
  const stranger = await connect(2);
  assert.ok((await ack(stranger, 'conversation:join', { conversationId: conversation })).error);
  assert.ok((await ack(stranger, 'typing:start', { conversationId: conversation })).error);
  assert.ok((await ack(stranger, 'call:invite', { conversationId: conversation, recipientId: people[1].id, callType: 'audio' })).error);
});
test('call invitation, participant signaling, busy rejection, cancellation and history', async () => {
  const a = sockets[0], b = sockets[1], c = sockets[2];
  const incoming = event(b, 'call:incoming');
  assert.equal((await ack(a, 'call:invite', { conversationId: conversation, recipientId: people[1].id, callType: 'audio' })).ok, true);
  const { callId } = await incoming;
  assert.ok((await ack(c, 'call:ice', { callId, candidate: { candidate: 'fake' } })).error);
  assert.ok((await ack(b, 'call:invite', { conversationId: conversation, recipientId: people[0].id, callType: 'audio' })).error);
  assert.equal((await ack(a, 'call:cancel', { callId })).ok, true);
  assert.equal((await Call.findById(callId)).endReason, 'cancelled');
  assert.equal(await Message.countDocuments({ callRef: callId }), 1);
  assert.ok((await ack(a, 'call:ice', { callId, candidate: { candidate: 'stale' } })).error);
});
test('blocking revokes location and prevents messaging and new calls', async () => {
  const started = await request(0, '/locations/live', 'POST', { conversationId: conversation, durationMinutes: 15 });
  assert.equal((await request(1, `/users/${people[0].id}/block`, 'POST', {})).status, 200);
  assert.equal((await request(0, `/conversations/${conversation}/messages`, 'POST', { type: 'text', text: 'blocked', idempotencyKey: 'blocked-0001' })).status, 403);
  assert.equal((await request(0, `/locations/live/${started.session._id}`)).status, 403);
  assert.equal((await Location.findById(started.session._id)).active, false);
  assert.ok((await ack(sockets[0], 'call:invite', { conversationId: conversation, recipientId: people[1].id, callType: 'audio' })).error);
  await request(1, `/users/${people[0].id}/block`, 'DELETE');
});
test('private image upload does not create a public post; outsider cannot fetch or reuse it', async () => {
  const fd = new FormData();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1cAAAAASUVORK5CYII=', 'base64');
  fd.append('image', new Blob([png], { type: 'image/png' }), 'test.png');
  const response = await fetch(`${base}/api/conversations/${conversation}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${tokens[0]}` }, body: fd });
  assert.equal(response.status, 201);
  const { imageUrl } = await response.json();
  const recipient = await fetch(base + imageUrl, { headers: { Authorization: `Bearer ${tokens[1]}` } });
  assert.equal(recipient.status, 200);
  assert.equal((await fetch(base + imageUrl, { headers: { Authorization: `Bearer ${tokens[2]}` } })).status, 403);
  const message = await request(0, `/conversations/${conversation}/messages`, 'POST', { type: 'image', imageUrl, idempotencyKey: 'private-image-001' });
  assert.equal(message.status, 201);
  const other = await request(0, '/conversations', 'POST', { recipientId: people[2].id });
  assert.equal((await request(0, `/conversations/${other.conversation._id}/messages`, 'POST', { type: 'image', imageUrl, idempotencyKey: 'image-wrong-conv' })).status, 400);
  const filename = imageUrl.split('/').at(-1);
  assert.equal((await fetch(`${base}/api/conversations/${other.conversation._id}/attachments/${filename}`, { headers: { Authorization: `Bearer ${tokens[2]}` } })).status, 404);
  assert.equal(await require('../models/Post').countDocuments({ author: people[0]._id }), 0);
});
test('notification records deduplicate and enforce recipient access', async () => {
  const inbox = await request(1, '/notifications');
  const notifications = inbox.notifications.filter(n => n.type === 'new_message');
  assert.ok(notifications.length);
  assert.equal(new Set(notifications.map(n => n.message)).size, notifications.length);
  assert.equal((await request(2, `/notifications/${notifications[0]._id}/read`, 'PATCH', {})).status, 404);
  assert.equal((await request(1, `/notifications/${notifications[0]._id}/read`, 'PATCH', {})).status, 200);
});
test('message edits, reactions and deletion persist and enforce ownership', async () => {
  const created = await request(0, `/conversations/${conversation}/messages`, 'POST', { type: 'text', text: 'original', idempotencyKey: 'edit-reaction-001' });
  const id = created.message._id;
  assert.equal((await request(1, `/conversations/messages/${id}`, 'PATCH', { text: 'forged' })).status, 403);
  assert.equal((await request(0, `/conversations/messages/${id}`, 'PATCH', { text: 'updated' })).message.text, 'updated');
  assert.equal((await request(1, `/conversations/messages/${id}`, 'PATCH', { reaction: '❤️' })).status, 200);
  assert.equal((await Message.findById(id)).reactions.get(people[1].id), '❤️');
  assert.equal((await request(1, `/conversations/messages/${id}`, 'DELETE')).status, 403);
  assert.equal((await request(0, `/conversations/messages/${id}`, 'DELETE')).status, 200);
  const removed = await Message.findById(id); assert.equal(removed.text, ''); assert.equal(removed.deleted, true);
});
test('posts, captions, alt text, likes and comments retain existing behavior', async () => {
  const fd = new FormData();
  fd.append('image', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1cAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'photo.png');
  fd.append('caption', 'Regression photo'); fd.append('altText', 'One white pixel');
  const response = await fetch(base + '/api/posts', { method: 'POST', headers: { Authorization: `Bearer ${tokens[0]}` }, body: fd });
  assert.equal(response.status, 201); const { post } = await response.json();
  assert.equal((await request(1, `/posts/${post._id}`)).post.altText, 'One white pixel');
  assert.equal((await request(1, `/posts/${post._id}/like`, 'POST', {})).liked, true);
  assert.equal((await request(1, `/posts/${post._id}/comments`, 'POST', { text: 'Lovely' })).status, 201);
  const shared = await request(0, `/conversations/${conversation}/messages`, 'POST', { type: 'post_share', postRef: post._id, idempotencyKey: 'share-photo-001' });
  assert.equal(shared.message.postRef.caption, 'Regression photo');
  assert.equal((await request(1, `/posts/${post._id}`, 'DELETE')).status, 403);
  assert.equal((await request(0, `/posts/${post._id}`, 'DELETE')).status, 200);
});
test('call answer, offer/answer relay and connected heartbeat are participant-scoped', async () => {
  const a = sockets[0], b = sockets[1];
  const incoming = event(b, 'call:incoming');
  await ack(a, 'call:invite', { conversationId: conversation, recipientId: people[1].id, callType: 'video' });
  const { callId } = await incoming;
  assert.equal((await ack(b, 'call:answer', { callId })).ok, true);
  const offer = event(b, 'call:offer');
  assert.equal((await ack(a, 'call:offer', { callId, sdp: { type: 'offer', sdp: 'test-sdp-offer' } })).ok, true);
  assert.equal((await offer).callId, callId);
  const answer = event(a, 'call:answer_sdp');
  await ack(b, 'call:answer_sdp', { callId, sdp: { type: 'answer', sdp: 'test-sdp-answer' } }); await answer;
  assert.equal((await ack(a, 'call:connected', { callId })).ok, true);
  assert.equal((await Call.findById(callId)).state, 'connected');
  await ack(a, 'call:heartbeat', { callId });
  await ack(b, 'call:end', { callId });
  assert.equal((await Call.findById(callId)).state, 'ended');
});
test('missing AI configuration gracefully rejects without publishing', async () => {
  delete process.env.AI_PROVIDER_URL;
  assert.equal((await request(0, '/ai/suggest', 'POST', {})).status, 503);
});
}
