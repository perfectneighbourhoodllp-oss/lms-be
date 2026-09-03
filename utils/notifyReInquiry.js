const User = require('../models/User');
const transporter = require('../config/email');
const createNotification = require('./createNotification');
const sendPush = require('./sendPush');

/**
 * Notify the assigned agent that one of their leads re-inquired — i.e. a
 * duplicate Meta lead (same phone + project) submitted the form again. In-app
 * notification + mobile push + email. Fire-and-forget; never throws.
 */
const notifyReInquiry = async (agentId, lead) => {
  try {
    if (!agentId) return;
    const body = `${lead.name} (${lead.phone}) re-inquired via ${lead.source || 'Meta'}`;

    createNotification({
      userId: agentId,
      type: 'lead.reInquiry',
      title: '🔁 Lead re-inquired',
      message: body,
      relatedLead: lead._id,
    });

    sendPush(agentId, {
      title: '🔁 Lead re-inquired',
      body,
      data: { type: 'lead.reInquiry', leadId: String(lead._id) },
    });

    const agent = await User.findById(agentId).lean();
    if (!agent || !agent.email || !agent.isActive) return;

    const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
  <h2 style="color:#b45309">Lead Re-Inquiry</h2>
  <p>Hi ${agent.name}, a lead assigned to you has submitted a new enquiry form — they've shown interest again.</p>
  <table style="width:100%;border-collapse:collapse;margin-top:16px">
    <tr>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;font-weight:bold;background:#f9fafb;width:140px">Name</td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb">${lead.name}</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;font-weight:bold;background:#f9fafb">Phone</td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb">${lead.phone}</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;font-weight:bold;background:#f9fafb">Source</td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb">${lead.source || 'Meta'}</td>
    </tr>
  </table>
  <p style="margin-top:20px">A good moment to reconnect — please follow up.</p>
  <p style="color:#6b7280;margin-top:24px;font-size:13px">Sent by PNH Lead Management System</p>
</div>`;

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.MAIL_FROM,
      to: agent.email,
      subject: `🔁 Lead Re-Inquiry: ${lead.name} — PNH Lead MS`,
      html,
    });

    console.log(`[NOTIFY] Re-inquiry email sent to ${agent.email} for lead ${lead.name}`);
  } catch (err) {
    console.error('[NOTIFY] Failed to send re-inquiry notice:', err.message);
  }
};

module.exports = notifyReInquiry;
