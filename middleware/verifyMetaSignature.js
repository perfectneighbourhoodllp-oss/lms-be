const crypto = require('crypto');

/**
 * Verifies that the incoming POST request is genuinely from Meta.
 * Meta signs the raw request body with your App Secret using HMAC-SHA256
 * and sends it in the X-Hub-Signature-256 header.
 *
 * IMPORTANT: This middleware must run AFTER express.raw() captures the body
 * as a Buffer — before express.json() parses it.
 *
 * GET requests (hub verification handshake) are passed through immediately.
 */
const verifyMetaSignature = (req, res, next) => {
  // GET = Meta verifying our endpoint — no signature on these
  if (req.method === 'GET') return next();

  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    console.error('[META] META_APP_SECRET is not set — cannot verify webhook signature');
    return res.status(500).json({ message: 'Webhook not configured' });
  }

  const sigHeader = req.headers['x-hub-signature-256'];
  if (!sigHeader || !sigHeader.startsWith('sha256=')) {
    console.warn('[META] Missing or malformed X-Hub-Signature-256 header');
    return res.status(403).json({ message: 'Missing signature' });
  }

  const received = sigHeader.slice('sha256='.length);

  // req.body at this point is a raw Buffer (from express.raw())
  const computed = crypto
    .createHmac('sha256', appSecret)
    .update(req.body)
    .digest('hex');

  // Constant-time comparison to prevent timing attacks
  let valid = false;
  try {
    valid = crypto.timingSafeEqual(
      Buffer.from(received, 'hex'),
      Buffer.from(computed, 'hex')
    );
  } catch {
    // Buffer lengths differ → invalid signature
    valid = false;
  }

  if (!valid) {
    console.warn('[META] Webhook signature verification failed');
    return res.status(403).json({ message: 'Invalid signature' });
  }

  // Parse body from Buffer → JSON for downstream handlers
  try {
    req.body = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ message: 'Invalid JSON body' });
  }

  next();
};

module.exports = verifyMetaSignature;
