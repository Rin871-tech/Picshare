const mongoose = require('mongoose');
const schema = new mongoose.Schema({ owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, name: { type: String, maxlength: 80, required: true }, visibility: { type: String, enum: ['public', 'private'], default: 'private' }, posts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Post' }] }, { timestamps: true });
schema.index({ owner: 1, updatedAt: -1 });
module.exports = mongoose.model('Collection', schema);
