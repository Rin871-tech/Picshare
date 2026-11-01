const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
  storage: { type: String, enum: ['local', 's3'], default: 'local' },
  objectKey: { type: String, select: false },
  filename: { type: String, required: true, unique: true }
}, { timestamps: true });
module.exports = mongoose.model('Attachment', schema);
