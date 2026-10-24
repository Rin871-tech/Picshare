const mongoose = require('mongoose');
const schema = new mongoose.Schema({ space: { type: mongoose.Schema.Types.ObjectId, ref: 'Space', required: true }, author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, filename: { type: String, required: true }, caption: { type: String, maxlength: 2200, default: '' } }, { timestamps: true });
schema.index({ space: 1, _id: -1 });
module.exports = mongoose.model('SpaceItem', schema);
