const mongoose = require('mongoose');
const postSchema = new mongoose.Schema({
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  altText: { type: String, maxlength: 500, default: '' },
  caption: { type: String, trim: true, maxlength: 2200, default: '' },
  publicPlace: { lat: { type: Number, min: -90, max: 90 }, lng: { type: Number, min: -180, max: 180 }, label: { type: String, maxlength: 80 } },
  category: { type: String, maxlength: 40, default: '' },
  mood: { type: String, maxlength: 40, default: '' },
  tags: [{ type: String, maxlength: 50 }],
  imageUrl: { type: String, required: true },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
}, { timestamps: true });
postSchema.index({ createdAt: -1, _id: -1 });
postSchema.index({ caption: 'text', altText: 'text', tags: 'text' });
postSchema.index({ category: 1, createdAt: -1 });
module.exports = mongoose.model('Post', postSchema);
