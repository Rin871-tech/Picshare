const mongoose = require('mongoose');

const locationSessionSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Authorized viewer (DM context: the other participant)
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' },

  // Current coordinates — only stored while session is active
  // Never exposed publicly; only owner or recipient may read
  lat: { type: Number, min: -90, max: 90 },
  lng: { type: Number, min: -180, max: 180 },
  accuracy: { type: Number }, // metres, informational
  lastUpdatedAt: { type: Date },

  // Session lifecycle
  active: { type: Boolean, default: true, index: true },
  startedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true }, // enforced in app logic
  revokedAt: { type: Date }
}, { timestamps: true });

locationSessionSchema.index({ owner: 1, active: 1 });
locationSessionSchema.index({ recipient: 1, active: 1 });
// TTL index to auto-delete expired sessions from DB (application logic checks expiresAt first)
locationSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 }); // 1-hour grace

module.exports = mongoose.model('LocationSession', locationSessionSchema);
