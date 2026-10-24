const express = require('express');
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const wrap = require('../utils/asyncHandler');
const User = require('../models/User');
const Post = require('../models/Post');
const Comment = require('../models/Comment');
const Bookmark = require('../models/Bookmark');
const Collection = require('../models/Collection');
const Challenge = require('../models/Challenge');
const Entry = require('../models/Entry');
const Vote = require('../models/Vote');
const Report = require('../models/Report');
const { assertView, visibleAuthors, fail } = require('../utils/privacy');
const router = express.Router();
const id = value => { if (typeof value !== 'string' || !mongoose.isValidObjectId(value)) throw fail('Invalid ID.', 400); return value; };
const text = (value, max) => typeof value === 'string' ? value.normalize('NFKC').trim().slice(0, max) : '';
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
router.use(auth);
async function serialize(posts, userId) {
  const counts = await Comment.aggregate([{ $match: { post: { $in: posts.map(p => p._id) } } }, { $group: { _id: '$post', count: { $sum: 1 } } }]);
  const bookmarks = await Bookmark.find({ user: userId, post: { $in: posts.map(p => p._id) } }).select('post');
  const saved = new Set(bookmarks.map(b => String(b.post)));
  return posts.map(p => ({ ...p.toObject(), likesCount: p.likes.length, isLiked: p.likes.some(u => String(u) === String(userId)), isBookmarked: saved.has(String(p._id)), commentsCount: counts.find(c => String(c._id) === String(p._id))?.count || 0 }));
}
router.get('/discover', wrap(async (req, res) => {
  const authors = await visibleAuthors(req.user._id, true);
  const filter = { author: { $in: authors } };
  const q = text(req.query.q, 80);
  if (q) filter.$or = ['caption', 'altText', 'tags'].map(field => ({ [field]: { $regex: escape(q), $options: 'i' } }));
  for (const field of ['category', 'mood']) if (req.query[field]) filter[field] = text(req.query[field], 40).toLowerCase();
  if (req.query.before) filter._id = { $lt: id(req.query.before) };
  let posts;
  if (req.query.mode === 'trending') {
    filter.createdAt = { $gte: new Date(Date.now() - 7 * 86400000) };
    // Unique likes plus distinct recent commenters; no client-supplied scores.
    const ranked = await Post.aggregate([{ $match: filter }, { $lookup: { from: 'comments', let: { postId: '$_id' }, pipeline: [{ $match: { $expr: { $eq: ['$post', '$$postId'] }, createdAt: { $gte: new Date(Date.now() - 7 * 86400000) } } }, { $group: { _id: '$author' } }], as: 'commenters' } }, { $addFields: { score: { $add: [{ $size: { $setUnion: ['$likes', []] } }, { $size: '$commenters' }] } } }, { $sort: { score: -1, createdAt: -1, _id: -1 } }, { $limit: 24 }, { $project: { _id: 1 } }]);
    const docs = await Post.find({ _id: { $in: ranked.map(p => p._id) } }).populate('author', 'username name avatarUrl');
    posts = ranked.map(r => docs.find(d => String(d._id) === String(r._id))).filter(Boolean);
    if (!posts.length) posts = await Post.find({ ...filter, createdAt: { $exists: true } }).sort({ _id: -1 }).limit(24).populate('author', 'username name avatarUrl');
  } else posts = await Post.find(filter).sort({ _id: -1 }).limit(24).populate('author', 'username name avatarUrl');
  const collections = await Collection.find({ visibility: 'public', owner: { $in: authors }, ...(q ? { name: { $regex: escape(q), $options: 'i' } } : {}) }).sort({ updatedAt: -1 }).limit(8).select('-posts').populate('owner', 'username name');
  const tags = await Post.aggregate([{ $match: { author: { $in: authors }, createdAt: { $gte: new Date(Date.now() - 30 * 86400000) } } }, { $unwind: '$tags' }, { $group: { _id: '$tags', count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 12 }]);
  res.json({ posts: await serialize(posts, req.user._id), collections, hashtags: tags, hasMore: posts.length === 24, nextCursor: posts.at(-1)?._id, ranking: 'Trending uses unique likes plus distinct commenters on posts from the last seven days; recency breaks ties. Search uses captions, hashtags and descriptions; semantic search is not configured.' });
}));
router.patch('/posts/:id', wrap(async (req, res) => {
  const post = await Post.findById(id(req.params.id));
  if (!post) throw fail('Post not found.', 404);
  if (String(post.author) !== req.user.id) throw fail();
  if (req.body.caption !== undefined) { if (typeof req.body.caption !== 'string' || req.body.caption.length > 2200) throw fail('Caption is too long.', 400); post.caption = req.body.caption.trim(); post.tags = [...new Set((post.caption.match(/#[\p{L}\p{N}_]+/gu) || []).map(t => t.toLowerCase()))].slice(0, 20); }
  for (const field of ['category', 'mood']) if (req.body[field] !== undefined) post[field] = text(req.body[field], 40).toLowerCase();
  if (req.body.altText !== undefined) post.altText = text(req.body.altText, 500);
  await post.save(); await post.populate('author', 'username name avatarUrl');
  res.json({ post: (await serialize([post], req.user._id))[0] });
}));
router.post('/posts/:id/bookmark', wrap(async (req, res) => {
  const post = await Post.findById(id(req.params.id)); if (!post) throw fail('Post not found.', 404); await assertView(post.author, req.user._id);
  if (req.body.saved === false) await Bookmark.deleteOne({ user: req.user._id, post: post._id });
  else await Bookmark.updateOne({ user: req.user._id, post: post._id }, { $setOnInsert: { user: req.user._id, post: post._id } }, { upsert: true });
  res.json({ saved: req.body.saved !== false });
}));
router.get('/bookmarks', wrap(async (req, res) => {
  const filter = { user: req.user._id }; if (req.query.before) filter._id = { $lt: id(req.query.before) };
  const bookmarks = await Bookmark.find(filter).sort({ _id: -1 }).limit(30);
  const posts = await Post.find({ _id: { $in: bookmarks.map(b => b.post) }, author: { $in: await visibleAuthors(req.user._id) } }).sort({ _id: -1 }).populate('author', 'username name avatarUrl');
  res.json({ posts: await serialize(posts, req.user._id), hasMore: bookmarks.length === 30, nextCursor: bookmarks.at(-1)?._id });
}));
router.get('/collections', wrap(async (req, res) => res.json({ collections: await Collection.find({ owner: req.user._id }).sort({ updatedAt: -1 }).limit(50) })));
router.post('/collections', wrap(async (req, res) => {
  const name = text(req.body.name, 80); if (!name) throw fail('Name required.', 400);
  const collection = await Collection.create({ owner: req.user._id, name, visibility: req.body.visibility === 'public' ? 'public' : 'private' }); res.status(201).json({ collection });
}));
router.get('/collections/:id', wrap(async (req, res) => {
  const collection = await Collection.findById(id(req.params.id)); if (!collection) throw fail('Collection not found.', 404);
  if (String(collection.owner) !== req.user.id && collection.visibility !== 'public') throw fail();
  await assertView(collection.owner, req.user._id);
  const posts = await Post.find({ _id: { $in: collection.posts }, author: { $in: await visibleAuthors(req.user._id) } }).sort({ _id: -1 }).limit(100).populate('author', 'username name avatarUrl');
  res.json({ collection, posts: await serialize(posts, req.user._id) });
}));
router.post('/collections/:id/posts', wrap(async (req, res) => {
  const collection = await Collection.findById(id(req.params.id)); if (!collection || String(collection.owner) !== req.user.id) throw fail();
  const post = await Post.findById(id(req.body.postId)); if (!post) throw fail('Post not found.', 404); await assertView(post.author, req.user._id);
  if (collection.posts.length >= 100 && !collection.posts.some(p => String(p) === post.id)) throw fail('Collection limit is 100 photos.', 400);
  await Collection.updateOne({ _id: collection._id }, req.body.remove ? { $pull: { posts: post._id } } : { $addToSet: { posts: post._id } }); res.json({ ok: true });
}));
router.delete('/collections/:id', wrap(async (req, res) => { const result = await Collection.deleteOne({ _id: id(req.params.id), owner: req.user._id }); if (!result.deletedCount) throw fail(); res.json({ ok: true }); }));
async function currentChallenge() {
  const date = new Date(); date.setUTCHours(0, 0, 0, 0); const day = Math.floor(date / 86400000);
  const themes = ['Reflections', 'Golden Hour', 'Life in Motion', 'Shadows and Light', 'Tiny Details', 'A World in Blue', 'The Everyday'];
  return Challenge.findOneAndUpdate({ key: date.toISOString().slice(0, 10) }, { $setOnInsert: { title: themes[day % themes.length], description: 'Share your interpretation. One public photo and one community vote per person. Creativity is more than popularity.', startsAt: date, closesAt: new Date(+date + 86400000), kind: 'daily' } }, { new: true, upsert: true });
}
router.get('/challenges', wrap(async (req, res) => { const current = await currentChallenge(); const monday = new Date(); monday.setUTCHours(0,0,0,0); monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7); await Challenge.findOneAndUpdate({ key: 'week-' + monday.toISOString().slice(0,10) }, { $setOnInsert: { title: 'Weekly: The world around you', description: 'A week to document your surroundings. One photo and one vote per person; creativity is not just popularity.', kind: 'weekly', startsAt: monday, closesAt: new Date(+monday + 7*86400000) } }, { upsert: true }); res.json({ current, challenges: await Challenge.find().sort({ startsAt: -1 }).limit(30) }); }));
router.get('/challenges/:id', wrap(async (req, res) => {
  const challenge = await Challenge.findById(id(req.params.id)); if (!challenge) throw fail('Challenge not found.', 404);
  const authors = await visibleAuthors(req.user._id, true);
  const entries = await Entry.find({ challenge: challenge._id }).sort({ _id: -1 }).limit(100).populate({ path: 'post', match: { author: { $in: authors } }, populate: { path: 'author', select: 'username name avatarUrl' } });
  const counts = await Vote.aggregate([{ $match: { challenge: challenge._id } }, { $group: { _id: '$entry', count: { $sum: 1 } } }]);
  const vote = await Vote.findOne({ challenge: challenge._id, user: req.user._id });
  res.json({ challenge, entries: entries.filter(e => e.post).map(e => ({ ...e.toObject(), votes: counts.find(c => String(c._id) === e.id)?.count || 0 })).sort((a, b) => b.votes - a.votes), myVote: vote?.entry });
}));
async function openChallenge(challengeId) { const challenge = await Challenge.findById(id(challengeId)); if (!challenge) throw fail('Challenge not found.', 404); if (challenge.startsAt > new Date() || challenge.closesAt <= new Date()) throw fail('Challenge is closed.', 410); return challenge; }
router.post('/challenges/:id/entries', wrap(async (req, res) => {
  const challenge = await openChallenge(req.params.id); const post = await Post.findOne({ _id: id(req.body.postId), author: req.user._id }); if (!post) throw fail('Submit your own photo.', 403);
  const owner = await User.findById(req.user._id); if (owner.privacy?.account === 'private') throw fail('Challenge photos must be public.', 400);
  const existing = await Entry.findOne({ challenge: challenge._id, user: req.user._id });
  if (existing && String(existing.post) !== post.id && await Vote.exists({ entry: existing._id })) throw fail('An entry that has received votes cannot be replaced.', 409);
  const entry = await Entry.findOneAndUpdate({ challenge: challenge._id, user: req.user._id }, { $set: { post: post._id } }, { upsert: true, new: true }); res.status(201).json({ entry });
}));
router.post('/challenges/:id/vote', wrap(async (req, res) => {
  const challenge = await openChallenge(req.params.id); const entry = await Entry.findOne({ _id: id(req.body.entryId), challenge: challenge._id }); if (!entry) throw fail('Entry not found.', 404);
  if (String(entry.user) === req.user.id) throw fail('Choose another creator’s photo.', 400);
  const post = await Post.findById(entry.post); if (!post) throw fail('Photo unavailable.', 404); await assertView(post.author, req.user._id);
  await Vote.updateOne({ challenge: challenge._id, user: req.user._id }, { $set: { entry: entry._id } }, { upsert: true }); res.json({ ok: true });
}));
router.get('/settings', wrap(async (req, res) => {
  const blocks = await require('../models/Block').find({ owner: req.user._id }).limit(100).populate('target', 'username name avatarUrl');
  const sessions = await require('../models/LocationSession').find({ owner: req.user._id, active: true, expiresAt: { $gt: new Date() } }).select('-lat -lng -accuracy').limit(20);
  res.json({ isAdmin: (process.env.ADMIN_USER_IDS || '').split(',').includes(req.user.id), privacy: req.user.privacy, website: req.user.website, categories: req.user.categories, blocks, sessions, deletionRequest: await require('../models/DeletionRequest').findOne({ user: req.user._id }) });
}));
router.patch('/settings', wrap(async (req, res) => {
  const allowed = { account: ['public', 'private'], messages: ['everyone', 'following', 'nobody'], calls: ['everyone', 'following', 'nobody'], stories: ['public', 'followers'] };
  for (const [key, values] of Object.entries(allowed)) if (req.body[key] !== undefined) { if (!values.includes(req.body[key])) throw fail('Invalid setting.', 400); req.user.set(`privacy.${key}`, req.body[key]); }
  if (typeof req.body.notifications === 'boolean') req.user.set('privacy.notifications', req.body.notifications);
  if (req.body.website !== undefined) { const website = text(req.body.website, 200); if (website && !/^https:\/\//.test(website)) throw fail('Use an HTTPS portfolio link.', 400); req.user.website = website; }
  if (Array.isArray(req.body.categories)) req.user.categories = req.body.categories.filter(v => typeof v === 'string').slice(0, 8).map(v => text(v, 40));
  await req.user.save(); res.json({ privacy: req.user.privacy });
}));
router.post('/account/deletion-request', wrap(async (req, res) => {
  const status = req.body.cancel ? 'cancelled' : 'requested'; const request = await require('../models/DeletionRequest').findOneAndUpdate({ user: req.user._id }, { $set: { status } }, { new: true, upsert: true }); res.json({ request, message: 'Deletion requests require owner review. No data has been erased.' });
}));
router.post('/reports', wrap(async (req, res) => {
  if (!['user', 'post'].includes(req.body.targetType)) throw fail('Invalid report target.', 400);
  const target = id(req.body.target); const reason = text(req.body.reason, 1000); if (!reason) throw fail('Describe the concern.', 400);
  const model = req.body.targetType === 'user' ? User : Post; if (!await model.exists({ _id: target })) throw fail('Target not found.', 404);
  const report = await Report.findOneAndUpdate({ reporter: req.user._id, targetType: req.body.targetType, target }, { $set: { reason }, $setOnInsert: { status: 'open' } }, { upsert: true, new: true }); res.status(201).json({ report });
}));
router.get('/reports', wrap(async (req, res) => res.json({ reports: await Report.find({ reporter: req.user._id }).sort({ _id: -1 }).limit(50) })));
const admin = (req, res, next) => (process.env.ADMIN_USER_IDS || '').split(',').includes(req.user.id) ? next() : next(fail());
router.get('/admin/reports', admin, wrap(async (req, res) => res.json({ reports: await Report.find({ status: { $in: ['open', 'reviewing'] } }).sort({ _id: -1 }).limit(100) })));
router.get('/admin/deletion-requests', admin, wrap(async (req, res) => res.json({ requests: await require('../models/DeletionRequest').find({ status: 'requested' }).sort({ _id: -1 }).limit(100).populate('user', 'username name') })));
router.patch('/admin/reports/:id', admin, wrap(async (req, res) => { if (!['open', 'reviewing', 'resolved', 'dismissed'].includes(req.body.status)) throw fail('Invalid status.', 400); const report = await Report.findByIdAndUpdate(id(req.params.id), { $set: { status: req.body.status } }, { new: true }); if (!report) throw fail('Report not found.', 404); res.json({ report }); }));
router.get('/analytics/me', wrap(async (req, res) => {
  const since = new Date(Date.now() - 30 * 86400000); const all = await Post.find({ author: req.user._id }).select('caption likes createdAt imageUrl').sort({ createdAt: -1 }).limit(500);
  const comments = await Comment.aggregate([{ $match: { post: { $in: all.map(p => p._id) } } }, { $group: { _id: '$post', count: { $sum: 1 } } }]);
  const posts = all.map(p => ({ _id: p._id, caption: p.caption, imageUrl: p.imageUrl, likes: p.likes.length, comments: comments.find(c => String(c._id) === p.id)?.count || 0, createdAt: p.createdAt }));
  const followers = await require('../models/Follow').countDocuments({ following: req.user._id });
  res.json({ posts: posts.sort((a, b) => b.likes + b.comments - a.likes - a.comments), followers, recentPosts: posts.filter(p => p.createdAt >= since).length, totals: { likes: posts.reduce((n, p) => n + p.likes, 0), comments: posts.reduce((n, p) => n + p.comments, 0) }, definitions: 'Current like/comment totals across up to 500 recent owned posts. Followers are current relationships; no measured views, reach or historical growth is claimed.' });
}));
router.get('/photo-map', wrap(async (req, res) => {
  const filter = { author: { $in: await visibleAuthors(req.user._id, true) }, 'publicPlace.lat': { $exists: true } };
  if (req.query.category) filter.category = text(req.query.category, 40).toLowerCase();
  if (req.query.since) { const since = new Date(req.query.since); if (!Number.isFinite(+since)) throw fail('Invalid date.', 400); filter.createdAt = { $gte: since }; }
  const posts = await Post.find(filter).sort({ createdAt: -1 }).limit(100).populate('author', 'username name avatarUrl');
  res.json({ posts: await serialize(posts, req.user._id), precision: 'Coordinates are rounded to 0.1 degrees before storage (roughly 11 km latitude). Places are opt-in photo metadata, never live sharing data.' });
}));
router.post('/profile/pins', wrap(async (req, res) => {
  const post = await Post.findOne({ _id: id(req.body.postId), author: req.user._id }); if (!post) throw fail('Choose your own post.', 403);
  if (req.body.remove) await User.updateOne({ _id: req.user._id }, { $pull: { pinnedPosts: post._id } });
  else { if ((req.user.pinnedPosts || []).length >= 3 && !req.user.pinnedPosts.some(p => String(p) === post.id)) throw fail('Pin up to three posts.', 400); const changed = await User.updateOne({ _id: req.user._id, $or: [{ pinnedPosts: post._id }, { $expr: { $lt: [{ $size: { $ifNull: ['$pinnedPosts', []] } }, 3] } }] }, { $addToSet: { pinnedPosts: post._id } }); if (!changed.matchedCount) throw fail('Pin up to three posts.', 400); }
  res.json({ ok: true });
}));
module.exports = router;
