const cron = require('node-cron');
const Lead = require('../models/Lead');
const User = require('../models/User');
const transporter = require('../config/email');

const fmt = (date) =>
  date ? new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

const buildEmailHtml = (userName, leads) => `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
  <h2 style="color:#1d4ed8">Good morning, ${userName}! ☀️</h2>
  <p>You have <strong>${leads.length} follow-up(s)</strong> scheduled for today.</p>
  <table style="width:100%;border-collapse:collapse;margin-top:16px">
    <thead>
      <tr style="background:#eff6ff">
        <th style="padding:8px 12px;text-align:left;border:1px solid #dbeafe">Name</th>
        <th style="padding:8px 12px;text-align:left;border:1px solid #dbeafe">Phone</th>
        <th style="padding:8px 12px;text-align:left;border:1px solid #dbeafe">Status</th>
        <th style="padding:8px 12px;text-align:left;border:1px solid #dbeafe">Follow-Up</th>
      </tr>
    </thead>
    <tbody>
      ${leads
        .map(
          (l) => `
        <tr>
          <td style="padding:8px 12px;border:1px solid #e5e7eb">${l.name}</td>
          <td style="padding:8px 12px;border:1px solid #e5e7eb">${l.phone}</td>
          <td style="padding:8px 12px;border:1px solid #e5e7eb">${l.status}</td>
          <td style="padding:8px 12px;border:1px solid #e5e7eb">${fmt(l.followUpDate)}</td>
        </tr>`
        )
        .join('')}
    </tbody>
  </table>
  <p style="color:#6b7280;margin-top:24px;font-size:13px">Sent by PNH Lead Management System — have a productive day!</p>
</div>
`;

/** Runs daily at 9:00 AM server time */
const startReminderJob = () => {
  cron.schedule('0 9 * * *', async () => {
    console.log('[CRON] Running daily follow-up reminder job...');

    try {
      const today = new Date();
      const start = new Date(today.setHours(0, 0, 0, 0));
      const end = new Date(today.setHours(23, 59, 59, 999));

      // Get all active users (sales, managers, admins) with follow-ups today
      const activeUsers = await User.find({ isActive: true }).lean();

      for (const user of activeUsers) {
        const leads = await Lead.find({
          assignedTo: user._id,
          followUpDate: { $gte: start, $lte: end },
        }).lean();

        if (!leads.length) continue;
        if (!user.email) continue;

        await transporter.sendMail({
          from: process.env.EMAIL_FROM || process.env.MAIL_FROM,
          to: user.email,
          subject: `📅 ${leads.length} Follow-up(s) Today — PNH Lead MS`,
          html: buildEmailHtml(user.name, leads),
        });

        console.log(`[CRON] Reminder sent to ${user.email} (${leads.length} leads)`);
      }
    } catch (err) {
      console.error('[CRON] Reminder job failed:', err.message);
    }
  });

  console.log('[CRON] Daily reminder job scheduled at 9:00 AM');
};

module.exports = startReminderJob;
