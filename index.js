require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const connectDB = require('./config/db');
const errorHandler = require('./middleware/errorHandler');
const startReminderJob = require('./jobs/reminderJob');
const startSheetPollingJob = require('./jobs/sheetPollingJob');
const startFollowUpReminderJob = require('./jobs/followUpReminderJob');
const verifyMetaSignature = require('./middleware/verifyMetaSignature');

const app = express();

// Database
connectDB();

app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173', credentials: true }));

// ─── CRITICAL: Webhook raw body capture MUST come before express.json() ───────
// Meta signature verification requires the raw Buffer — express.json() destroys it.
// Scoped to /api/webhook/meta so other webhook routes (mappings, logs) are unaffected.
app.use(
  '/api/webhook/meta',
  express.raw({ type: 'application/json', limit: '1mb' }),
  verifyMetaSignature
);
// ──────────────────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(morgan('dev'));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/users', require('./routes/users'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/webhook', require('./routes/webhook'));
app.use('/api/sheets', require('./routes/sheets'));
app.use('/api/activity-logs', require('./routes/activityLogs'));

// Health check
app.get('/api/health', (_, res) => res.json({ status: 'ok', env: process.env.NODE_ENV }));

// Error handler (must be last)
app.use(errorHandler);

// Start cron job
if (process.env.NODE_ENV !== 'test') {
  startReminderJob();
  startSheetPollingJob();
  startFollowUpReminderJob();
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 Meta webhook endpoint: POST /api/webhook/meta`);
  if (!process.env.META_APP_SECRET) {
    console.warn('⚠️  META_APP_SECRET not set — webhook signature verification will reject all requests');
  }
});
