const express = require('express');
const fs = require('fs/promises');
const auth = require('../middleware/auth');
const upload = require('../utils/upload');
const asyncHandler = require('../utils/asyncHandler');
const router = express.Router();
router.post('/suggest', auth, (req, res, next) => {
  if (!process.env.AI_PROVIDER_URL || !process.env.AI_PROVIDER_KEY) return res.status(503).json({ error: 'Photo suggestions are not configured. You can still write and publish your own caption.' });
  req.privateAttachment = true;
  next();
}, upload.single('image'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a photo first.' });
  try {
    const context = String(req.body.context || '');
    if (context.length > 1000) return res.status(400).json({ error: 'Context must be under 1,000 characters.' });
    if (!process.env.AI_PROVIDER_URL.startsWith('https://')) return res.status(503).json({ error: 'AI provider requires HTTPS.' });
    const bytes = await fs.readFile(req.file.path);
    const response = await fetch(process.env.AI_PROVIDER_URL, {
      method: 'POST', signal: AbortSignal.timeout(15000), redirect: 'error',
      headers: { Authorization: `Bearer ${process.env.AI_PROVIDER_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: { mimeType: req.file.mimetype, base64: bytes.toString('base64') }, context, task: 'photo_suggestions' })
    });
    if (!response.ok) return res.status(503).json({ error: 'Suggestions are temporarily unavailable. Please write your own caption or try later.' });
    const reader = response.body.getReader();
    let size = 0; const chunks = [];
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 16384) { await reader.cancel(); throw new Error('Oversized response'); } chunks.push(Buffer.from(value)); }
    const data = JSON.parse(Buffer.concat(chunks).toString());
    if (typeof data.caption !== 'string' || typeof data.altText !== 'string' || !Array.isArray(data.hashtags)) throw new Error('Invalid provider output');
    res.json({ categories: Array.isArray(data.categories) ? data.categories.filter(c => typeof c === 'string').slice(0, 8).map(c => c.slice(0, 40)) : [], mood: typeof data.mood === 'string' ? data.mood.slice(0, 40) : '', caption: data.caption.slice(0, 1800), hashtags: data.hashtags.filter(t => typeof t === 'string' && /^#[\p{L}\p{N}_]{1,50}$/u.test(t)).slice(0, 10), altText: data.altText.slice(0, 500) });
  } catch {
    res.status(503).json({ error: 'Suggestions are unavailable. Your photo has not been published; you can continue writing your own caption.' });
  } finally { await fs.unlink(req.file.path).catch(() => {}); }
}));
module.exports = router;
