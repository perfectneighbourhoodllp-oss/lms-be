const mongoose = require('mongoose');

const STATUSES = ['success', 'duplicate', 'skipped', 'failed'];
const SOURCES = ['webhook', 'polling', 'manual'];

/**
 * Per-row outcome log for Google Sheets → CRM lead imports.
 *
 * Created every time we process a row (whether the row results in a new lead,
 * an update to an existing lead, a skip due to validation, or an outright
 * failure). Lets admins answer "why didn't that lead make it into the CRM?"
 * without re-reading server logs.
 *
 * Auto-purged after 30 days via TTL index.
 */
const sheetSyncLogSchema = new mongoose.Schema(
  {
    sheetConfig: { type: mongoose.Schema.Types.ObjectId, ref: 'SheetConfig' },
    sheetId: { type: String, trim: true, index: true },
    gid: { type: String, trim: true },

    // Where the row came from in our pipeline
    source: { type: String, enum: SOURCES, required: true },

    // Row number in the sheet (1-indexed, only available for polling)
    rowNumber: { type: Number },

    // Full raw row payload as received — useful for replay/debugging
    rawRow: { type: mongoose.Schema.Types.Mixed },

    // Extracted snapshot for quick scanning without inspecting rawRow
    extractedName: { type: String, trim: true },
    extractedPhone: { type: String, trim: true },
    extractedEmail: { type: String, trim: true },

    // Outcome
    status: { type: String, enum: STATUSES, required: true, index: true },
    reason: { type: String, trim: true },                  // human-readable error or note

    // Populated on success/duplicate
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
  },
  { timestamps: true }
);

sheetSyncLogSchema.index({ sheetConfig: 1, createdAt: -1 });
sheetSyncLogSchema.index({ status: 1, createdAt: -1 });
sheetSyncLogSchema.index({ createdAt: -1 });

// TTL — auto-purge after 30 days. Lets MongoDB clean these up automatically.
sheetSyncLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 }
);

const SheetSyncLog = mongoose.model('SheetSyncLog', sheetSyncLogSchema);

module.exports = SheetSyncLog;
module.exports.STATUSES = STATUSES;
module.exports.SOURCES = SOURCES;
