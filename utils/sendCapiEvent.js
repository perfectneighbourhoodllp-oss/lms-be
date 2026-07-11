const crypto = require('crypto');
const CapiEvent = require('../models/CapiEvent');
const { graphRequest } = require('./metaGraph');

/**
 * Send a CRM lead event to Meta's Conversions API (CAPI).
 *
 * Follows Meta's "Send a CRM event" spec:
 *   action_source: "system_generated"
 *   custom_data.event_source: "crm"
 *   custom_data.lead_event_source: <our CRM name>
 *   user_data: { lead_id, em[], ph[] }   (lead_id raw; em/ph SHA-256 hashed)
 *
 * Safe by design: if the dataset id or access token isn't configured, it logs
 * the attempt as 'skipped' and returns — it never throws into the caller.
 * Always fire-and-forget from request handlers.
 *
 * @param {object} lead  lead doc with { _id, email, phone, metaLeadId }
 * @param {string} eventName  e.g. 'Lead' | 'Qualified' | 'Not Qualified'
 * @param {object} [opts]  { qualification, test, triggeredBy }
 * @returns {Promise<{status:string}>}
 */
const CRM_NAME = process.env.META_CAPI_SOURCE_NAME || 'PNH Lead MS';
const GRAPH_VERSION = process.env.META_CAPI_GRAPH_VERSION || process.env.META_GRAPH_VERSION || 'v25.0';

// Normalize + SHA-256 hash per Meta's requirements.
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const hashEmail = (email) => {
  const norm = String(email || '').trim().toLowerCase();
  return norm ? sha256(norm) : null;
};
const hashPhone = (phone) => {
  // Digits only, keep country code, drop the leading '+' and any spaces.
  const norm = String(phone || '').replace(/\D/g, '');
  return norm ? sha256(norm) : null;
};

async function sendCapiEvent(lead, eventName, opts = {}) {
  const { qualification = null, test = false, triggeredBy = null, now = Date.now() } = opts;
  const datasetId = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_TOKEN;

  const emHash = hashEmail(lead?.email);
  const phHash = hashPhone(lead?.phone);
  const leadId = lead?.metaLeadId || null;

  const baseLog = {
    lead: lead?._id,
    eventName,
    qualification,
    test,
    sentLeadId: Boolean(leadId),
    sentEmail: Boolean(emHash),
    sentPhone: Boolean(phHash),
    triggeredBy,
  };

  // Not configured yet → safe no-op (lets the field work before the token exists).
  if (!datasetId || !token) {
    await CapiEvent.create({ ...baseLog, status: 'skipped', error: 'CAPI not configured (META_PIXEL_ID / META_CAPI_TOKEN missing)' })
      .catch(() => {});
    return { status: 'skipped' };
  }

  const user_data = {};
  if (leadId) user_data.lead_id = /^\d+$/.test(String(leadId)) ? Number(leadId) : leadId;
  if (emHash) user_data.em = [emHash];
  if (phHash) user_data.ph = [phHash];

  const event = {
    event_name: eventName,
    event_time: Math.floor(now / 1000),
    action_source: 'system_generated',
    // Stable-ish id so Meta can dedupe retries of the same lead+event.
    event_id: `${lead?._id}-${eventName}`,
    custom_data: { event_source: 'crm', lead_event_source: CRM_NAME },
    user_data,
  };

  const params = {
    data: JSON.stringify([event]),
    access_token: token,
  };
  const testCode = test ? (opts.testCode || process.env.META_CAPI_TEST_CODE) : undefined;
  if (testCode) params.test_event_code = testCode;

  try {
    const res = await graphRequest('POST', `/${datasetId}/events`, params, GRAPH_VERSION);
    await CapiEvent.create({
      ...baseLog,
      status: (res.events_received >= 1) ? 'success' : 'failed',
      eventsReceived: res.events_received,
      fbTraceId: res.fbtrace_id,
      error: res.events_received >= 1 ? undefined : 'No events received by Meta',
    }).catch(() => {});
    console.log(`[CAPI] Sent "${eventName}" for lead ${lead?._id} — events_received=${res.events_received}`);
    return { status: 'success', res };
  } catch (err) {
    await CapiEvent.create({ ...baseLog, status: 'failed', error: err.message }).catch(() => {});
    console.error(`[CAPI] Failed to send "${eventName}" for lead ${lead?._id}:`, err.message);
    return { status: 'failed', error: err.message };
  }
}

// Which qualification values fire a CAPI event, and under what event name.
// All three lead outcomes are sent to Meta. (Converted uses a custom event
// name to match the CRM funnel stage; switch to 'Purchase' here if you prefer
// Meta's standard purchase event for optimization.)
const QUALIFICATION_EVENTS = {
  Qualified: 'Qualified',
  'Not Qualified': 'Not Qualified',
  Converted: 'Converted',
};

module.exports = sendCapiEvent;
module.exports.QUALIFICATION_EVENTS = QUALIFICATION_EVENTS;
module.exports.GRAPH_VERSION = GRAPH_VERSION;
