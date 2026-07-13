const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 6 },
    role: { type: String, enum: ['admin', 'manager', 'sales'], default: 'sales' },
    phone: { type: String, trim: true },
    // The manager this user reports to. Managers see the leads of everyone who
    // reports to them (in addition to any project-scoped access). null = no manager.
    reportsTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isActive: { type: Boolean, default: true },
    // Self-managed: when false, user is excluded from new lead round-robin
    // assignment but can still log in and work existing leads.
    isAvailable: { type: Boolean, default: true },

    // FCM device tokens for mobile push notifications (one per installed device).
    // Registered by the app on login; invalid tokens are pruned on send.
    deviceTokens: { type: [String], default: [] },

    // Email-OTP login second factor (currently enforced only for role === 'admin').
    // Lifecycle:
    //   1. login() with valid password → server stores hash + expiry, emails OTP
    //   2. verifyLoginOtp() compares + clears these fields on success
    //   3. After 5 wrong attempts OR after expiry, user must re-submit password
    loginOtpHash: { type: String, select: false },
    loginOtpExpires: { type: Date, select: false },
    loginOtpAttempts: { type: Number, default: 0, select: false },
    loginOtpLastSentAt: { type: Date, select: false },
  },
  { timestamps: true }
);

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.matchPassword = function (entered) {
  return bcrypt.compare(entered, this.password);
};

module.exports = mongoose.model('User', userSchema);
