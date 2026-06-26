const User = require('../models/User');
const transporter = require('../config/email');
const createNotification = require('./createNotification');
const sendPush = require('./sendPush');

/**
 * Send ONE summary notification when N leads are assigned to an agent in a bulk
 * action — instead of one-per-lead (which would spam the inbox/phone and blow
 * through email rate limits). In-app + push + a single email.
 *
 * Skips the actor (e.g. the admin who uploaded and assigned to themselves).
 * Fire-and-forget — failures are logged, never thrown.
 *
 * @param {string} agentId
 * @param {number} count
 * @param {string} actorId  - who triggered the upload (no self-notify)
 * @param {string} [context] - short label, e.g. "bulk upload"
 */
module.exports = async function notifyBulkAssignment(agentId, count, actorId, context = 'bulk upload') {
  try {
    if (!agentId || !count) return;
    if (actorId && String(actorId) === String(agentId)) return; // don't notify the uploader about their own upload

    const plural = count > 1 ? 's' : '';
    const title = `${count} new lead${plural} assigned`;
    const body = `You've been assigned ${count} new lead${plural} (${context}).`;

    createNotification({ userId: agentId, type: 'lead.assigned', title, message: body, actorId });
    sendPush(agentId, { title, body, data: { type: 'lead.bulkAssigned', count: String(count) } });

    const agent = await User.findById(agentId).lean();
    if (!agent || !agent.email || !agent.isActive) return;

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.MAIL_FROM,
      to: agent.email,
      subject: `🆕 ${count} new lead${plural} assigned to you — PNH Lead MS`,
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
  <h2 style="color:#1d4ed8">${count} New Lead${plural} Assigned</h2>
  <p>Hi ${agent.name}, you've been assigned <b>${count}</b> new lead${plural} via ${context}.</p>
  <p>Open the PNH Lead MS app to review and start following up.</p>
  <p style="color:#6b7280;margin-top:24px;font-size:13px">Sent by PNH Lead Management System</p>
</div>`,
    });

    console.log(`[NOTIFY] Bulk assignment summary sent to ${agent.email} (${count} leads)`);
  } catch (err) {
    console.error('[NOTIFY] Bulk assignment summary failed:', err.message);
  }
};
