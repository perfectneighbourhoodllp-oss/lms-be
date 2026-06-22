const cron = require('node-cron');
const Lead = require('../models/Lead');
const { isWithinBusinessHours } = require('../utils/leadAcceptance');
const advancePendingLead = require('../utils/advancePendingLead');

/**
 * Reassign auto-assigned leads the current agent hasn't Accepted within 15 minutes.
 *
 * Rules (confirmed product behaviour):
 *  - Only acts between 10:00 AM – 6:30 PM IST (the timer is paused outside hours).
 *  - Moves the lead to the next eligible agent in the project's rotation who hasn't
 *    yet had a turn; resets the 15-min timer for them.
 *  - Once every eligible agent has had a turn unaccepted → escalate: keep it on the
 *    last agent, mark 'escalated', and notify admins/managers.
 *
 * Runs every minute (the deadline check gives ~1-min precision on the 15-min window).
 */
const processDueLeads = async () => {
  // Gate the whole job to business hours.
  if (!isWithinBusinessHours()) return;

  const now = new Date();
  const dueLeads = await Lead.find({
    acceptanceStatus: 'pending',
    acceptDeadline: { $lt: now },
  })
    .select('name phone source followUpDate project assignedTo triedAgents reassignmentCount')
    .lean();

  for (const lead of dueLeads) {
    try {
      // Timeout path → a sole eligible agent keeps the lead (re-armed), not escalated.
      const { action, next } = await advancePendingLead(lead, { now, rearmSingleAgent: true });
      if (action === 'reassigned') {
        console.log(`[REASSIGN] Lead ${lead._id} reassigned to ${next}`);
      } else if (action === 'escalated') {
        console.log(`[REASSIGN] Lead ${lead._id} escalated — no agent accepted after a full cycle`);
      }
    } catch (err) {
      console.error(`[REASSIGN] Failed for lead ${lead._id}:`, err.message);
    }
  }
};

const startLeadReassignmentJob = () => {
  cron.schedule('* * * * *', () => {
    processDueLeads().catch((err) => console.error('[REASSIGN] Job failed:', err.message));
  });
  console.log('[CRON] Lead acceptance/reassignment job scheduled every minute (10:00–18:30 IST)');
};

module.exports = startLeadReassignmentJob;
