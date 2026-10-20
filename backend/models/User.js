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
  bio: { type: String, default: '', maxlength: 160 },
  avatarUrl: { type: String, default: '' }
}, {
  timestamps: true,
  toJSON: {
    transform(_doc, ret) {
      delete ret.passwordHash;
      delete ret.email;
      delete ret.__v;
      return ret;
    }
  }
});

userSchema.index({ username: 1 }, { unique: true });
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ googleId: 1 }, { unique: true, partialFilterExpression: { googleId: { $type: 'string' } } });

module.exports = mongoose.model('User', userSchema);

