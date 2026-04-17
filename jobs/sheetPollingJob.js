const cron = require('node-cron');
const SheetConfig = require('../models/SheetConfig');
const { syncSheet } = require('../controllers/sheetController');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const syncWithRetry = async (config) => {
  const name = config.label || config.sheetId;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await syncSheet(config);
      if (result.total > 0) {
        console.log(
          `[SHEET-POLL] Sheet "${name}": ${result.added} added, ${result.updated} updated, ${result.skipped} skipped`
        );
      }
      return;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        console.warn(`[SHEET-POLL] Sheet "${name}" failed (attempt ${attempt}/${MAX_RETRIES}): ${err.message} — retrying in ${RETRY_DELAY_MS / 1000}s`);
        await sleep(RETRY_DELAY_MS);
      } else {
        console.error(`[SHEET-POLL] Sheet "${name}" failed after ${MAX_RETRIES} attempts: ${err.message}`);
      }
    }
  }
};

const startSheetPollingJob = () => {
  const minutes = parseInt(process.env.SHEET_POLLING_INTERVAL_MINUTES || '5', 10);

  cron.schedule(`*/${minutes} * * * *`, async () => {
    console.log('[SHEET-POLL] Running sheet sync job...');

    try {
      const configs = await SheetConfig.find({ isActive: true });

      if (!configs.length) {
        console.log('[SHEET-POLL] No active sheet configs — skipping');
        return;
      }

      await Promise.all(configs.map(syncWithRetry));
    } catch (err) {
      console.error('[SHEET-POLL] Job failed:', err.message);
    }
  });

  console.log(`[CRON] Sheet polling job scheduled every ${minutes} minutes`);
};

module.exports = startSheetPollingJob;
