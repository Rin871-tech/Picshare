const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
  filename: { type: String, required: true, unique: true }
}, { timestamps: true });
module.exports = mongoose.model('Attachment', schema);
