const jwt = require('jsonwebtoken');
const path = require('path');
const User = require('../models/User');
const { fail } = require('./privacy');
function signedUrl(url, userId) {
  const token = jwt.sign({ sub: String(userId), media: url }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return `${url}?media=${encodeURIComponent(token)}`;
}
// Recheck authorization when a signed image is requested; a URL never overrides revocation.
async function mediaAuth(req, res, next) {
  if (!req.query.media) return require('../middleware/auth')(req, res, next);
  try {
    const payload = jwt.verify(req.query.media, process.env.JWT_SECRET);
    if (payload.media !== req.baseUrl + req.path) throw fail();
    req.user = await User.findById(payload.sub);
    if (!req.user) throw fail();
    next();
  } catch { res.status(403).json({ error: 'Media link expired or access denied. Reload the page.' }); }
}
function decorateData(data, userId) {
  const plain = JSON.parse(JSON.stringify(data));
  const visit = obj => {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      if ((key === 'imageUrl' || key === 'avatarUrl') && typeof obj[key] === 'string' && (/^\/uploads\//.test(obj[key]) || /^\/api\/(stories|spaces)\/.+\/media$/.test(obj[key]))) obj[key] = signedUrl(obj[key].split('?')[0], userId);
      else visit(obj[key]);
    }
  };
  visit(plain); return plain;
}
function decorate(req, res, next) {
  const original = res.json.bind(res);
  res.json = data => original(req.user ? decorateData(data, req.user._id) : data);
  next();
}
function privatePath(filename) {
  const root = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
  return path.join(root, '..', path.basename(root) + '-private', filename);
}
module.exports = { signedUrl, mediaAuth, decorate, decorateData, privatePath };
