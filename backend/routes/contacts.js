const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const User = require('../models/User');
const { blockedIds } = require('../utils/privacy');
router.use(auth, rateLimit({ windowMs: 60000, limit: 30 }));
router.get('/preferences', (req, res) => res.json({ discoverable: req.user.contactDiscoverable === true }));
router.patch('/preferences', asyncHandler(async (req, res) => {
  if (typeof req.body.discoverable !== 'boolean') return res.status(400).json({ error: 'Choose whether contacts can find you.' });
  req.user.contactDiscoverable = req.body.discoverable;
  await req.user.save();
  res.json({ discoverable: req.user.contactDiscoverable });
}));
async function match(req, emails) {
  const excluded = await blockedIds(req.user._id);
  const users = await User.find({ email: { $in: [...new Set(emails.map(e => String(e).trim().toLowerCase()).filter(e => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))] }, contactDiscoverable: true, 'privacy.account': { $ne: 'private' }, _id: { $nin: [req.user._id, ...excluded] } }).limit(100);
  return users.map(u => ({ _id: u._id, name: u.name, username: u.username, avatarUrl: u.avatarUrl }));
}
router.post('/match', asyncHandler(async (req, res) => {
  if (!Array.isArray(req.body.emails) || req.body.emails.length > 500 || req.body.emails.some(e => typeof e !== 'string')) return res.status(400).json({ error: 'Select up to 500 contact email addresses.' });
  res.json({ users: await match(req, req.body.emails) });
}));
router.post('/google', asyncHandler(async (req, res) => {
  const token = req.body.accessToken;
  if (typeof token !== 'string' || token.length > 8192 || !token) return res.status(400).json({ error: 'Connect Google Contacts first.' });
  // Token and address book live only in memory for this request; never persist or log them.
  const emails = [];
  let pageToken;
  for (let page = 0; page < 5; page++) {
    const url = new URL('https://people.googleapis.com/v1/people/me/connections');
    url.searchParams.set('personFields', 'emailAddresses'); url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) return res.status(400).json({ error: 'Google Contacts access failed. Enable the People API and grant Contacts permission, then try again.' });
    const data = await response.json();
    for (const person of data.connections || []) for (const email of person.emailAddresses || []) if (email.value) emails.push(email.value);
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  res.json({ users: await match(req, emails), truncated: Boolean(pageToken) });
}));
module.exports = router;
