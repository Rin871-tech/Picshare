const mongoose = require('mongoose');
const schema = new mongoose.Schema({ key: { type: String, unique: true, required: true }, title: { type: String, maxlength: 100, required: true }, description: { type: String, maxlength: 1000 }, startsAt: { type: Date, required: true }, closesAt: { type: Date, required: true }, kind: { type: String, enum: ['daily', 'weekly'], default: 'daily' } }, { timestamps: true });
module.exports = mongoose.model('Challenge', schema);
