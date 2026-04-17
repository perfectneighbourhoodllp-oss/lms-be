const mongoose = require('mongoose');

const sheetConfigSchema = new mongoose.Schema(
  {
    sheetId: { type: String, required: true, trim: true },
    gid: { type: String, default: '0', trim: true },
    sheetName: { type: String, trim: true, default: '' },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    columnMap: {
      name: { type: String, default: 'name' },
      phone: { type: String, default: 'phone' },
      email: { type: String, default: 'email' },
      source: { type: String, default: 'source' },
      notes: { type: String, default: 'notes' },
    },
    // Arbitrary custom field → sheet column header
    // e.g. { occupation: "Your Profession", city: "City", budget: "Budget Range" }
    customFieldMap: { type: mongoose.Schema.Types.Mixed, default: {} },
    lastSyncedRow: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    label: { type: String, trim: true },
  },
  { timestamps: true }
);

// Unique per sheet file + tab combination
sheetConfigSchema.index({ sheetId: 1, gid: 1 }, { unique: true });

const SheetConfig = mongoose.model('SheetConfig', sheetConfigSchema);

// Drop legacy single-field unique index from older schema (sheetId alone).
// Runs once at startup — no-op if the index doesn't exist.
SheetConfig.collection.dropIndex('sheetId_1').catch((err) => {
  if (err.codeName !== 'IndexNotFound') {
    console.warn('[SheetConfig] Could not drop legacy sheetId_1 index:', err.message);
  }
});

module.exports = SheetConfig;
