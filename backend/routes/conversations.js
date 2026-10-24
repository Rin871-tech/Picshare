/**
 * Conversations REST API
 * All routes require JWT authentication via middleware/auth.js
 */
const express = require('express');
const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const User = require('../models/User');
const auth = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const router = express.Router();
const { assertContact } = require('../utils/contact');
const LocationSession = require('../models/LocationSession');
const Post = require('../models/Post');
const Notification = require('../models/Notification');
const Attachment = require('../models/Attachment');
const upload = require('../utils/upload');

// ─── helpers ────────────────────────────────────────────────────────────────

/** Build canonical sorted participant key for dedup */
function makeKey(a, b) {
  const ids = [String(a), String(b)].sort();
  return ids.join('_');
}

/** Verify caller is a conversation participant */
function assertParticipant(conversation, userId) {
  const ids = conversation.participants.map(String);
  if (!ids.includes(String(userId))) {
    const err = new Error('Access denied.');
    err.status = 403;
    throw err;
  }
}

// ─── routes ─────────────────────────────────────────────────────────────────

/**
 * GET /api/conversations
 * Return authenticated user's inbox, sorted by most recently updated.
 */
router.get('/', auth, asyncHandler(async (req, res) => {
  const conversations = await Conversation.find({ participants: req.user._id })
    .sort({ updatedAt: -1 })
    .limit(50)
    .populate('participants', 'username name avatarUrl');

  const result = await Promise.all(conversations.map(async c => {
    const other = c.participants.find(p => String(p._id) !== String(req.user._id));
    const unreadCount = await Message.countDocuments({ conversation: c._id, sender: { $ne: req.user._id }, deleted: false, [`readBy.${req.user._id}`]: { $exists: false } });
    const latest = await Message.findOne({ conversation: c._id }).sort({ createdAt: -1, _id: -1 });
    return {
      _id: c._id,
      preferences: c.preferences?.get(String(req.user._id)) || {},
      participant: other,
      lastMessage: latest ? { text: latest.deleted ? 'Message deleted' : latest.text || `[${latest.type}]`, type: latest.type, sender: latest.sender, at: latest.createdAt } : c.lastMessage,
      unreadCount,
      updatedAt: c.updatedAt
    };
  }));

  result.sort((a, b) => Number(Boolean(b.preferences?.pinned)) - Number(Boolean(a.preferences?.pinned)) || new Date(b.lastMessage?.at || b.updatedAt) - new Date(a.lastMessage?.at || a.updatedAt));
  res.json({ conversations: result });
}));

/**
 * POST /api/conversations
 * Start or retrieve a DM conversation with another user.
 * Body: { recipientId }
 */
router.post('/', auth, asyncHandler(async (req, res) => {
  const recipientId = String(req.body?.recipientId || '').trim();
  if (!recipientId || !mongoose.isValidObjectId(recipientId)) {
    return res.status(400).json({ error: 'Invalid recipientId.' });
  }
  if (recipientId === String(req.user._id)) {
    return res.status(400).json({ error: 'You cannot message yourself.' });
  }

  const recipient = await User.findById(recipientId);
  if (!recipient) return res.status(404).json({ error: 'User not found.' });

  await assertContact(req.user._id, recipientId);
  const key = makeKey(req.user._id, recipientId);

  // findOneAndUpdate with upsert ensures atomicity
  const conversation = await Conversation.findOneAndUpdate(
    { participantKey: key },
    {
      $setOnInsert: {
        participants: [req.user._id, recipient._id].sort((a, b) => String(a).localeCompare(String(b))),
        participantKey: key
      }
    },
    { upsert: true, new: true }
  );

  await conversation.populate('participants', 'username name avatarUrl');

  const other = conversation.participants.find(p => String(p._id) !== String(req.user._id));
  res.status(201).json({
    conversation: {
      _id: conversation._id,
      participant: other,
      lastMessage: conversation.lastMessage,
      unreadCount: conversation.unread?.get(String(req.user._id)) || 0,
      updatedAt: conversation.updatedAt
    }
  });
}));

/**
 * GET /api/conversations/:id/messages?before=<cursor>&limit=30
 * Paginated message history (cursor-based, newest first).
 */
router.get('/:id/messages', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid conversation id.' });
  }

  const conversation = await Conversation.findById(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
  assertParticipant(conversation, req.user._id);

  const limit = Math.max(1, Math.min(50, Number.parseInt(req.query.limit, 10) || 30));
  const query = { conversation: conversation._id };

  const cursorId = req.query.after || req.query.before;
  if (cursorId) {
    if (!mongoose.isValidObjectId(cursorId)) return res.status(400).json({ error: 'Invalid cursor.' });
    const cursor = await Message.findOne({ _id: cursorId, conversation: conversation._id });
    if (!cursor) return res.status(400).json({ error: 'Cursor is not in this conversation.' });
    const op = req.query.after ? '$gt' : '$lt';
    query.$or = [{ createdAt: { [op]: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { [op]: cursor._id } }];
  }

  const messages = await Message.find(query)
    .sort(req.query.after ? { createdAt: 1, _id: 1 } : { createdAt: -1, _id: -1 })
    .limit(limit)
    .populate('sender', 'username name avatarUrl')
    .populate({ path: 'replyTo', select: 'text sender type', match: { conversation: conversation._id } }).populate('postRef', 'caption imageUrl author');

  for (const message of messages) if (message.postRef?.author && !await require('../utils/privacy').canView(message.postRef.author, req.user._id)) message.postRef = null;
  res.json({
    messages: req.query.after ? messages : messages.reverse(), // return chronological order
    hasMore: messages.length === limit
  });
}));

/**
 * POST /api/conversations/:id/messages
 * Persist a message. Validates participant membership server-side.
 * Body: { type, text?, imageUrl?, postRef?, location?, idempotencyKey?, replyTo? }
 */
router.post('/:id/messages', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid conversation id.' });
  }

  const conversation = await Conversation.findById(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
  assertParticipant(conversation, req.user._id);

  await assertContact(req.user._id, conversation.participants.find(p => String(p) !== String(req.user._id)));

  const {
    type = 'text',
    text,
    imageUrl,
    postRef,
    location,
    idempotencyKey,
    replyTo
  } = req.body || {};

  const allowedTypes = ['text', 'image', 'post_share', 'location', 'live_location'];
  if (!allowedTypes.includes(type)) {
    return res.status(400).json({ error: 'Invalid message type.' });
  }

  if (type === 'text' && (!text || !String(text).trim())) {
    return res.status(400).json({ error: 'Message text cannot be empty.' });
  }

  const sanitizedText = text ? String(text).trim().slice(0, 4000) : '';

  // Build message doc
  const msgData = {
    conversation: conversation._id,
    sender: req.user._id,
    type,
    text: sanitizedText
  };

  if (idempotencyKey && typeof idempotencyKey === 'string') {
    msgData.idempotencyKey = idempotencyKey.slice(0, 64);
  }
  if (imageUrl && type === 'image') msgData.imageUrl = String(imageUrl).slice(0, 500);
  if (postRef && mongoose.isValidObjectId(postRef) && type === 'post_share') msgData.postRef = postRef;
  if (location && type === 'location') {
    if (typeof location.lat !== 'number' || typeof location.lng !== 'number') return res.status(400).json({ error: 'Coordinates must be numbers.' });
    const lat = Number(location.lat);
    const lng = Number(location.lng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Invalid coordinates.' });
    }
    msgData.location = { lat, lng, sharedAt: new Date(), label: String(location.label || '').slice(0, 200) };
  }
  if (type === 'live_location') {
    const session = mongoose.isValidObjectId(location?.sessionId) && await LocationSession.findOne({
      _id: location.sessionId, owner: req.user._id, conversation: conversation._id, active: true, expiresAt: { $gt: new Date() }
    });
    if (!session) return res.status(400).json({ error: 'Invalid live location session.' });
    msgData.location = { sessionId: session._id };
  }
  if (type === 'image' && !new RegExp(`^/api/conversations/${conversation._id}/attachments/[a-f0-9-]+\\.(jpg|png|webp|gif)$`).test(msgData.imageUrl || '')) {
    return res.status(400).json({ error: 'Upload an image first.' });
  }
  if (type === 'image' && !await Attachment.exists({ conversation: conversation._id, owner: req.user._id, filename: msgData.imageUrl.split('/').at(-1) })) return res.status(400).json({ error: 'Image is not attached to this conversation.' });
  if (type === 'post_share' && (!msgData.postRef || !await Post.exists({ _id: msgData.postRef }))) {
    return res.status(400).json({ error: 'Post not found.' });
  }
  if (type === 'post_share') { const shared = await Post.findById(msgData.postRef); const recipient = conversation.participants.find(p => String(p) !== String(req.user._id)); await require('../utils/privacy').assertView(shared.author, recipient); }
  if (replyTo) {
    if (!mongoose.isValidObjectId(replyTo) || !await Message.exists({ _id: replyTo, conversation: conversation._id, deleted: false })) {
      return res.status(400).json({ error: 'Reply must reference a message in this conversation.' });
    }
    msgData.replyTo = replyTo;
  }
  if (typeof idempotencyKey !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(idempotencyKey)) {
    return res.status(400).json({ error: 'A valid idempotencyKey is required.' });
  }

  let message;
  try {
    message = await Message.create(msgData);
  } catch (err) {
    // Duplicate idempotency key → return existing message (idempotent retry)
    if (err.code === 11000 && idempotencyKey) {
      message = await Message.findOne({ conversation: conversation._id, sender: req.user._id, idempotencyKey: msgData.idempotencyKey });
      if (message) {
        await message.populate('sender', 'username name avatarUrl');
        return res.status(200).json({ message, duplicate: true });
      }
    }
    throw err;
  }

  // ── Update conversation last message & unread counts ──────────────────────
  const otherParticipants = conversation.participants.filter(p => String(p) !== String(req.user._id));
  const unreadUpdate = {};
  for (const pid of otherParticipants) {
    const key = String(pid);
    unreadUpdate[`unread.${key}`] = 1;
  }

  await Conversation.findByIdAndUpdate(conversation._id, {
    $set: {
      lastMessage: {
        text: sanitizedText || `[${type}]`,
        type,
        sender: req.user._id,
        at: message.createdAt
      }
    },
    $inc: unreadUpdate
  });

  await message.populate('sender', 'username name avatarUrl');
  if (message.replyTo) await message.populate('replyTo', 'text sender type');
  if (message.postRef) await message.populate('postRef', 'caption imageUrl author');

  for (const participant of conversation.participants) {
    if (String(participant) !== String(req.user._id)) await Notification.updateOne({ recipient: participant, message: message._id, type: 'new_message' }, { $setOnInsert: { fromUser: req.user._id, conversation: conversation._id, preview: 'New message' } }, { upsert: true });
    req.app.get('io')?.to(`user:${participant}`).emit('message:new', { message: require('../utils/media').decorateData(message, participant) });
  }
  res.status(201).json({ message });
}));

/**
 * PATCH /api/conversations/:id/read
 * Mark all messages in conversation as read for the requesting user.
 */
router.patch('/:id/read', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid conversation id.' });
  }

  const conversation = await Conversation.findById(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
  assertParticipant(conversation, req.user._id);

  const userKey = String(req.user._id);
  await Conversation.findByIdAndUpdate(conversation._id, {
    $set: { [`unread.${userKey}`]: 0 }
  });

  let through;
  if (req.body.through) {
    if (!mongoose.isValidObjectId(req.body.through)) return res.sendStatus(400);
    through = await Message.findOne({ _id: req.body.through, conversation: conversation._id });
    if (!through) return res.sendStatus(400);
  } else return res.status(400).json({ error: 'through message cursor is required.' });
  // Mark only messages through the last displayed message as read.
  await Message.updateMany(
    {
      conversation: conversation._id,
      sender: { $ne: req.user._id },
      deliveryState: { $ne: 'read' },
      $or: [{ createdAt: { $lt: through.createdAt } }, { createdAt: through.createdAt, _id: { $lte: through._id } }]
    },
    {
      $set: {
        deliveryState: 'read',
        [`readBy.${userKey}`]: new Date()
      }
    }
  );

  req.app.get('io')?.to(`conv:${conversation._id}`).emit('conversation:read', { conversationId: String(conversation._id), readBy: userKey, through: String(through._id), at: through.createdAt });
  res.json({ ok: true });
}));

/**
 * DELETE /api/messages/:messageId
 * Soft-delete own message.
 */
router.delete('/messages/:messageId', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.messageId)) {
    return res.status(400).json({ error: 'Invalid message id.' });
  }

  const message = await Message.findById(req.params.messageId);
  if (!message) return res.status(404).json({ error: 'Message not found.' });
  if (String(message.sender) !== String(req.user._id)) {
    return res.status(403).json({ error: 'You can only delete your own messages.' });
  }

  // Verify participant in conversation
  const conversation = await Conversation.findById(message.conversation);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
  assertParticipant(conversation, req.user._id);

  message.deleted = true;
  message.deletedAt = new Date();
  message.text = '';
  message.imageUrl = '';
  message.location = undefined;
  message.replyTo = undefined;
  message.postRef = undefined;
  message.reactions = {};
  await message.save();
  req.app.get('io')?.to(`conv:${conversation._id}`).emit('message:changed', { message });
  res.json({ ok: true });
}));

router.post('/:id/attachments', auth, asyncHandler(async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid conversation.' });
  const conversation = await Conversation.findById(req.params.id);
  if (!conversation) return res.sendStatus(404);
  assertParticipant(conversation, req.user._id);
  await assertContact(req.user._id, conversation.participants.find(p => String(p) !== String(req.user._id)));
  req.privateAttachment = true;
  next();
}), upload.single('image'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an image.' });
  await Attachment.create({ owner: req.user._id, conversation: req.params.id, filename: req.file.filename });
  res.status(201).json({ imageUrl: `/api/conversations/${req.params.id}/attachments/${req.file.filename}` });
}));

router.get('/:id/attachments/:file', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id) || !/^[a-f0-9-]+\.(jpg|png|webp|gif)$/.test(req.params.file)) return res.sendStatus(400);
  const conversation = await Conversation.findById(req.params.id);
  if (!conversation) return res.sendStatus(404);
  assertParticipant(conversation, req.user._id);
  if (!await Attachment.exists({ conversation: conversation._id, filename: req.params.file })) return res.sendStatus(404);
  const path = require('path');
  const root = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
  res.set('Cache-Control', 'private, no-store');
  res.sendFile(path.join(root, '..', path.basename(root) + '-private', req.params.file));
}));

router.patch('/messages/:messageId' , auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.messageId)) return res.sendStatus(400);
  const message = await Message.findById(req.params.messageId);
  if (!message || message.deleted) return res.sendStatus(404);
  const conversation = await Conversation.findById(message.conversation);
  if (!conversation) return res.sendStatus(404);
  assertParticipant(conversation, req.user._id);
  await assertContact(req.user._id, conversation.participants.find(p => String(p) !== String(req.user._id)));
  if (req.body.reaction !== undefined) {
    const reaction = req.body.reaction;
    if (!['', '❤️', '👍', '😂', '😮', '😢'].includes(reaction)) return res.sendStatus(400);
    if (reaction) message.reactions.set(String(req.user._id), reaction);
    else message.reactions.delete(String(req.user._id));
  } else {
    if (String(message.sender) !== String(req.user._id)) return res.sendStatus(403);
    if (message.type !== 'text' || typeof req.body.text !== 'string' || !req.body.text.trim() || req.body.text.length > 4000) return res.sendStatus(400);
    message.text = req.body.text.trim();
    message.edited = true;
    message.editedAt = new Date();
  }
  await message.save();
  await message.populate('sender', 'username name avatarUrl');
  req.app.get('io')?.to(`conv:${conversation._id}`).emit('message:changed', { message });
  res.json({ message });
}));
router.patch('/:id/preferences', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(400);
  const conversation = await Conversation.findById(req.params.id); if (!conversation) return res.sendStatus(404);
  assertParticipant(conversation, req.user._id);
  const update = {};
  for (const key of ['pinned', 'muted']) if (req.body[key] !== undefined) { if (typeof req.body[key] !== 'boolean') return res.sendStatus(400); update[`preferences.${req.user._id}.${key}`] = req.body[key]; }
  await Conversation.updateOne({ _id: conversation._id }, { $set: update }); res.json({ ok: true });
}));
router.get('/:id/calls', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(400);
  const conversation = await Conversation.findById(req.params.id); if (!conversation) return res.sendStatus(404);
  assertParticipant(conversation, req.user._id);
  const filter = { conversation: conversation._id }; if (req.query.before) { if (!mongoose.isValidObjectId(req.query.before)) return res.sendStatus(400); filter._id = { $lt: req.query.before }; }
  const calls = await require('../models/Call').find(filter).sort({ _id: -1 }).limit(30);
  res.json({ calls, hasMore: calls.length === 30, nextCursor: calls.at(-1)?._id });
}));
router.post('/:id/messages/state', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(400);
  const conversation = await Conversation.findById(req.params.id); if (!conversation) return res.sendStatus(404);
  assertParticipant(conversation, req.user._id);
  if (!Array.isArray(req.body.ids) || req.body.ids.length > 50 || req.body.ids.some(id => typeof id !== 'string' || !mongoose.isValidObjectId(id))) return res.sendStatus(400);
  const messages = await Message.find({ conversation: conversation._id, _id: { $in: req.body.ids } }).populate('sender', 'username name avatarUrl').populate({ path: 'replyTo', select: 'text sender type', match: { conversation: conversation._id } }).populate('postRef', 'caption imageUrl author');
  for (const message of messages) if (message.postRef?.author && !await require('../utils/privacy').canView(message.postRef.author, req.user._id)) message.postRef = null;
  res.json({ messages });
}));
router.post('/messages/:messageId/forward', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.messageId) || !mongoose.isValidObjectId(req.body.conversationId) || typeof req.body.idempotencyKey !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(req.body.idempotencyKey)) return res.sendStatus(400);
  const original = await Message.findById(req.params.messageId); if (!original || original.deleted || original.type !== 'text') return res.status(400).json({ error: 'Only existing text messages can be forwarded.' });
  const source = await Conversation.findById(original.conversation); if (!source) return res.sendStatus(404); assertParticipant(source, req.user._id);
  const destination = await Conversation.findById(req.body.conversationId); if (!destination) return res.sendStatus(404); assertParticipant(destination, req.user._id);
  const recipient = destination.participants.find(p => String(p) !== String(req.user._id)); await assertContact(req.user._id, recipient);
  let message;
  try { message = await Message.create({ conversation: destination._id, sender: req.user._id, type: 'text', text: original.text, idempotencyKey: req.body.idempotencyKey }); }
  catch (error) { if (error.code !== 11000) throw error; message = await Message.findOne({ conversation: destination._id, sender: req.user._id, idempotencyKey: req.body.idempotencyKey }); return res.json({ message, duplicate: true }); }
  await Conversation.updateOne({ _id: destination._id }, { $set: { lastMessage: { text: message.text, type: 'text', sender: req.user._id, at: message.createdAt } } });
  await message.populate('sender', 'username name avatarUrl');
  for (const participant of destination.participants) req.app.get('io')?.to(`user:${participant}`).emit('message:new', { message: require('../utils/media').decorateData(message, participant) });
  res.status(201).json({ message });
}));
module.exports = router;
