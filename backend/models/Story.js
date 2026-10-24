const mongoose = require('mongoose');
const schema = new mongoose.Schema({ owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, filename: { type: String, required: true }, text: { type: String, maxlength: 500, default: '' }, sticker: { type: String, maxlength: 10, default: '' }, audience: { type: String, enum: ['public', 'followers'], default: 'public' }, expiresAt: { type: Date, required: true, index: true } }, { timestamps: true });
schema.index({ owner: 1, expiresAt: 1 });
module.exports = mongoose.model('Story', schema);
