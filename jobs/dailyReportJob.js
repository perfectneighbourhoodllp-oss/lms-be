const cron = require('node-cron');
const ReportSetting = require('../models/ReportSetting');
const { computeAgentReport, parseRange, filterReportForEmail } = require('../controllers/reportController');
const sendReportEmail = require('../utils/sendReportEmail');

/**
 * Emails the day's agent activity report to the configured recipients at 10:00 PM IST.
 * No-op when disabled or when no recipients are set.
 */
const startDailyReportJob = () => {
  cron.schedule(
    '0 22 * * *', // 22:00 every day
    async () => {
      try {
        const s = await ReportSetting.getSingleton();
        if (!s.dailyEmailEnabled || !s.recipients.length) return;

        const { start, end } = parseRange(); // today (IST)
        const report = await computeAgentReport(start, end);
        const emailReport = filterReportForEmail(report, s.emailExcludedAgents || []);
        await sendReportEmail(emailReport, s.recipients, 'Daily');
      } catch (err) {
        console.error('[REPORT] Daily report job failed:', err.message);
      }
    },
    { timezone: 'Asia/Kolkata' }
  );

  console.log('[CRON] Daily report email job scheduled at 10:00 PM IST');
};

module.exports = startDailyReportJob;
