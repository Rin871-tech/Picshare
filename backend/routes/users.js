const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Post = require('../models/Post');
const Follow = require('../models/Follow');
const Comment = require('../models/Comment');
const auth = require('../middleware/auth');
const upload = require('../utils/upload');
const asyncHandler = require('../utils/asyncHandler');
const router = express.Router();

router.get('/search', auth, asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').normalize('NFKC').trim().slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!q) return res.json({ users: [] });
  const users = await User.find({ $or: [{ username: { $regex: q, $options: 'i' } }, { name: { $regex: q, $options: 'i' } }] }).limit(12);
  const followed = await Follow.find({ follower: req.user._id, following: { $in: users.map(u => u._id) } }).select('following');
  const ids = new Set(followed.map(f => String(f.following)));
  res.json({ users: await Promise.all(users.map(async u => ({ ...u.toJSON(), isFollowing: ids.has(String(u._id)), isMe: String(u._id) === String(req.user._id), followersCount: await Follow.countDocuments({ following: u._id }) }))) });
}));
router.get('/me', auth, asyncHandler(async (req, res) => {
  const [followersCount, followingCount, postsCount] = await Promise.all([Follow.countDocuments({ following: req.user._id }), Follow.countDocuments({ follower: req.user._id }), Post.countDocuments({ author: req.user._id })]);
  res.json({ user: req.user.toJSON(), stats: { followersCount, followingCount, postsCount } });
}));
router.patch('/me', auth, asyncHandler(async (req, res) => {
  const { name, bio, username, currentPassword, newPassword } = req.body || {};
  if (name !== undefined) { if (!String(name).trim() || String(name).trim().length > 60) return res.status(400).json({ error: 'Name must be 1–60 characters.' }); req.user.name = String(name).trim(); }
  if (bio !== undefined) { if (String(bio).length > 160) return res.status(400).json({ error: 'Bio must be 160 characters or fewer.' }); req.user.bio = String(bio); }
  if (username !== undefined) { const value = String(username).trim().toLowerCase(); if (!/^[a-z0-9_.]{3,24}$/.test(value)) return res.status(400).json({ error: 'Username must be 3–24 characters using letters, numbers, dots, or underscores.' }); req.user.username = value; }
  if (newPassword) {
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 72) return res.status(400).json({ error: 'Password must be 8–72 characters.' });
    const fullUser = await User.findById(req.user._id).select('+passwordHash');
    if (fullUser.passwordHash) {
      if (typeof currentPassword !== 'string' || !(await bcrypt.compare(currentPassword, fullUser.passwordHash))) {
        return res.status(400).json({ error: 'Current password is incorrect.' });
      }
    }
    req.user.passwordHash = await bcrypt.hash(newPassword, 12);
  }

  await req.user.save();
  res.json({ user: req.user.toJSON() });
}));
router.post('/me/avatar', auth, upload.single('image'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an image first.' });
  req.user.avatarUrl = `/uploads/${req.file.filename}`;
  await req.user.save();
  res.json({ user: req.user.toJSON() });
}));
router.get('/:id', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid user id.' });
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  await require('../utils/privacy').assertView(user._id, req.user._id);
  const [followersCount, followingCount, posts, isFollowing, postsCount] = await Promise.all([
    Follow.countDocuments({ following: user._id }), Follow.countDocuments({ follower: user._id }),
    Post.find({ author: user._id }).sort({ createdAt: -1 }).limit(60).populate('author', 'username name avatarUrl'),
    Follow.exists({ follower: req.user._id, following: user._id }), Post.countDocuments({ author: user._id })
  ]);
  const pinnedPhotos = await Post.find({ author: user._id, _id: { $in: user.pinnedPosts || [] } }).populate('author', 'username name avatarUrl');
  for (const pinned of pinnedPhotos) if (!posts.some(p => p.id === pinned.id)) posts.unshift(pinned);
  const pins = new Set((user.pinnedPosts || []).map(String));
  posts.sort((a, b) => Number(pins.has(b.id)) - Number(pins.has(a.id)) || b.createdAt - a.createdAt);
  posts.splice(60);
  const questCount = await require('../models/Entry').countDocuments({ user: user._id });
  const postIds = posts.map(p => p._id);
  const commentCounts = await Comment.aggregate([{ $match: { post: { $in: postIds } } }, { $group: { _id: '$post', count: { $sum: 1 } } }]);
  const countMap = new Map(commentCounts.map(c => [String(c._id), c.count]));
  res.json({ user: user.toJSON(), stats: { followersCount, followingCount, postsCount, questCount }, isFollowing: Boolean(isFollowing), isMe: String(user._id) === String(req.user._id), posts: posts.map(p => ({ ...p.toObject(), likesCount: p.likes.length, isLiked: p.likes.some(id => String(id) === String(req.user._id)), commentsCount: countMap.get(String(p._id)) || 0 })) });
}));
router.post('/:id/follow', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid user id.' });
  if (String(req.user._id) === req.params.id) return res.status(400).json({ error: 'You cannot follow yourself.' });
  await require('../utils/privacy').assertView(req.params.id, req.user._id);
  const target = await User.findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  const existing = await Follow.findOne({ follower: req.user._id, following: target._id });
  if (existing) { await existing.deleteOne(); return res.json({ following: false }); }
  await Follow.create({ follower: req.user._id, following: target._id });
  res.json({ following: true });
}));
router.post('/:id/block', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id) || req.params.id === String(req.user._id)) return res.sendStatus(400);
  if (!await User.exists({ _id: req.params.id })) return res.sendStatus(404);
  const Block = require('../models/Block');
  await Block.updateOne({ owner: req.user._id, target: req.params.id }, { $setOnInsert: { owner: req.user._id, target: req.params.id } }, { upsert: true });
  const LocationSession = require('../models/LocationSession');
  const sessions = await LocationSession.find({ active: true, $or: [{ owner: req.user._id, recipient: req.params.id }, { owner: req.params.id, recipient: req.user._id }] });
  for (const session of sessions) {
    await LocationSession.updateOne({ _id: session._id }, { $set: { active: false, revokedAt: new Date() }, $unset: { lat: 1, lng: 1, accuracy: 1 } });
    for (const id of [session.owner, session.recipient]) req.app.get('io')?.to(`user:${id}`).emit('location:ended', { sessionId: String(session._id) });
  }
  const Call = require('../models/Call');
  const calls = await Call.find({ state: { $ne: 'ended' }, $or: [{ caller: req.user._id, recipient: req.params.id }, { caller: req.params.id, recipient: req.user._id }] });
  for (const call of calls) {
    await Call.updateOne({ _id: call._id }, { $set: { state: 'ended', endReason: 'cancelled', endedAt: new Date() }, $unset: { expiresAt: 1 } });
    for (const id of [call.caller, call.recipient]) req.app.get('io')?.to(`user:${id}`).emit('call:ended', { callId: String(call._id), reason: 'cancelled' });
  }
  res.json({ blocked: true });
}));
router.delete('/:id/block', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(400);
  await require('../models/Block').deleteOne({ owner: req.user._id, target: req.params.id });
  res.json({ blocked: false });
}));
module.exports = router;
