const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, trim: true, lowercase: true, minlength: 3, maxlength: 24, match: /^[a-z0-9_.]+$/ },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
  passwordHash: {
    type: String,
    select: false,
    required: function() {
      return !this.googleId;
    }
  },
  googleId: { type: String, trim: true },
  contactDiscoverable: { type: Boolean, default: false },
  bio: { type: String, default: '', maxlength: 160 },
  avatarUrl: { type: String, default: '' },
  website: { type: String, maxlength: 200, default: '' },
  categories: [{ type: String, maxlength: 40 }],
  pinnedPosts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Post' }],
  privacy: {
    account: { type: String, enum: ['public', 'private'], default: 'public' },
    messages: { type: String, enum: ['everyone', 'following', 'nobody'], default: 'everyone' },
    calls: { type: String, enum: ['everyone', 'following', 'nobody'], default: 'everyone' },
    stories: { type: String, enum: ['public', 'followers'], default: 'public' },
    notifications: { type: Boolean, default: true }
  }

}, {
  timestamps: true,
  toJSON: {
    transform(_doc, ret) {
      delete ret.passwordHash;
      delete ret.email;
      delete ret.contactDiscoverable;
      delete ret.__v;
      delete ret.privacy;
      return ret;
    }
  }
});

userSchema.index({ username: 1 }, { unique: true });
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ googleId: 1 }, { unique: true, partialFilterExpression: { googleId: { $type: 'string' } } });

module.exports = mongoose.model('User', userSchema);

