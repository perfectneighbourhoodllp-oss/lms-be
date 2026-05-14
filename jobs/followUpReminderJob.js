const cron = require('node-cron');
const Lead = require('../models/Lead');
const User = require('../models/User');
const transporter = require('../config/email');
const createNotification = require('../utils/createNotification');

const fmtTime = (d) =>
  new Date(d).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });

const waLink = (phone) => `https://wa.me/${phone.replace(/\D/g, '')}`;

const buildEmail = (lead) => {
  const projectName = lead.project?.name
    ? (lead.project.developer ? `${lead.project.name} (${lead.project.developer})` : lead.project.name)
    : null;

  return `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
  <h2 style="color:#1d4ed8">Follow-Up Reminder</h2>
  <p>It's time to follow up with <strong>${lead.name}</strong>.</p>
  <table style="width:100%;border-collapse:collapse;margin-top:16px">
    <tr>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;font-weight:bold;background:#f9fafb;width:140px">Name</td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb">${lead.name}</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;font-weight:bold;background:#f9fafb">Phone</td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb">
        <a href="tel:${lead.phone}">${lead.phone}</a> ·
        <a href="${waLink(lead.phone)}">WhatsApp</a>
      </td>
    </tr>
    ${projectName ? `<tr>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;font-weight:bold;background:#f9fafb">Project</td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb">🏗 ${projectName}</td>
    </tr>` : ''}
    <tr>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;font-weight:bold;background:#f9fafb">Status</td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb">${lead.status}</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;font-weight:bold;background:#f9fafb">Follow-Up</td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb">${fmtTime(lead.followUpDate)}</td>
    </tr>
    ${lead.notes ? `<tr>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;font-weight:bold;background:#f9fafb">Notes</td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb">${lead.notes}</td>
    </tr>` : ''}
  </table>
  <p style="color:#6b7280;margin-top:24px;font-size:13px">Sent by PNH Lead Management System</p>
</div>`;
};

/** Runs every 5 minutes — sends reminder emails for follow-ups that are due */
const startFollowUpReminderJob = () => {
  cron.schedule('*/5 * * * *', async () => {
    try {
      const now = new Date();
      // Look for follow-ups due within the next 5 minutes
      const windowEnd = new Date(now.getTime() + 5 * 60 * 1000);

      const leads = await Lead.find({
        followUpDate: { $gte: new Date(now.getTime() - 5 * 60 * 1000), $lte: windowEnd },
        status: { $nin: ['Closed', 'Not Interested', 'Dead'] },
        $or: [
          { followUpNotifiedAt: null },
          { followUpNotifiedAt: { $exists: false } },
          // Notified before the current followUpDate — means the date was rescheduled after the last notification
          { $expr: { $lt: ['$followUpNotifiedAt', '$followUpDate'] } },
        ],
      })
        .populate('assignedTo', 'name email isActive')
        .populate('project', 'name developer')
        .lean();

      // Filter out date-only follow-ups (no time specified — stored at 00:00).
      // Those are handled by the daily 9 AM summary email instead.
      const withTime = leads.filter((l) => {
        const dt = new Date(l.followUpDate);
        return dt.getHours() !== 0 || dt.getMinutes() !== 0;
      });

      if (!withTime.length) return;

      for (const lead of withTime) {
        if (!lead.assignedTo || !lead.assignedTo.isActive) continue;

        // In-app notification (works regardless of email config)
        createNotification({
          userId: lead.assignedTo._id,
          type: 'lead.followUp',
          title: `Follow-up due: ${lead.name}`,
          message: `${lead.phone} — scheduled for ${fmtTime(lead.followUpDate)}`,
          relatedLead: lead._id,
        });

        // Mark as notified so we don't fire again for this same followUpDate
        await Lead.updateOne(
          { _id: lead._id },
          { $set: { followUpNotifiedAt: new Date() } }
        );

        // Try to send email if SMTP is configured
        if (lead.assignedTo.email) {
          try {
            await transporter.sendMail({
              from: process.env.EMAIL_FROM || process.env.MAIL_FROM,
              to: lead.assignedTo.email,
              subject: `⏰ Follow-up Reminder: ${lead.name} — PNH Lead MS`,
              html: buildEmail(lead),
            });
            console.log(`[REMINDER] Follow-up email sent to ${lead.assignedTo.email} for lead ${lead.name}`);
          } catch (err) {
            console.error(`[REMINDER] Failed to send reminder email for lead ${lead._id}:`, err.message);
          }
        }
      }
    } catch (err) {
      console.error('[REMINDER] Job failed:', err.message);
    }
  });

  console.log('[CRON] Follow-up reminder job scheduled every 5 minutes');
};

module.exports = startFollowUpReminderJob;
