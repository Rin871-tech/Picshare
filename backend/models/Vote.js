const mongoose = require('mongoose');
const schema = new mongoose.Schema({ challenge: { type: mongoose.Schema.Types.ObjectId, ref: 'Challenge', required: true }, user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, entry: { type: mongoose.Schema.Types.ObjectId, ref: 'Entry', required: true } }, { timestamps: true });
schema.index({ challenge: 1, user: 1 }, { unique: true });
schema.index({ entry: 1 });
module.exports = mongoose.model('Vote', schema);
