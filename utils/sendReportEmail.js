const transporter = require('../config/email');
const buildReportEmail = require('./buildReportEmail');

const fmtDateIST = (d) =>
  new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' });

/**
 * Email a computed report to the given recipients. Returns the nodemailer result.
 * @param {{from,to,agents,totals}} report
 * @param {string[]} recipients
 * @param {string} periodLabel
 */
module.exports = async function sendReportEmail(report, recipients, periodLabel = 'Daily') {
  if (!recipients || !recipients.length) throw new Error('No recipients configured');

  const html = buildReportEmail(report, periodLabel);
  const subject = `📊 ${periodLabel} Agent Report — ${fmtDateIST(report.to)} — PNH Lead MS`;

  const info = await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.MAIL_FROM,
    to: recipients.join(', '),
    subject,
    html,
  });
  console.log(`[REPORT] ${periodLabel} report emailed to ${recipients.length} recipient(s)`);
  return info;
};
