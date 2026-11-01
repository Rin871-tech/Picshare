const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  endpointHash: { type: String, required: true },
  encrypted: { type: String, required: true, select: false }
}, { timestamps: true });
schema.index({ user: 1, endpointHash: 1 }, { unique: true });
module.exports = mongoose.model('PushSubscription', schema);
