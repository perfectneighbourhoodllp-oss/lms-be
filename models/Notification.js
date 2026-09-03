const mongoose = require('mongoose');

const TYPES = ['lead.assigned', 'lead.remark', 'lead.followUp', 'lead.unassigned', 'lead.waHandoff', 'lead.reInquiry'];

const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: TYPES, required: true },
    title: { type: String, required: true },
    message: { type: String },
    relatedLead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    isRead: { type: Boolean, default: false },
    readAt: { type: Date },
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ user: 1, createdAt: -1 });

// TTL — auto-delete notifications older than 90 days.
// MongoDB's background task runs every ~60 seconds. The first sweep after
// this index is created will purge any existing notifications older than 90d.
notificationSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 }
);

module.exports = mongoose.model('Notification', notificationSchema);
module.exports.TYPES = TYPES;
