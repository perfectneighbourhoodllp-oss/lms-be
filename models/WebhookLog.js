const mongoose = require('mongoose');

/**
 * Every incoming Meta webhook event is logged here — win or fail.
 * This serves as an audit trail AND a recovery mechanism:
 * if a lead failed to save, an admin can see it here and retry manually.
 */
const webhookLogSchema = new mongoose.Schema(
  {
    // Meta identifiers
    metaLeadId: { type: String, trim: true },
    metaFormId: { type: String, trim: true },
    metaPageId: { type: String, trim: true },
    metaAdId: { type: String, trim: true },
    metaAdName: { type: String, trim: true },

    // Raw lead data received from Graph API
    rawPayload: { type: mongoose.Schema.Types.Mixed },

    // Extracted fields
    extractedName: { type: String, trim: true },
    extractedPhone: { type: String, trim: true },
    extractedEmail: { type: String, trim: true },

    // Processing result
    status: {
      type: String,
      enum: ['success', 'duplicate', 'failed', 'skipped'],
      default: 'success',
    },
    error: { type: String, trim: true },

    // If a lead was created/updated, link it
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    isDuplicate: { type: Boolean, default: false },
  },
  { timestamps: true }
);

webhookLogSchema.index({ createdAt: -1 });
webhookLogSchema.index({ status: 1, createdAt: -1 });
webhookLogSchema.index({ metaLeadId: 1 });

module.exports = mongoose.model('WebhookLog', webhookLogSchema);
