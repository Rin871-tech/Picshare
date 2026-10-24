const mongoose = require('mongoose');
const schema = new mongoose.Schema({ challenge: { type: mongoose.Schema.Types.ObjectId, ref: 'Challenge', required: true }, user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true } }, { timestamps: true });
schema.index({ challenge: 1, user: 1 }, { unique: true });
module.exports = mongoose.model('Entry', schema);
