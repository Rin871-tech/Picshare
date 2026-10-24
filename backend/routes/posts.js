const express = require('express');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const Post = require('../models/Post');
const Follow = require('../models/Follow');
const Comment = require('../models/Comment');
const auth = require('../middleware/auth');
const upload = require('../utils/upload');
const asyncHandler = require('../utils/asyncHandler');
const Bookmark = require('../models/Bookmark');
const router = express.Router();
const { visibleAuthors, assertView } = require('../utils/privacy');

router.get('/feed', auth, asyncHandler(async (req, res) => {
  const page = Math.max(1, Math.min(1000, Number.parseInt(req.query.page, 10) || 1));
  const limit = Math.max(1, Math.min(30, Number.parseInt(req.query.limit, 10) || 15));
  let filter = { author: { $in: await visibleAuthors(req.user._id) } };
  if (req.query.mode === 'following') {
    const follows = await Follow.find({ follower: req.user._id }).select('following');
    const visible = new Set((await visibleAuthors(req.user._id)).map(String));
    filter.author = { $in: [...follows.map(f => f.following), req.user._id].filter(id => visible.has(String(id))) };
  }
  const posts = await Post.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).populate('author', 'username name avatarUrl');
  const ids = posts.map(p => p._id);
  const counts = await Comment.aggregate([{ $match: { post: { $in: ids } } }, { $group: { _id: '$post', count: { $sum: 1 } } }]);
  const savedRows = await Bookmark.find({ user: req.user._id, post: { $in: ids } }).select('post'); const saved = new Set(savedRows.map(b => String(b.post)));
  const countMap = new Map(counts.map(c => [String(c._id), c.count]));
  res.json({ posts: posts.map(p => ({ ...p.toObject(), isBookmarked: saved.has(String(p._id)), likesCount: p.likes.length, isLiked: p.likes.some(id => String(id) === String(req.user._id)), commentsCount: countMap.get(String(p._id)) || 0 })), page, hasMore: posts.length === limit });
}));
router.post('/', auth, upload.single('image'), asyncHandler(async (req, res) => {
  const caption = String(req.body.caption || '').trim();
  if (caption.length > 2200) { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'Caption must be 2,200 characters or fewer.' }); }
  if (!req.file) return res.status(400).json({ error: 'A photo is required to create a post.' });
  let publicPlace;
  if (req.body.sharePlace === 'true') {
    const lat = Number(req.body.placeLat), lng = Number(req.body.placeLng);
    if (!String(req.body.placeLat || '').trim() || !String(req.body.placeLng || '').trim() || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'Enter a valid approximate place.' }); }
    publicPlace = { lat: Math.round(lat * 10) / 10, lng: Math.round(lng * 10) / 10, label: String(req.body.placeLabel || '').slice(0, 80) };
  }
  const post = await Post.create({ publicPlace, author: req.user._id, caption, category: String(req.body.category || '').slice(0, 40).toLowerCase(), mood: String(req.body.mood || '').slice(0, 40).toLowerCase(), tags: [...new Set((caption.match(/#[\p{L}\p{N}_]+/gu) || []).map(t => t.toLowerCase()))].slice(0, 20), altText: String(req.body.altText || '').slice(0, 500), imageUrl: `/uploads/${req.file.filename}` });
  await post.populate('author', 'username name avatarUrl');
  res.status(201).json({ post: { ...post.toObject(), likesCount: 0, commentsCount: 0, isLiked: false } });
}));
router.get('/:id', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(400);
  const post = await Post.findById(req.params.id).populate('author', 'username name avatarUrl');
  if (!post) return res.status(404).json({ error: 'Post is no longer available.' });
  await assertView(post.author._id || post.author, req.user._id);
  res.json({ post: { ...post.toObject(), isBookmarked: Boolean(await Bookmark.exists({ user: req.user._id, post: post._id })), likesCount: post.likes.length, isLiked: post.likes.some(id => String(id) === String(req.user._id)), commentsCount: await Comment.countDocuments({ post: post._id }) } });
}));
router.delete('/:id', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid post id.' });
  const post = await Post.findById(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  if (String(post.author) !== String(req.user._id)) return res.status(403).json({ error: 'You can only delete your own posts.' });
  await Promise.all([post.deleteOne(), Comment.deleteMany({ post: post._id })]);
  if (post.imageUrl.startsWith('/uploads/')) fs.unlink(path.join(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'), path.basename(post.imageUrl)), () => {});
  res.json({ success: true });
}));
router.post('/:id/like', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid post id.' });
  const post = await Post.findById(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  await assertView(post.author, req.user._id);
  const idx = post.likes.findIndex(id => String(id) === String(req.user._id));
  const updated = await Post.findByIdAndUpdate(post._id, idx >= 0 ? { $pull: { likes: req.user._id } } : { $addToSet: { likes: req.user._id } }, { new: true });
  res.json({ liked: updated.likes.some(id => String(id) === String(req.user._id)), likesCount: updated.likes.length });
}));
router.get('/:id/comments', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid post id.' });
  const post = await Post.findById(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  await assertView(post.author, req.user._id);
  const comments = await Comment.find({ post: req.params.id }).sort({ createdAt: 1 }).limit(100).populate('author', 'username name avatarUrl');
  res.json({ comments });
}));
router.post('/:id/comments', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid post id.' });
  const text = String(req.body.text || '').trim();
  if (!text || text.length > 500) return res.status(400).json({ error: 'Comment must be between 1 and 500 characters.' });
  const post = await Post.findById(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  await assertView(post.author, req.user._id);
  const comment = await Comment.create({ post: req.params.id, author: req.user._id, text });
  await comment.populate('author', 'username name avatarUrl');
  res.status(201).json({ comment });
}));
router.delete('/:postId/comments/:commentId', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.postId) || !mongoose.isValidObjectId(req.params.commentId)) return res.status(400).json({ error: 'Invalid id.' });
  const comment = await Comment.findOne({ _id: req.params.commentId, post: req.params.postId });
  if (!comment) return res.status(404).json({ error: 'Comment not found.' });
  const post = await Post.findById(req.params.postId).select('author');
  if (String(comment.author) !== String(req.user._id) && String(post?.author) !== String(req.user._id)) return res.status(403).json({ error: 'You can only delete your own comments.' });
  await comment.deleteOne();
  res.json({ success: true });
}));
module.exports = router;
