/**
 * Canonicalize a phone number for storage and duplicate matching.
 *
 * Rules:
 *  - Strip all non-digit characters (spaces, dashes, parens, plus signs, etc.)
 *  - For India numbers: trim leading "91" country code (12 digits → 10)
 *  - For local format with leading "0": trim it (11 digits starting with 0 → 10)
 *  - Other international numbers keep their country code
 *
 * Examples:
 *  "+91 98765 43210" → "9876543210"
 *  "919876543210"    → "9876543210"
 *  "09876543210"     → "9876543210"
 *  "9876543210"      → "9876543210"
 *  "(98765) 43210"   → "9876543210"
 *  "+1 555-123-4567" → "15551234567"
 *  null / ""         → ""
 */
module.exports = function cleanPhone(raw = '') {
  if (raw === null || raw === undefined) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
};
