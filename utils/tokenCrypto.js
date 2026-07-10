const crypto = require('crypto');

/**
 * Symmetric encryption for Meta Page access tokens at rest.
 *
 * Uses AES-256-GCM with a 32-byte key from TOKEN_ENC_KEY (64 hex chars).
 * Format stored in the DB: "<ivHex>:<authTagHex>:<cipherHex>".
 *
 * Generate a key once with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 * and keep it stable — rotating it invalidates every stored token (Pages must
 * be reconnected).
 */

const ALGO = 'aes-256-gcm';

const getKey = () => {
  const hex = process.env.TOKEN_ENC_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'TOKEN_ENC_KEY must be set to 64 hex characters (32 bytes). ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, 'hex');
};

/** Encrypt a plaintext string → "iv:tag:cipher" (all hex). */
const encrypt = (plaintext) => {
  if (plaintext == null) return '';
  const key = getKey();
  const iv = crypto.randomBytes(12); // 96-bit nonce, recommended for GCM
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
};

/** Decrypt a "iv:tag:cipher" string → plaintext. Throws if tampered/invalid. */
const decrypt = (payload) => {
  if (!payload) return '';
  const [ivHex, tagHex, dataHex] = String(payload).split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('Malformed encrypted token');
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
};

/** True when a usable encryption key is configured (for graceful UI messaging). */
const isConfigured = () => {
  const hex = process.env.TOKEN_ENC_KEY;
  return Boolean(hex && hex.length === 64);
};

module.exports = { encrypt, decrypt, isConfigured };
