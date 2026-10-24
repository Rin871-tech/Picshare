const mongoose = require('mongoose');
const schema = new mongoose.Schema({ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true }, status: { type: String, enum: ['requested', 'cancelled'], default: 'requested' } }, { timestamps: true });
module.exports = mongoose.model('DeletionRequest', schema);
