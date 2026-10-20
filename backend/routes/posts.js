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
const router = express.Router();

router.get('/feed', auth, asyncHandler(async (req, res) => {
  const page = Math.max(1, Math.min(1000, Number.parseInt(req.query.page, 10) || 1));
  const limit = Math.max(1, Math.min(30, Number.parseInt(req.query.limit, 10) || 15));
  let filter = {};
  if (req.query.mode === 'following') {
    const follows = await Follow.find({ follower: req.user._id }).select('following');
    filter.author = { $in: [...follows.map(f => f.following), req.user._id] };
  }
  const posts = await Post.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).populate('author', 'username name avatarUrl');
  const ids = posts.map(p => p._id);
  const counts = await Comment.aggregate([{ $match: { post: { $in: ids } } }, { $group: { _id: '$post', count: { $sum: 1 } } }]);
  const countMap = new Map(counts.map(c => [String(c._id), c.count]));
  res.json({ posts: posts.map(p => ({ ...p.toObject(), likesCount: p.likes.length, isLiked: p.likes.some(id => String(id) === String(req.user._id)), commentsCount: countMap.get(String(p._id)) || 0 })), page, hasMore: posts.length === limit });
}));
router.post('/', auth, upload.single('image'), asyncHandler(async (req, res) => {
  const caption = String(req.body.caption || '').trim();
  if (caption.length > 2200) { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'Caption must be 2,200 characters or fewer.' }); }
  if (!req.file) return res.status(400).json({ error: 'A photo is required to create a post.' });
  const post = await Post.create({ author: req.user._id, caption, imageUrl: `/uploads/${req.file.filename}` });
  await post.populate('author', 'username name avatarUrl');
  res.status(201).json({ post: { ...post.toObject(), likesCount: 0, commentsCount: 0, isLiked: false } });
}));
router.delete('/:id', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid post id.' });
  const post = await Post.findById(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  if (String(post.author) !== String(req.user._id)) return res.status(403).json({ error: 'You can only delete your own posts.' });
  await Promise.all([post.deleteOne(), Comment.deleteMany({ post: post._id })]);
  if (post.imageUrl.startsWith('/uploads/')) fs.unlink(path.join(__dirname, '..', post.imageUrl), () => {});
  res.json({ success: true });
}));
router.post('/:id/like', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid post id.' });
  const post = await Post.findById(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  const idx = post.likes.findIndex(id => String(id) === String(req.user._id));
  if (idx >= 0) post.likes.splice(idx, 1); else post.likes.push(req.user._id);
  await post.save();
  res.json({ liked: idx < 0, likesCount: post.likes.length });
}));
router.get('/:id/comments', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid post id.' });
  if (!await Post.exists({ _id: req.params.id })) return res.status(404).json({ error: 'Post not found.' });
  const comments = await Comment.find({ post: req.params.id }).sort({ createdAt: 1 }).limit(100).populate('author', 'username name avatarUrl');
  res.json({ comments });
}));
router.post('/:id/comments', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid post id.' });
  const text = String(req.body.text || '').trim();
  if (!text || text.length > 500) return res.status(400).json({ error: 'Comment must be between 1 and 500 characters.' });
  if (!await Post.exists({ _id: req.params.id })) return res.status(404).json({ error: 'Post not found.' });
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
