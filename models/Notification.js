const mongoose = require('mongoose');

const TYPES = ['lead.assigned', 'lead.remark', 'lead.followUp', 'lead.unassigned'];

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

module.exports = mongoose.model('Notification', notificationSchema);
module.exports.TYPES = TYPES;
