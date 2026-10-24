const jwt = require('jsonwebtoken');
const User = require('../models/User');

module.exports = async function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Please log in to continue.' });
  let payload;
  try { payload = jwt.verify(token, process.env.JWT_SECRET); if (payload.media) throw new Error(); }
  catch { return res.status(401).json({ error: 'Your session has expired. Please log in again.' }); }
  try {
    const user = await User.findById(payload.sub);
    if (!user) return res.status(401).json({ error: 'Account no longer exists.' });
    req.user = user;
    next();
  } catch (error) { next(error); }
};
