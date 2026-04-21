const User = require('../models/User');
const transporter = require('../config/email');

/**
 * Send an email notification to a sales agent when a lead is assigned to them.
 * Fires and forgets — errors are logged but never thrown.
 */
const notifyAssignment = async (agentId, lead) => {
  try {
    if (!agentId) return;

    const agent = await User.findById(agentId).lean();
    if (!agent || !agent.email || !agent.isActive) return;

    const followUp = lead.followUpDate
      ? new Date(lead.followUpDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
      : 'Not set';

    const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
  <h2 style="color:#1d4ed8">New Lead Assigned to You</h2>
  <p>Hi ${agent.name}, a new lead has been assigned to you.</p>
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
      <td style="padding:8px 12px;border:1px solid #e5e7eb">${lead.source || 'Other'}</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;font-weight:bold;background:#f9fafb">Follow-Up</td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb">${followUp}</td>
    </tr>
    ${lead.notes ? `<tr>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;font-weight:bold;background:#f9fafb">Notes</td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb">${lead.notes}</td>
    </tr>` : ''}
  </table>
  <p style="margin-top:20px">Please follow up at the earliest.</p>
  <p style="color:#6b7280;margin-top:24px;font-size:13px">Sent by PNH Lead Management System</p>
</div>`;

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.MAIL_FROM,
      to: agent.email,
      subject: `🆕 New Lead Assigned: ${lead.name} — PNH Lead MS`,
      html,
    });

    console.log(`[NOTIFY] Assignment email sent to ${agent.email} for lead ${lead.name}`);
  } catch (err) {
    console.error(`[NOTIFY] Failed to send assignment email:`, err.message);
  }
};

module.exports = notifyAssignment;
