/**
 * One-time backfill: re-cleans every lead's phone using the canonical
 * cleanPhone helper. Useful after consolidating the inconsistent
 * cleanPhone implementations.
 *
 * Run from /server: npm run backfill-phones
 *
 * Behavior:
 *   - Iterates every Lead doc
 *   - Computes canonical phone via cleanPhone()
 *   - If different from stored phone, attempts an update
 *   - If the update would violate the unique (phone, project) index
 *     (i.e. a duplicate exists with the canonical form), skips and logs
 *     so admin can manually merge.
 */
require('dotenv').config({ path: '../.env' });
require('dotenv').config();
const mongoose = require('mongoose');
const Lead = require('../models/Lead');
const cleanPhone = require('../utils/cleanPhone');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/realestate-crm';

(async () => {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('Connected.\n');

  const leads = await Lead.find({}, '_id phone project').lean();
  console.log(`Scanning ${leads.length} leads...\n`);

  let updated = 0;
  let unchanged = 0;
  let conflicts = 0;
  let errors = 0;

  for (const lead of leads) {
    const canonical = cleanPhone(lead.phone);

    if (canonical === lead.phone) {
      unchanged++;
      continue;
    }

    // Pre-check: would this collide with an existing canonical lead in the same project?
    const conflict = await Lead.findOne({
      _id: { $ne: lead._id },
      phone: canonical,
      project: lead.project || null,
    }).lean();

    if (conflict) {
      conflicts++;
      console.warn(
        `[CONFLICT] Lead ${lead._id} (phone "${lead.phone}" → "${canonical}") would duplicate existing lead ${conflict._id} on same project. SKIPPED — please merge manually.`
      );
      continue;
    }

    try {
      await Lead.updateOne({ _id: lead._id }, { $set: { phone: canonical } });
      updated++;
    } catch (err) {
      errors++;
      console.error(`[ERROR] Failed to update lead ${lead._id}:`, err.message);
    }
  }

  console.log('\n─── Backfill Summary ───────────────────');
  console.log(`Updated:    ${updated}`);
  console.log(`Unchanged:  ${unchanged}`);
  console.log(`Conflicts:  ${conflicts} (need manual merge)`);
  console.log(`Errors:     ${errors}`);
  console.log('────────────────────────────────────────\n');

  await mongoose.disconnect();
  process.exit(0);
})();
