const mongoose = require('mongoose');
const schema = new mongoose.Schema({ kind: { type: String, enum: ['circle', 'album'], required: true }, owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, name: { type: String, required: true, maxlength: 80 }, description: { type: String, maxlength: 500, default: '' }, members: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, role: { type: String, enum: ['moderator', 'contributor', 'viewer'], default: 'contributor' } }] }, { timestamps: true });
schema.index({ 'members.user': 1, updatedAt: -1 });
schema.index({ owner: 1, updatedAt: -1 });
module.exports = mongoose.model('Space', schema);
