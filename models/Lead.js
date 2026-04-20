const mongoose = require('mongoose');

const SOURCES = ['Instagram', 'Ads', 'Referral', 'Walk-in', 'Website', 'Other'];
const STATUSES = ['New', 'Called', 'Interested', 'Site Visit', 'Closed'];

const leadSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // Stored in E.164 international format via utils/cleanPhone (libphonenumber-js).
    //   Indian numbers: "+919876543210"
    //   Other countries: "+971552268400", "+15551234567", etc.
    // Invalid input (e.g. "12345") returns empty string and rejects creation.
    phone: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    source: { type: String, enum: SOURCES, default: 'Other' },
    status: { type: String, enum: STATUSES, default: 'New' },
    notes: { type: String, trim: true },
    followUpDate: { type: Date },
    followUpNotifiedAt: { type: Date },
    lastContactedAt: { type: Date },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
    remarks: [
      {
        text: { type: String, required: true, trim: true },
        addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    // Arbitrary custom fields imported from sheets (e.g. occupation, city, budget)
    customFields: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Meta Lead Ads integration
    metaLeadId: { type: String, sparse: true, trim: true },
    metaAdName: { type: String, trim: true },
    metaFormId: { type: String, trim: true },
  },
  { timestamps: true }
);

leadSchema.index({ assignedTo: 1, followUpDate: 1, status: 1 });
leadSchema.index({ metaLeadId: 1 }, { sparse: true });

// A lead is unique by phone + project. Same person can have separate leads
// for different projects (each is a separate opportunity).
// Used for efficient dedup lookups and as a unique constraint.
leadSchema.index({ phone: 1, project: 1 }, { unique: true });

const Lead = mongoose.model('Lead', leadSchema);

// Drop legacy unique index on `phone` alone (from older schema).
// Runs once at startup — no-op if the index doesn't exist.
Lead.collection.dropIndex('phone_1').catch((err) => {
  if (err.codeName !== 'IndexNotFound') {
    console.warn('[Lead] Could not drop legacy phone_1 index:', err.message);
  }
});

module.exports = Lead;
module.exports.SOURCES = SOURCES;
module.exports.STATUSES = STATUSES;
