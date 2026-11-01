const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema({
  // Sorted participant IDs so [A,B] and [B,A] always produce the same participantKey
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
  // Canonical sorted key for O(1) dedup lookup: "id1_id2" (smaller first)
  participantKey: { type: String, required: true, index: true, unique: true },
  // Missing status in legacy documents means accepted; never reset old DMs.
  requestStatus: { type: String, enum: ['pending', 'accepted', 'declined'], default: 'accepted' },
  initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  requestRecipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  acceptedAt: Date,
  // Snapshot of latest message for inbox display (avoids extra query)
  lastMessage: {
    text: { type: String, default: '' },
    type: { type: String, default: 'text' },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date }
  },
  preferences: { type: Map, of: new mongoose.Schema({ archived: { type: Boolean, default: false }, pinned: { type: Boolean, default: false }, muted: { type: Boolean, default: false } }, { _id: false }), default: {} },
  // Per-participant unread counts: { userId: count }
  unread: { type: Map, of: Number, default: {} }
}, { timestamps: true });

conversationSchema.index({ participants: 1 });
conversationSchema.index({ updatedAt: -1 });
conversationSchema.index({ participants: 1, requestStatus: 1, updatedAt: -1 });

module.exports = mongoose.model('Conversation', conversationSchema);
