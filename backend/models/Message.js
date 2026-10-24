const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // Message types: text | image | post_share | location | live_location | call_summary | reply
  type: {
    type: String,
    enum: ['text', 'image', 'post_share', 'location', 'live_location', 'call_summary', 'reaction'],
    default: 'text',
    required: true
  },

  // Main content (plain text or caption for images)
  text: { type: String, trim: true, maxlength: 4000, default: '' },

  // For image messages
  imageUrl: { type: String, default: '' },

  // For post_share messages
  postRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },

  // For location / live_location messages
  location: {
    lat: { type: Number, min: -90, max: 90 },
    lng: { type: Number, min: -180, max: 180 },
    label: { type: String, maxlength: 200 },
    sharedAt: { type: Date },
    sessionId: { type: mongoose.Schema.Types.ObjectId } // live session ref
  },

  // For call_summary messages
  callRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Call' },

  // Reply threading
  replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },

  // Delivery state: pending → sent → delivered → read
  deliveryState: {
    type: String,
    enum: ['sent', 'delivered', 'read'],
    default: 'sent'
  },

  // Read receipts: { userId: timestamp }
  readBy: { type: Map, of: Date, default: {} },

  // Deduplication — client supplies a UUID per send attempt
  idempotencyKey: { type: String, maxlength: 64 },

  reactions: { type: Map, of: String, default: {} },

  // Edit / delete
  edited: { type: Boolean, default: false },
  editedAt: { type: Date },
  deleted: { type: Boolean, default: false },
  deletedAt: { type: Date }
}, { timestamps: true });

messageSchema.index({ conversation: 1, createdAt: -1, _id: -1 });
// Dedup index — sparse so null keys don't conflict
messageSchema.index(
  { conversation: 1, sender: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

module.exports = mongoose.model('Message', messageSchema);
