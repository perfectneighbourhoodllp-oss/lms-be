const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    userName: { type: String },
    userEmail: { type: String },
    action: { type: String, required: true, index: true },
    resource: { type: String },
    resourceId: { type: String },
    details: { type: String },
    ip: { type: String },
    status: { type: String, enum: ['success', 'failed'], default: 'success' },
  },
  { timestamps: true }
);

activityLogSchema.index({ createdAt: -1 });
activityLogSchema.index({ user: 1, createdAt: -1 });

// TTL — auto-delete activity logs older than 180 days (6 months audit window).
// MongoDB's background task runs every ~60 seconds. The first sweep after
// this index is created will purge any existing logs older than 180d.
activityLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 180 * 24 * 60 * 60 }
);

module.exports = mongoose.model('ActivityLog', activityLogSchema);