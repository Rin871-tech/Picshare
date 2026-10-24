const mongoose = require('mongoose');
const schema = new mongoose.Schema({ space: { type: mongoose.Schema.Types.ObjectId, ref: 'Space', required: true }, item: { type: mongoose.Schema.Types.ObjectId, ref: 'SpaceItem' }, author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, idempotencyKey: { type: String, maxlength: 64 }, text: { type: String, required: true, maxlength: 2000 } }, { timestamps: true });
schema.index({ item: 1, createdAt: 1 });
schema.index({ space: 1, author: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
module.exports = mongoose.model('SpaceComment', schema);
