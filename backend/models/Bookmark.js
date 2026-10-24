const mongoose = require('mongoose');
const schema = new mongoose.Schema({ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true } }, { timestamps: true });
schema.index({ user: 1, post: 1 }, { unique: true });
module.exports = mongoose.model('Bookmark', schema);
