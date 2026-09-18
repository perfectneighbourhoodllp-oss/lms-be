const User = require('../models/User');
const sendPush = require('./sendPush');

/**
 * Send an ANDROID/mobile PUSH (only — no in-app bell notification) to every
 * active admin when a new lead enters the system. Used for real-time,
 * one-at-a-time inbound (Meta Ads, WhatsApp unknown inbound, manual entry).
 * NOT used for batch imports (bulk CSV upload, sheet sync).
 *
 * Fire-and-forget; never throws.
 *
 * @param {object} lead              the created lead ({ _id, name, phone, source, assignedTo? })
 * @param {object} [opts]
 * @param {string|ObjectId} [opts.actorId]  the user who created it — skipped (no self-notify)
 */
const notifyNewLeadAdmins = async (lead, { actorId } = {}) => {
  try {
    if (!lead?._id) return;
    const admins = await User.find({ role: 'admin', isActive: true }).select('_id').lean();
    if (!admins.length) return;

    const where = lead.assignedTo ? '→ assigned' : '— unassigned';
    const title = 'New lead';
    const message = `${lead.name} (${lead.phone}) · ${lead.source || 'Other'} ${where}`;

    for (const a of admins) {
      if (actorId && String(a._id) === String(actorId)) continue; // don't notify the creator

      // Push only — deliberately NOT creating an in-app (bell) notification.
      sendPush(a._id, {
        title,
        body: message,
        data: { type: 'lead.new', leadId: String(lead._id) },
      });
    }
  } catch (err) {
    console.error('[NOTIFY] Failed to push new-lead alert to admins:', err.message);
  }
};

module.exports = notifyNewLeadAdmins;
