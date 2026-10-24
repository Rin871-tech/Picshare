const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: {
    type: String,
    enum: [
      'new_message',
      'incoming_call',
      'missed_call',
      'call_ended',
      'location_share_started',
      'location_share_ended',
      'new_follower',
      'post_like',
      'post_comment'
    ],
    required: true
  },
  read: { type: Boolean, default: false, index: true },
  // Contextual references (all optional depending on type)
  fromUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' },
  message: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  call: { type: mongoose.Schema.Types.ObjectId, ref: 'Call' },
  post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
  locationSession: { type: mongoose.Schema.Types.ObjectId, ref: 'LocationSession' },
  // Short display text (never sensitive coordinates or message content)
  preview: { type: String, maxlength: 200, default: '' }
}, { timestamps: true });

notificationSchema.index({ recipient: 1, read: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, message: 1, type: 1 }, { unique: true, partialFilterExpression: { message: { $type: 'objectId' } } });
// Auto-delete notifications older than 30 days
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

module.exports = mongoose.model('Notification', notificationSchema);
