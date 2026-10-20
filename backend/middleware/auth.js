const jwt = require('jsonwebtoken');
const User = require('../models/User');

module.exports = async function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Please log in to continue.' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.sub);
    if (!user) return res.status(401).json({ error: 'Account no longer exists.' });
    req.user = user;
    next();
  } catch (_error) {
    return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }
};
