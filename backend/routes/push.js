// Subscription preparation only. Sending Web Push requires VAPID and a delivery worker.
const router = require('express').Router();
const crypto = require('node:crypto');
const auth = require('../middleware/auth');
const wrap = require('../utils/asyncHandler');
const Subscription = require('../models/PushSubscription');
router.use(auth);
router.post('/subscriptions', wrap(async (req, res) => {
  const { endpoint, keys, expirationTime } = req.body || {};
  let url;
  try { url = new URL(endpoint); } catch { return res.status(400).json({ error: 'Invalid push subscription.' }); }
  if (url.protocol !== 'https:' || url.username || url.password || endpoint.length > 2048 || !['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'].includes(url.hostname) || typeof keys?.auth !== 'string' || typeof keys?.p256dh !== 'string' || !/^[A-Za-z0-9_-]{16,128}={0,2}$/.test(keys.auth) || !/^[A-Za-z0-9_-]{40,256}={0,2}$/.test(keys.p256dh)) return res.status(400).json({ error: 'Invalid push subscription.' });
  const endpointHash = crypto.createHash('sha256').update(endpoint).digest('hex');
  if (await Subscription.countDocuments({ user: req.user._id }) >= 10 && !await Subscription.exists({ user: req.user._id, endpointHash })) return res.status(409).json({ error: 'Remove an old push subscription first.' });
  const key = crypto.hkdfSync('sha256', process.env.JWT_SECRET, 'picshare', 'push-subscriptions', 32);
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const payload = JSON.stringify({ endpoint, keys: { auth: keys.auth, p256dh: keys.p256dh }, expirationTime: Number.isFinite(expirationTime) ? expirationTime : null });
  const encrypted = Buffer.concat([iv, cipher.update(payload, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
  await Subscription.updateOne({ user: req.user._id, endpointHash }, { $set: { encrypted } }, { upsert: true });
  res.status(201).json({ id: endpointHash, deliveryEnabled: false });
}));
router.delete('/subscriptions', wrap(async (req, res) => { await Subscription.deleteMany({ user: req.user._id }); res.json({ ok: true }); }));
module.exports = router;
