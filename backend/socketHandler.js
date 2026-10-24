const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('./models/User');
const Conversation = require('./models/Conversation');
const Message = require('./models/Message');
const Call = require('./models/Call');
const { assertContact } = require('./utils/contact');

module.exports = function attachSocketHandlers(io) {
  const users = new Map();
  const reservations = new Set();
  const timers = new Map();
  const emitUser = (id, event, data) => io.to(`user:${id}`).emit(event, data);
  async function presence(uid, online) {
    const conversations = await Conversation.find({ participants: uid }).select('participants');
    const peers = new Set(conversations.flatMap(c => c.participants.map(String)).filter(id => id !== uid));
    for (const peer of peers) { try { await assertContact(uid, peer); emitUser(peer, online ? 'presence:online' : 'presence:offline', { userId: uid }); } catch { /* blocked contact */ } }
  }
  async function finish(call, reason) {
    const endedAt = new Date();
    const ended = await Call.findOneAndUpdate({ _id: call._id, state: { $ne: 'ended' } }, {
      $set: { state: 'ended', endReason: reason, endedAt, durationSeconds: call.answeredAt ? Math.max(0, Math.round((endedAt - call.answeredAt) / 1000)) : 0 },
      $unset: { expiresAt: 1 }
    }, { new: true });
    if (!ended) return;
    clearTimeout(timers.get(String(call._id)));
    timers.delete(String(call._id));
    for (const id of [call.caller, call.recipient]) emitUser(id, 'call:ended', { callId: String(call._id), reason, durationSeconds: ended.durationSeconds });
    await require('./models/Notification').create({ recipient: call.recipient, fromUser: call.caller, conversation: call.conversation, call: call._id, type: ['no_answer', 'network_error'].includes(reason) && !call.answeredAt ? 'missed_call' : 'call_ended', preview: `${call.callType} call: ${reason}` });
    const message = await Message.create({ conversation: call.conversation, sender: call.caller, type: 'call_summary', callRef: call._id, text: `${call.callType} call · ${reason} · ${ended.durationSeconds}s` });
    for (const id of [call.caller, call.recipient]) emitUser(id, 'message:new', { message });
  }
  // Also recover deadlines left by a process restart. Never TTL-delete call history.
  const sweeper = setInterval(async () => {
    try {
      await require('./models/LocationSession').updateMany({ expiresAt: { $lte: new Date() } }, { $set: { active: false }, $unset: { lat: 1, lng: 1, accuracy: 1 } });
      const stale = await Call.find({ state: { $ne: 'ended' }, expiresAt: { $lte: new Date() } });
      for (const call of stale) await finish(call, call.state === 'ringing' ? 'no_answer' : 'network_error');
    } catch { /* retry next sweep */ }
  }, 15000);
  sweeper.unref();
  io.engine.on('close', () => { clearInterval(sweeper); for (const timer of timers.values()) clearTimeout(timer); });
  io.use(async (socket, next) => {
    try {
      const payload = jwt.verify(socket.handshake.auth?.token || '', process.env.JWT_SECRET);
      const user = await User.findById(payload.sub);
      if (!user || payload.media) throw new Error();
      socket.user = user;
      socket.callReady = socket.handshake.auth?.messenger === true;
      socket.expiresAt = payload.exp * 1000;
      next();
    } catch { next(new Error('Authentication required.')); }
  });
  io.on('connection', socket => {
    const uid = String(socket.user._id);
    socket.join(`user:${uid}`);
    if (!users.has(uid)) users.set(uid, new Set());
    users.get(uid).add(socket.id);
    presence(uid, true).catch(() => {});
    const expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(0, Math.min(2147483647, socket.expiresAt - Date.now())));
    const typing = new Map();
    const limits = new Map();
    const on = (event, handler) => socket.on(event, async (data = {}, ack = () => {}) => {
      try {
        if (Date.now() >= socket.expiresAt) { socket.disconnect(true); return; }
        const now = Date.now();
        let bucket = limits.get(event);
        if (!bucket || now - bucket.at > 10000) limits.set(event, bucket = { at: now, count: 0 });
        if (++bucket.count > (event === 'call:invite' ? 5 : 100)) throw new Error('Too many events.');
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid payload.');
        await handler(data);
        if (typeof ack === 'function') ack({ ok: true });
      } catch (error) {
        if (typeof ack === 'function') ack({ error: error.status ? error.message : 'Request rejected.' });
        if (event === 'call:invite') socket.emit('call:error', { error: error.status ? error.message : 'Cannot start call.' });
      }
    });
    async function conversation(id, contact = true) {
      if (!mongoose.isValidObjectId(id)) throw new Error('Invalid conversation.');
      const c = await Conversation.findById(id);
      if (!c || !c.participants.map(String).includes(uid)) throw new Error('Access denied.');
      if (contact) await assertContact(uid, c.participants.find(p => String(p) !== uid));
      return c;
    }
    async function activeCall(id) {
      if (!mongoose.isValidObjectId(id)) throw new Error();
      const c = await Call.findById(id);
      if (!c || c.state === 'ended' || ![String(c.caller), String(c.recipient)].includes(uid)) throw new Error();
      await conversation(c.conversation, false);
      await assertContact(c.caller, c.recipient, 'calls');
      return c;
    }
    on('conversation:join', async ({ conversationId }) => {
      const c = await conversation(conversationId, false);
      await socket.join(`conv:${c._id}`);
      for (const peer of c.participants.map(String).filter(id => id !== uid)) {
        try { await assertContact(uid, peer); socket.emit(users.has(peer) ? 'presence:online' : 'presence:offline', { userId: peer }); } catch { socket.emit('presence:offline', { userId: peer }); }
      }
    });
    on('conversation:leave', async ({ conversationId }) => socket.leave(`conv:${conversationId}`));
    on('typing:start', async ({ conversationId }) => {
      await conversation(conversationId);
      socket.to(`conv:${conversationId}`).emit('typing:start', { conversationId, userId: uid, username: socket.user.username });
      clearTimeout(typing.get(conversationId));
      typing.set(conversationId, setTimeout(() => {
        socket.to(`conv:${conversationId}`).emit('typing:stop', { conversationId, userId: uid });
        typing.delete(conversationId);
      }, 5000));
    });
    on('typing:stop', async ({ conversationId }) => {
      await conversation(conversationId);
      clearTimeout(typing.get(conversationId));
      typing.delete(conversationId);
      socket.to(`conv:${conversationId}`).emit('typing:stop', { conversationId, userId: uid });
    });
    // Delivery means an authenticated recipient client acknowledged receipt.
    on('message:received', async ({ conversationId, messageId }) => {
      await conversation(conversationId, false);
      const message = await Message.findOneAndUpdate({ _id: messageId, conversation: conversationId, sender: { $ne: uid }, deliveryState: 'sent' }, { $set: { deliveryState: 'delivered' } }, { new: true });
      if (message) emitUser(message.sender, 'message:delivered', { conversationId, messageId });
    });
    on('call:invite', async ({ conversationId, recipientId, callType }) => {
      const conv = await conversation(conversationId, false);
      await assertContact(uid, recipientId, 'calls');
      if (!['audio', 'video'].includes(callType) || recipientId === uid || !conv.participants.map(String).includes(recipientId)) throw new Error();
      if (![...io.sockets.sockets.values()].some(peer => String(peer.user?._id) === recipientId && peer.callReady)) throw Object.assign(new Error('Recipient is unavailable. Ask them to open Messages.'), { status: 409 });
      if (reservations.has(uid) || reservations.has(recipientId)) throw Object.assign(new Error('User is busy.'), { status: 409 });
      reservations.add(uid); reservations.add(recipientId);
      try {
        const busy = await Call.exists({ state: { $ne: 'ended' }, $or: [{ caller: { $in: [uid, recipientId] } }, { recipient: { $in: [uid, recipientId] } }] });
        if (busy) throw Object.assign(new Error('User is busy.'), { status: 409 });
        const call = await Call.create({ caller: uid, recipient: recipientId, conversation: conv._id, callType, state: 'ringing', expiresAt: new Date(Date.now() + 45000) });
        socket.emit('call:outgoing', { callId: String(call._id), callType, recipientId });
        emitUser(recipientId, 'call:incoming', { callId: String(call._id), callType, callerId: uid, callerName: socket.user.name, callerUsername: socket.user.username, callerAvatar: socket.user.avatarUrl });
        timers.set(String(call._id), setTimeout(() => finish(call, 'no_answer').catch(() => {}), 45000));
      } finally { reservations.delete(uid); reservations.delete(recipientId); }
    });
    on('call:answer', async ({ callId }) => {
      const call = await activeCall(callId);
      if (String(call.recipient) !== uid || call.state !== 'ringing' || call.expiresAt <= new Date()) throw new Error();
      const changed = await Call.findOneAndUpdate({ _id: callId, state: 'ringing' }, { $set: { state: 'connecting', expiresAt: new Date(Date.now() + 60000) } });
      if (!changed) throw new Error();
      clearTimeout(timers.get(callId));
      timers.delete(callId);
      emitUser(call.caller, 'call:answered', { callId });
      socket.emit('call:answered', { callId });
    });
    for (const [event, reason] of [['call:reject', 'rejected'], ['call:cancel', 'cancelled'], ['call:end', 'completed']]) on(event, async ({ callId }) => {
      const call = await activeCall(callId);
      if (event === 'call:reject' && (String(call.recipient) !== uid || !['ringing', 'connecting'].includes(call.state))) throw new Error();
      if (event === 'call:cancel' && (String(call.caller) !== uid || call.state !== 'ringing')) throw new Error();
      await finish(call, reason);
    });
    on('call:offer', async ({ callId, sdp }) => {
      const call = await activeCall(callId);
      if (String(call.caller) !== uid || call.state !== 'connecting' || sdp?.type !== 'offer' || typeof sdp.sdp !== 'string' || sdp.sdp.length > 65536) throw new Error();
      emitUser(call.recipient, 'call:offer', { callId, sdp });
    });
    on('call:answer_sdp', async ({ callId, sdp }) => {
      const call = await activeCall(callId);
      if (String(call.recipient) !== uid || call.state !== 'connecting' || sdp?.type !== 'answer' || typeof sdp.sdp !== 'string' || sdp.sdp.length > 65536) throw new Error();
      emitUser(call.caller, 'call:answer_sdp', { callId, sdp });
    });
    on('call:connected', async ({ callId }) => {
      await activeCall(callId);
      await Call.findOneAndUpdate({ _id: callId, state: 'connecting' }, { $set: { state: 'connected', answeredAt: new Date(), expiresAt: new Date(Date.now() + 30000) } });
    });
    on('call:heartbeat', async ({ callId }) => {
      await activeCall(callId);
      await Call.updateOne({ _id: callId, state: 'connected' }, { $set: { expiresAt: new Date(Date.now() + 30000) } });
    });
    on('call:ice', async ({ callId, candidate }) => {
      const call = await activeCall(callId);
      if (!['connecting', 'connected'].includes(call.state) || !candidate || JSON.stringify(candidate).length > 8192) throw new Error();
      emitUser(String(call.caller) === uid ? call.recipient : call.caller, 'call:ice', { callId, candidate });
    });
    // No client-supplied coordinate relay. Authorized REST writes emit to the recipient.
    socket.on('disconnect', () => {
      clearTimeout(expiryTimer);
      for (const timer of typing.values()) clearTimeout(timer);
      users.get(uid)?.delete(socket.id);
      if (users.get(uid)?.size) return;
      users.delete(uid);
      presence(uid, false).catch(() => {});
      Call.find({ state: { $ne: 'ended' }, $or: [{ caller: uid }, { recipient: uid }] })
        .then(calls => Promise.all(calls.map(call => finish(call, 'network_error')))).catch(() => {});
    });
  });
};
