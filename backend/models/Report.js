const mongoose = require('mongoose');
const schema = new mongoose.Schema({ reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, targetType: { type: String, enum: ['user', 'post'], required: true }, target: { type: mongoose.Schema.Types.ObjectId, required: true }, reason: { type: String, required: true, maxlength: 1000 }, status: { type: String, enum: ['open', 'reviewing', 'resolved', 'dismissed'], default: 'open' } }, { timestamps: true });
schema.index({ reporter: 1, targetType: 1, target: 1 }, { unique: true });
module.exports = mongoose.model('Report', schema);
