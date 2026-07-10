const mongoose = require('mongoose');

/**
 * A Facebook Page connected via the "Connect with Facebook" OAuth flow.
 * One document per Page. The Page access token is stored ENCRYPTED (see
 * utils/tokenCrypto) — never in plaintext.
 *
 * status:
 *   'pending' — connected/authorized but not yet subscribed to the webhook
 *   'active'  — subscribed to `leadgen`; leads flow into the CRM
 *   'error'   — last subscribe/lead-fetch failed (see lastError)
 */
const metaPageSchema = new mongoose.Schema(
  {
    pageId: { type: String, required: true, unique: true, trim: true },
    name: { type: String, trim: true, default: '' },
    // AES-256-GCM encrypted long-lived Page access token ("iv:tag:cipher")
    encToken: { type: String, required: true },
    igBusinessId: { type: String, trim: true, default: '' },
    status: {
      type: String,
      enum: ['pending', 'active', 'error'],
      default: 'pending',
    },
    lastError: { type: String, trim: true, default: '' },
    subscribedAt: { type: Date },
    // Optional default project — leads from this Page route here when no more
    // specific form/page MetaMapping matches.
    defaultProject: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null },
    connectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('MetaPage', metaPageSchema);
