const express = require('express');
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const Notification = require('../models/Notification');
const router = express.Router();
router.use(auth);
router.get('/', asyncHandler(async (req, res) => {
  const filter = { recipient: req.user._id };
  if (req.query.before) {
    if (!mongoose.isValidObjectId(req.query.before)) return res.sendStatus(400);
    filter._id = { $lt: req.query.before };
  }
  const notifications = await Notification.find(filter).sort({ _id: -1 }).limit(30);
  res.json({ notifications, unread: await Notification.countDocuments({ recipient: req.user._id, read: false }) });
}));
router.patch('/:id/read', asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(400);
  const notification = await Notification.findOneAndUpdate({ _id: req.params.id, recipient: req.user._id }, { $set: { read: true } });
  if (!notification) return res.sendStatus(404);
  res.json({ ok: true });
}));
module.exports = router;
