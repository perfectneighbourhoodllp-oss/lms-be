const { parsePhoneNumberFromString } = require('libphonenumber-js');

/**
 * Canonicalize a phone number using libphonenumber-js.
 * Returns E.164 format like "+918334075585" — international standard.
 *
 * - Default country is India ('IN') for numbers without a country code
 * - Strips non-phone prefixes automatically (e.g. "p: +91...")
 * - Returns "" for invalid or unparseable input (rejects "12345", "abc", etc.)
 *
 * Examples:
 *   "+91 98765 43210"  → "+919876543210"
 *   "919876543210"     → "+919876543210"
 *   "9876543210"       → "+919876543210"
 *   "p: +918334075585" → "+918334075585"
 *   "+971 55 226 8400" → "+971552268400"
 *   "12345"            → ""  (invalid, too short)
 *   null / ""          → ""
 */
module.exports = function cleanPhone(raw = '') {
  if (!raw) return '';
  try {
    const phone = parsePhoneNumberFromString(String(raw), 'IN');
    if (!phone || !phone.isValid()) return '';
    return phone.number; // E.164 format
  } catch {
    return '';
  }
};
