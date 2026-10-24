const express = require('express');
const mongoose = require('mongoose');
const fs = require('fs/promises');
const auth = require('../middleware/auth');
const wrap = require('../utils/asyncHandler');
const upload = require('../utils/upload');
const { mediaAuth, privatePath } = require('../utils/media');
const { assertView, blocked, blockedIds, visibleAuthors, fail } = require('../utils/privacy');
const Story = require('../models/Story');
const StoryView = require('../models/StoryView');
const Space = require('../models/Space');
const SpaceItem = require('../models/SpaceItem');
const SpaceComment = require('../models/SpaceComment');
const User = require('../models/User');
const router = express.Router();
const id = value => { if (typeof value !== 'string' || !mongoose.isValidObjectId(value)) throw fail('Invalid ID.', 400); return value; };
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const privateUpload = (req, res, next) => { req.privateAttachment = true; next(); };
async function storyAccess(storyId, user) {
  const story = await Story.findById(id(storyId)); if (!story) throw fail('Story not found.', 404);
  if (story.expiresAt <= new Date()) throw fail('Story expired.', 410);
  await assertView(story.owner, user._id);
  const owner = await User.findById(story.owner).select('privacy');
  if (String(story.owner) !== user.id && (story.audience === 'followers' || owner.privacy?.stories === 'followers') && !await require('../models/Follow').exists({ follower: user._id, following: story.owner })) throw fail();
  return story;
}
async function spaceAccess(spaceId, user, write = false) {
  const space = await Space.findById(id(spaceId)); if (!space) throw fail('Space not found.', 404);
  const owner = String(space.owner) === user.id;
  const role = space.members.find(m => String(m.user) === user.id)?.role;
  if (!owner && (!role || await blocked(space.owner, user._id))) throw fail('Membership is required.');
  if (write && !owner && role === 'viewer') throw fail('This album is view-only for your account.');
  return { space, owner, role };
}
router.get('/stories', auth, wrap(async (req, res) => {
  const authors = await visibleAuthors(req.user._id);
  const follows = await require('../models/Follow').find({ follower: req.user._id }).distinct('following');
  const followed = new Set(follows.map(String));
  const stories = await Story.find({ owner: { $in: authors }, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).limit(60).populate('owner', 'username name avatarUrl privacy.stories');
  const visible = stories.filter(s => String(s.owner._id) === req.user.id || s.audience !== 'followers' && s.owner.privacy?.stories !== 'followers' || followed.has(String(s.owner._id)));
  res.json({ stories: visible.map(s => ({ _id: s._id, owner: { _id: s.owner._id, username: s.owner.username, name: s.owner.name, avatarUrl: s.owner.avatarUrl }, text: s.text, sticker: s.sticker, createdAt: s.createdAt, expiresAt: s.expiresAt, audience: s.audience, imageUrl: `/api/stories/${s._id}/media` })) });
}));
router.post('/stories', auth, privateUpload, upload.single('image'), wrap(async (req, res) => {
  if (!req.file) throw fail('Choose a photo.', 400);
  try {
    const audience = req.body.audience || req.user.privacy?.stories || 'public'; if (!['public', 'followers'].includes(audience)) throw fail('Invalid audience.', 400);
    const story = await Story.create({ owner: req.user._id, filename: req.file.filename, text: text(req.body.text, 500), sticker: ['✨', '☀️', '❤️', '📍', ''].includes(req.body.sticker || '') ? req.body.sticker || '' : '', audience, expiresAt: new Date(Date.now() + 86400000) });
    res.status(201).json({ story: { _id: story._id, expiresAt: story.expiresAt } });
  } catch (error) { await fs.unlink(req.file.path).catch(() => {}); throw error; }
}));
router.get('/stories/:id/media', mediaAuth, wrap(async (req, res) => { const story = await storyAccess(req.params.id, req.user); res.set('Cache-Control', 'private, no-store'); res.sendFile(privatePath(story.filename)); }));
router.post('/stories/:id/view', auth, wrap(async (req, res) => {
  const story = await storyAccess(req.params.id, req.user);
  const update = {}; if (req.body.reaction !== undefined) { if (!['', '❤️', '✨', '👏'].includes(req.body.reaction)) throw fail('Invalid reaction.', 400); update.reaction = req.body.reaction; }
  await StoryView.updateOne({ story: story._id, viewer: req.user._id }, { $set: update }, { upsert: true }); res.json({ ok: true });
}));
router.get('/stories/:id/viewers', auth, wrap(async (req, res) => { const story = await Story.findById(id(req.params.id)); if (!story || String(story.owner) !== req.user.id) throw fail(); res.json({ views: await StoryView.find({ story: story._id }).sort({ _id: -1 }).limit(100).populate('viewer', 'username name avatarUrl'), count: await StoryView.countDocuments({ story: story._id }) }); }));
router.delete('/stories/:id', auth, wrap(async (req, res) => { const story = await Story.findOne({ _id: id(req.params.id), owner: req.user._id }); if (!story) throw fail(); await story.deleteOne(); await fs.unlink(privatePath(story.filename)).catch(() => {}); await StoryView.deleteMany({ story: story._id }); res.json({ ok: true }); }));
router.get('/spaces', auth, wrap(async (req, res) => { const spaces = await Space.find({ $or: [{ owner: req.user._id }, { 'members.user': req.user._id }] }).sort({ updatedAt: -1 }).limit(50).select('-members').populate('owner', 'username name'); res.json({ spaces }); }));
router.post('/spaces', auth, wrap(async (req, res) => {
  const name = text(req.body.name, 80); if (!name || !['circle', 'album'].includes(req.body.kind)) throw fail('Choose a name and type.', 400);
  res.status(201).json({ space: await Space.create({ owner: req.user._id, kind: req.body.kind, name, description: text(req.body.description, 500) }) });
}));
router.get('/spaces/:id', auth, wrap(async (req, res) => {
  const { space, owner, role } = await spaceAccess(req.params.id, req.user); await space.populate('members.user', 'username name avatarUrl'); await space.populate('owner', 'username name');
  const filter = { space: space._id, author: { $nin: await blockedIds(req.user._id) } }; if (req.query.before) filter._id = { $lt: id(req.query.before) };
  const items = await SpaceItem.find(filter).sort(space.kind === 'album' ? { _id: -1 } : { _id: -1 }).limit(30).populate('author', 'username name avatarUrl');
  res.json({ space, isOwner: owner, canManage: owner || role === 'moderator', canUpload: owner || role !== 'viewer', items: items.map(item => ({ ...item.toObject(), filename: undefined, imageUrl: `/api/spaces/${space._id}/items/${item._id}/media` })), hasMore: items.length === 30, nextCursor: items.at(-1)?._id });
}));
router.post('/spaces/:id/members', auth, wrap(async (req, res) => {
  const { space, owner, role } = await spaceAccess(req.params.id, req.user);
  if (!owner && role !== 'moderator') throw fail();
  const username = text(req.body.username, 24).toLowerCase(); const user = await User.findOne({ username }); if (!user) throw fail('User not found.', 404);
  if (String(space.owner) === user.id) throw fail('Owner is already a member.', 400);
  await require('../utils/contact').assertContact(req.user._id, user._id);
  const newRole = req.body.role || 'contributor'; if (!['contributor', 'viewer', 'moderator'].includes(newRole) || newRole === 'moderator' && !owner) throw fail('Invalid role.', 400);
  if (!owner && space.members.some(m => String(m.user) === user.id && m.role === 'moderator')) throw fail();
  const result = await Space.updateOne({ _id: space._id, $or: [{ 'members.user': user._id }, { $expr: { $lt: [{ $size: '$members' }, 50] } }] }, [{ $set: { members: { $concatArrays: [{ $filter: { input: '$members', as: 'member', cond: { $ne: ['$$member.user', user._id] } } }, [{ user: user._id, role: newRole }]] } } }]);
  if (!result.matchedCount) throw fail('Membership limit reached.', 400);
  res.json({ ok: true });
}));
router.delete('/spaces/:id/members/:userId', auth, wrap(async (req, res) => {
  const { space, owner, role } = await spaceAccess(req.params.id, req.user); const target = id(req.params.userId);
  if (target === String(space.owner)) throw fail('Owner cannot leave. Delete the space instead.', 400);
  if (target !== req.user.id && !owner && (role !== 'moderator' || space.members.find(m => String(m.user) === target)?.role === 'moderator')) throw fail();
  await Space.updateOne({ _id: space._id }, { $pull: { members: { user: target } } }); res.json({ ok: true });
}));
router.post('/spaces/:id/items', auth, wrap(async (req, res, next) => { await spaceAccess(req.params.id, req.user, true); req.privateAttachment = true; next(); }), upload.single('image'), wrap(async (req, res) => {
  if (!req.file) throw fail('Choose a photo.', 400);
  try { const { space } = await spaceAccess(req.params.id, req.user, true); const item = await SpaceItem.create({ space: space._id, author: req.user._id, filename: req.file.filename, caption: text(req.body.caption, 2200) }); res.status(201).json({ item: { _id: item._id } }); }
  catch (error) { await fs.unlink(req.file.path).catch(() => {}); throw error; }
}));
router.get('/spaces/:id/items/:itemId/media', mediaAuth, wrap(async (req, res) => { await spaceAccess(req.params.id, req.user); const item = await SpaceItem.findOne({ _id: id(req.params.itemId), space: req.params.id }); if (!item) throw fail('Photo not found.', 404); if (String(item.author) !== req.user.id && await blocked(item.author, req.user._id)) throw fail(); res.set('Cache-Control', 'private, no-store'); res.sendFile(privatePath(item.filename)); }));
router.delete('/spaces/:id/items/:itemId', auth, wrap(async (req, res) => {
  const { space, owner, role } = await spaceAccess(req.params.id, req.user); const item = await SpaceItem.findOne({ _id: id(req.params.itemId), space: space._id }); if (!item) throw fail('Photo not found.', 404);
  if (!owner && role !== 'moderator' && String(item.author) !== req.user.id) throw fail();
  await item.deleteOne(); await SpaceComment.deleteMany({ item: item._id }); await fs.unlink(privatePath(item.filename)).catch(() => {}); res.json({ ok: true });
}));
router.get('/spaces/:id/items/:itemId/comments', auth, wrap(async (req, res) => { await spaceAccess(req.params.id, req.user); if (!await SpaceItem.exists({ _id: id(req.params.itemId), space: req.params.id })) throw fail('Photo not found.', 404); res.json({ comments: await SpaceComment.find({ item: req.params.itemId, space: req.params.id, author: { $nin: await blockedIds(req.user._id) } }).sort({ createdAt: 1 }).limit(100).populate('author', 'username name') }); }));
router.post('/spaces/:id/items/:itemId/comments', auth, wrap(async (req, res) => { await spaceAccess(req.params.id, req.user, true); if (!await SpaceItem.exists({ _id: id(req.params.itemId), space: req.params.id })) throw fail('Photo not found.', 404); const content = text(req.body.text, 500); if (!content) throw fail('Write a comment.', 400); res.status(201).json({ comment: await SpaceComment.create({ space: req.params.id, item: req.params.itemId, author: req.user._id, text: content }) }); }));
router.delete('/spaces/:id', auth, wrap(async (req, res) => {
  const { space, owner } = await spaceAccess(req.params.id, req.user); if (!owner) throw fail();
  // Delete authorization first; remaining file cleanup can safely be retried by maintenance.
  await space.deleteOne();
  const items = await SpaceItem.find({ space: space._id }).select('filename');
  for (const item of items) await fs.unlink(privatePath(item.filename)).catch(() => {});
  await SpaceItem.deleteMany({ space: space._id }); await SpaceComment.deleteMany({ space: space._id }); res.json({ ok: true });
}));
async function cleanupStories() {
  const expired = await Story.find({ expiresAt: { $lte: new Date() } }).limit(100);
  for (const story of expired) { await fs.unlink(privatePath(story.filename)).catch(() => {}); await StoryView.deleteMany({ story: story._id }); await Story.deleteOne({ _id: story._id }); }
}
router.get('/spaces/:id/discussion', auth, wrap(async (req, res) => {
  const { space } = await spaceAccess(req.params.id, req.user); if (space.kind !== 'circle') throw fail('Discussions belong to Circles.', 400);
  const filter = { space: space._id, item: { $exists: false }, author: { $nin: await blockedIds(req.user._id) } }; if (req.query.before) filter._id = { $lt: id(req.query.before) };
  const messages = await SpaceComment.find(filter).sort({ _id: -1 }).limit(30).populate('author', 'username name avatarUrl');
  res.json({ messages: messages.reverse(), hasMore: messages.length === 30, nextCursor: messages[0]?._id });
}));
router.post('/spaces/:id/discussion', auth, wrap(async (req, res) => {
  const { space } = await spaceAccess(req.params.id, req.user, true); if (space.kind !== 'circle') throw fail('Discussions belong to Circles.', 400);
  const content = text(req.body.text, 2000); if (!content || typeof req.body.idempotencyKey !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(req.body.idempotencyKey)) throw fail('Text and a retry key are required.', 400);
  let message; try { message = await SpaceComment.create({ space: space._id, author: req.user._id, text: content, idempotencyKey: req.body.idempotencyKey }); }
  catch (error) { if (error.code !== 11000) throw error; message = await SpaceComment.findOne({ space: space._id, author: req.user._id, idempotencyKey: req.body.idempotencyKey }); return res.json({ message, duplicate: true }); }
  for (const member of [space.owner, ...space.members.map(m => m.user)]) if (String(member) === String(space.owner) || !await blocked(space.owner, member)) req.app.get('io')?.to(`user:${member}`).emit('space:changed', { spaceId: String(space._id) });
  await message.populate('author', 'username name avatarUrl'); res.status(201).json({ message });
}));
module.exports = router;
module.exports.cleanupStories = cleanupStories;
