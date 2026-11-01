const { fail, blocked } = require('./privacy');
function status(conversation) { return conversation.requestStatus || 'accepted'; }
function participant(conversation, userId) { if (!conversation || !conversation.participants.some(id => String(id?._id || id) === String(userId))) throw fail('Conversation access denied.'); }
async function access(conversation, userId, accepted = false) {
  participant(conversation, userId);
  const peer = conversation.participants.find(id => String(id?._id || id) !== String(userId));
  if (await blocked(userId, peer?._id || peer)) throw fail('Contact is blocked.');
  if (accepted && status(conversation) !== 'accepted') throw fail('Accept this message request first.', 409);
}
function requestFor(conversation, userId) { return status(conversation) === 'pending' && String(conversation.requestRecipient) === String(userId); }
async function delivered(req, conversation, messages) {
  if (status(conversation) !== 'accepted') return;
  const Message = require('../models/Message'); const at = new Date();
  const ids = messages.filter(m => String(m.sender?._id || m.sender) !== String(req.user._id) && m.deliveryState === 'sent').map(m => m._id);
  if (!ids.length) return;
  await Message.updateMany({ _id: { $in: ids }, deliveryState: 'sent' }, { $set: { deliveryState: 'delivered', deliveredAt: at } });
  for (const message of messages) if (ids.some(id => String(id) === String(message._id))) {
    message.deliveryState = 'delivered'; message.deliveredAt = at;
    req.app.get('io')?.to(`user:${message.sender?._id || message.sender}`).emit('message:delivered', { conversationId: String(conversation._id), messageId: String(message._id), deliveredAt: at });
  }
}
module.exports = { status, participant, access, requestFor, delivered };
