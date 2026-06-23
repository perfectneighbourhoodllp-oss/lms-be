require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const connectDB = require('./config/db');
const errorHandler = require('./middleware/errorHandler');
const startReminderJob = require('./jobs/reminderJob');
const startSheetPollingJob = require('./jobs/sheetPollingJob');
const startFollowUpReminderJob = require('./jobs/followUpReminderJob');
const startLeadReassignmentJob = require('./jobs/leadReassignmentJob');
const verifyMetaSignature = require('./middleware/verifyMetaSignature');

const app = express();

// Database
connectDB();

// CORS: allow the main client URL + any Vercel preview deployment for the project
const allowedOrigins = [
  process.env.CLIENT_URL || 'http://localhost:5173',
  'http://localhost:5173',
  // Native mobile app (Capacitor) webview origins
  'capacitor://localhost',
  'https://localhost',
  'http://localhost',
  'ionic://localhost',
];
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. server-to-server, curl)
    if (!origin) return callback(null, true);
    // Allow exact matches
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Allow any Vercel preview URL for this project
    if (/^https:\/\/lms-.*\.vercel\.app$/.test(origin)) return callback(null, true);
    if (/^https:\/\/.*perfectneighbourhoodllp-oss-projects\.vercel\.app$/.test(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

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
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/expenses', require('./routes/expenses'));
app.use('/api/attendance', require('./routes/attendance'));

// Health check
app.get('/api/health', (_, res) => res.json({ status: 'ok', env: process.env.NODE_ENV }));

// Error handler (must be last)
app.use(errorHandler);

// Start cron job
if (process.env.NODE_ENV !== 'test') {
  startReminderJob();
  startSheetPollingJob();
  startFollowUpReminderJob();
  startLeadReassignmentJob();
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 Meta webhook endpoint: POST /api/webhook/meta`);
  if (!process.env.META_APP_SECRET) {
    console.warn('⚠️  META_APP_SECRET not set — webhook signature verification will reject all requests');
  }
  // Push notification status (so you can see at a glance if it's configured)
  const { getMessagingClient } = require('./config/firebase');
  if (process.env.PUSH_ENABLED !== 'true') {
    console.log('🔕 [PUSH] disabled — set PUSH_ENABLED=true to enable mobile notifications');
  } else if (getMessagingClient()) {
    console.log('🔔 [PUSH] enabled and ready');
  } else {
    console.warn('⚠️  [PUSH] PUSH_ENABLED=true but Firebase not ready — check FIREBASE_SERVICE_ACCOUNT');
  }
});
