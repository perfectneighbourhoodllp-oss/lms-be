const fs = require('fs');
const path = require('path');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

// Load the Firebase service-account credentials. Three supported sources, in order:
//   1. FIREBASE_SERVICE_ACCOUNT_PATH  → path to the downloaded JSON file (best for local dev)
//   2. FIREBASE_SERVICE_ACCOUNT_BASE64 → base64 of the JSON (best for Render/production)
//   3. FIREBASE_SERVICE_ACCOUNT        → raw JSON string (error-prone; last resort)
function loadServiceAccount() {
  const filePath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (filePath) {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  }
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (b64) return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) return JSON.parse(raw);
  return null;
}

let messaging = null;
let initTried = false;

function getMessagingClient() {
  if (initTried) return messaging;
  initTried = true;

  if (process.env.PUSH_ENABLED !== 'true') return null;

  try {
    const serviceAccount = loadServiceAccount();
    if (!serviceAccount) {
      console.warn('[PUSH] PUSH_ENABLED=true but no service account configured — push disabled');
      return null;
    }
    if (!getApps().length) {
      initializeApp({ credential: cert(serviceAccount) });
    }
    messaging = getMessaging();
    console.log('[PUSH] Firebase Admin initialised');
  } catch (err) {
    console.error('[PUSH] Failed to initialise Firebase Admin:', err.message);
    messaging = null;
  }
  return messaging;
}

module.exports = { getMessagingClient };
