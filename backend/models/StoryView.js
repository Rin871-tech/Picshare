const mongoose = require('mongoose');
const schema = new mongoose.Schema({ story: { type: mongoose.Schema.Types.ObjectId, ref: 'Story', required: true }, viewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, reaction: { type: String, enum: ['', '❤️', '✨', '👏'], default: '' } }, { timestamps: true });
schema.index({ story: 1, viewer: 1 }, { unique: true });
module.exports = mongoose.model('StoryView', schema);
