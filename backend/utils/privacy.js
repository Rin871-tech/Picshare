const User = require('../models/User');
const Follow = require('../models/Follow');
const Block = require('../models/Block');
const fail = (message = 'This content is private.', status = 403) => Object.assign(new Error(message), { status });
async function blocked(a, b) {
  return Boolean(await Block.exists({ $or: [{ owner: a, target: b }, { owner: b, target: a }] }));
}
async function blockedIds(userId) { const rows = await Block.find({ $or: [{ owner: userId }, { target: userId }] }).select('owner target'); return rows.map(b => String(b.owner) === String(userId) ? b.target : b.owner); }
async function canView(ownerId, viewerId) {
  if (String(ownerId) === String(viewerId)) return true;
  if (viewerId && await blocked(ownerId, viewerId)) return false;
  const owner = await User.findById(ownerId).select('privacy');
  if (!owner || owner.privacy?.account === 'private') return false;
  return true;
}
async function assertView(ownerId, viewerId) { if (!await canView(ownerId, viewerId)) throw fail(); }
async function visibleAuthors(viewerId, publicOnly = false) {
  const blocks = await Block.find({ $or: [{ owner: viewerId }, { target: viewerId }] });
  const excluded = blocks.map(b => String(b.owner) === String(viewerId) ? b.target : b.owner);
  const query = { _id: { $nin: excluded }, 'privacy.account': { $ne: 'private' } };
  // Private accounts are visible only to their owners in this release; no implicit follow approval.
  if (!publicOnly) return User.find({ $or: [query, { _id: viewerId }] }).distinct('_id');
  return User.find(query).distinct('_id');
}
async function assertPermission(sender, recipient, kind = 'messages') {
  if (String(sender) === String(recipient)) throw fail('Choose another user.', 400);
  if (await blocked(sender, recipient)) throw fail('Contact is blocked.');
  const user = await User.findById(recipient).select('privacy');
  if (!user) throw fail('User not found.', 404);
  const policy = user.privacy?.[kind] || 'everyone';
  if (policy === 'nobody' || policy === 'following' && !await Follow.exists({ follower: recipient, following: sender })) throw fail('This account does not accept this contact.');
}
module.exports = { fail, blocked, blockedIds, assertView, canView, visibleAuthors, assertPermission };
