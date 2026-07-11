const mongoose = require('mongoose');

/**
 * Audit log of Conversions API (CAPI) events sent to Meta.
 * One row per attempt — invaluable for debugging match quality and delivery.
 * No raw PII is stored (only whether hashed em/ph were included).
 *
 * status:
 *   'success'        — Meta accepted the event (events_received >= 1)
 *   'skipped'        — CAPI not configured (no dataset id / token) — safe no-op
 *   'failed'         — Meta returned an error
 */
const capiEventSchema = new mongoose.Schema(
  {
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    eventName: { type: String, trim: true },       // 'Lead' | 'Qualified' | 'Not Qualified' | …
    qualification: { type: String, trim: true },   // the lead outcome that triggered it (if any)
    test: { type: Boolean, default: false },        // sent with a test_event_code
    status: { type: String, enum: ['success', 'skipped', 'failed'], required: true },
    // Which match keys we sent (not the values)
    sentLeadId: { type: Boolean, default: false },
    sentEmail: { type: Boolean, default: false },
    sentPhone: { type: Boolean, default: false },
    // Meta response bits
    eventsReceived: { type: Number },
    fbTraceId: { type: String, trim: true },
    error: { type: String, trim: true },
    triggeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

capiEventSchema.index({ createdAt: -1 });
capiEventSchema.index({ lead: 1, eventName: 1 });

module.exports = mongoose.model('CapiEvent', capiEventSchema);
