const mongoose = require('mongoose');
const postSchema = new mongoose.Schema({
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  caption: { type: String, trim: true, maxlength: 2200, default: '' },
  imageUrl: { type: String, required: true },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
}, { timestamps: true });
postSchema.index({ createdAt: -1 });
module.exports = mongoose.model('Post', postSchema);
