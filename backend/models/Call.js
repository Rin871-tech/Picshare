const mongoose = require('mongoose');

const callSchema = new mongoose.Schema({
  caller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' },

  callType: { type: String, enum: ['audio', 'video'], required: true },

  // State machine: idle → outgoing → ringing → connecting → connected → ended
  state: {
    type: String,
    enum: ['outgoing', 'ringing', 'connecting', 'connected', 'ended'],
    default: 'outgoing'
  },

  // End reasons
  endReason: {
    type: String,
    enum: ['completed', 'rejected', 'cancelled', 'no_answer', 'busy', 'failed', 'network_error'],
    default: null
  },

  // Signaling tokens (ephemeral — just short-lived strings, not SDP blobs)
  // We do NOT persist SDP or ICE candidates
  offerId: { type: String }, // ephemeral reference for in-flight offer

  startedAt: { type: Date, default: Date.now },
  answeredAt: { type: Date },
  endedAt: { type: Date },

  // Duration computed from answeredAt → endedAt server-side only
  durationSeconds: { type: Number, default: 0 },

  // Timeout: call auto-cancelled after this if still ringing
  expiresAt: { type: Date }
}, { timestamps: true });

callSchema.index({ caller: 1, createdAt: -1 });
callSchema.index({ recipient: 1, createdAt: -1 });
callSchema.index({ state: 1 });
// Keep call history; ringing deadlines are enforced by application logic.
callSchema.index({ expiresAt: 1 });

module.exports = mongoose.model('Call', callSchema);
