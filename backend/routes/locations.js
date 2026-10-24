/**
 * Location Sharing REST API
 * Handles both one-time location messages and live location sessions.
 */
const express = require('express');
const mongoose = require('mongoose');
const LocationSession = require('../models/LocationSession');
const Conversation = require('../models/Conversation');
const auth = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const router = express.Router();
const { assertContact } = require('../utils/contact');

/** Validate lat/lng */
function validateCoords(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return 'Coordinates must be numbers.';
  const la = Number(lat);
  const lo = Number(lng);
  if (!Number.isFinite(la) || la < -90 || la > 90) return 'Latitude must be between -90 and 90.';
  if (!Number.isFinite(lo) || lo < -180 || lo > 180) return 'Longitude must be between -180 and 180.';
  return null;
}

/**
 * POST /api/locations/live
 * Start a live location session.
 * Body: { conversationId, durationMinutes (15|60|480) }
 */
router.post('/live', auth, asyncHandler(async (req, res) => {
  const { conversationId, durationMinutes } = req.body || {};

  if (!conversationId || !mongoose.isValidObjectId(conversationId)) {
    return res.status(400).json({ error: 'Invalid conversationId.' });
  }

  const allowedDurations = [15, 60, 480]; // 15m, 1h, 8h
  const duration = Number.parseInt(durationMinutes, 10);
  if (!allowedDurations.includes(duration)) {
    return res.status(400).json({ error: `durationMinutes must be one of: ${allowedDurations.join(', ')}.` });
  }

  const conversation = await Conversation.findById(conversationId);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });

  const participants = conversation.participants.map(String);
  if (!participants.includes(String(req.user._id))) {
    return res.status(403).json({ error: 'Access denied.' });
  }

  const recipientId = participants.find(id => id !== String(req.user._id));
  if (!recipientId) return res.status(400).json({ error: 'Conversation has no other participant.' });

  await assertContact(req.user._id, recipientId);

  // Revoke any existing active session for this owner in this conversation
  await LocationSession.updateMany(
    { owner: req.user._id, conversation: conversation._id, active: true },
    { $set: { active: false, revokedAt: new Date() }, $unset: { lat: 1, lng: 1, accuracy: 1 } }
  );

  const expiresAt = new Date(Date.now() + duration * 60 * 1000);

  const session = await LocationSession.create({
    owner: req.user._id,
    recipient: recipientId,
    conversation: conversation._id,
    active: true,
    startedAt: new Date(),
    expiresAt
  });

  res.status(201).json({ session: { _id: session._id, expiresAt, durationMinutes: duration } });
}));

/**
 * PATCH /api/locations/live/:sessionId
 * Update live location coordinates. Only the session owner may call this.
 * Body: { lat, lng, accuracy? }
 */
router.patch('/live/:sessionId', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.sessionId)) {
    return res.status(400).json({ error: 'Invalid sessionId.' });
  }

  const session = await LocationSession.findById(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Location session not found.' });
  if (String(session.owner) !== String(req.user._id)) {
    return res.status(403).json({ error: 'Only the session owner can update coordinates.' });
  }
  await assertContact(session.owner, session.recipient);
  if (!session.active) {
    return res.status(410).json({ error: 'This location session has ended.' });
  }
  if (session.expiresAt < new Date()) {
    // Enforce expiry in app logic (TTL index may not have fired yet)
    await LocationSession.findByIdAndUpdate(session._id, { $set: { active: false } });
    return res.status(410).json({ error: 'This location session has expired.' });
  }

  const coordError = validateCoords(req.body?.lat, req.body?.lng);
  if (coordError) return res.status(400).json({ error: coordError });

  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  const accuracy = req.body.accuracy != null ? Number(req.body.accuracy) : undefined;

  const update = { lat, lng, lastUpdatedAt: new Date() };
  if (accuracy != null && Number.isFinite(accuracy)) update.accuracy = accuracy;

  const updated = await LocationSession.findOneAndUpdate({ _id: session._id, active: true, expiresAt: { $gt: new Date() } }, { $set: update }, { new: true });
  if (!updated) return res.status(410).json({ error: 'Session ended.' });
  req.app.get('io')?.to(`user:${session.recipient}`).emit('location:updated', { sessionId: String(session._id) });

  res.json({ ok: true, lastUpdatedAt: updated.lastUpdatedAt });
}));

/**
 * GET /api/locations/live/:sessionId
 * Read current live location. Only owner or recipient may read.
 */
router.get('/live/:sessionId', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.sessionId)) {
    return res.status(400).json({ error: 'Invalid sessionId.' });
  }

  const session = await LocationSession.findById(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  const uid = String(req.user._id);
  if (uid !== String(session.owner) && uid !== String(session.recipient)) {
    return res.status(403).json({ error: 'Access denied.' });
  }

  await assertContact(session.owner, session.recipient);
  if (!session.active || session.expiresAt <= new Date()) {
    await LocationSession.updateOne({ _id: session._id }, { $set: { active: false }, $unset: { lat: 1, lng: 1, accuracy: 1 } });
    return res.status(410).json({ error: 'Session has ended.' });
  }

  res.json({
    lat: session.lat,
    lng: session.lng,
    accuracy: session.accuracy,
    lastUpdatedAt: session.lastUpdatedAt,
    expiresAt: session.expiresAt,
    active: session.active
  });
}));

/**
 * DELETE /api/locations/live/:sessionId
 * Stop a live session. Only owner may stop.
 */
router.delete('/live/:sessionId', auth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.sessionId)) {
    return res.status(400).json({ error: 'Invalid sessionId.' });
  }

  const session = await LocationSession.findById(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  if (String(session.owner) !== String(req.user._id)) {
    return res.status(403).json({ error: 'Only the session owner can stop sharing.' });
  }

  await LocationSession.findByIdAndUpdate(session._id, {
    $set: { active: false, revokedAt: new Date(), lat: null, lng: null }
  });

  for (const id of [session.owner, session.recipient]) req.app.get('io')?.to(`user:${id}`).emit('location:ended', { sessionId: String(session._id) });
  res.json({ ok: true });
}));

module.exports = router;
