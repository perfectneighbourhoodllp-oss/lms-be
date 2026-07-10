const Lead = require('../models/Lead');
const notifyAssignment = require('./notifyAssignment');
const notifyUnassigned = require('./notifyUnassigned');
const { ACCEPT_WINDOW_MIN, eligibleAgentIds, eligibleAgentIdsFromPool, nextUntriedAgent } = require('./leadAcceptance');

/**
 * Move a still-pending lead to the next untried agent in the project's rotation,
 * or escalate when nobody is left. Shared by the 15-min reassignment cron and the
 * explicit "Reject" action so both behave identically.
 *
 * @param {object} lead  lean lead doc with { _id, project, assignedTo, triedAgents, assignmentPool }
 * @param {object} opts
 *   - now: reference time (default new Date())
 *   - rearmSingleAgent: when true (timeout path), a sole eligible agent who is the
 *       current assignee keeps the lead and just gets their timer reset; when false
 *       (explicit reject), that case escalates instead.
 * @returns {{ action: 'reassigned'|'escalated'|'rearmed'|'noop', next?: string }}
 */
async function advancePendingLead(lead, { now = new Date(), rearmSingleAgent = false } = {}) {
  // Leads from a multi-agent sheet carry an assignmentPool — reassignment stays
  // within that subset. Otherwise use the full project rotation.
  const eligible = lead.assignmentPool?.length
    ? await eligibleAgentIdsFromPool(lead.assignmentPool)
    : await eligibleAgentIds(lead.project);
  const next = nextUntriedAgent(eligible, lead.triedAgents, lead.assignedTo);
  const newDeadline = new Date(now.getTime() + ACCEPT_WINDOW_MIN * 60 * 1000);

  if (!next) {
    // Single-agent project on the TIMEOUT path → re-arm, don't lock them out.
    if (
      rearmSingleAgent &&
      eligible.length === 1 &&
      String(eligible[0]) === String(lead.assignedTo)
    ) {
      await Lead.updateOne(
        { _id: lead._id, acceptanceStatus: 'pending' },
        { $set: { acceptDeadline: newDeadline } }
      );
      return { action: 'rearmed' };
    }

    // Nobody (else) can take it → escalate. Keep it on the last agent, alert admins.
    const escalated = await Lead.findOneAndUpdate(
      { _id: lead._id, acceptanceStatus: 'pending' },
      { $set: { acceptanceStatus: 'escalated' } },
      { new: true }
    )
      .populate('project', 'name')
      .lean();
    if (escalated) notifyUnassigned(escalated);
    return { action: escalated ? 'escalated' : 'noop' };
  }

  // Hand it to the next untried agent and restart the timer.
  const updated = await Lead.findOneAndUpdate(
    { _id: lead._id, acceptanceStatus: 'pending' },
    {
      $set: { assignedTo: next, assignedAt: now, acceptDeadline: newDeadline },
      $inc: { reassignmentCount: 1 },
      $addToSet: { triedAgents: next },
    },
    { new: true }
  )
    .populate('project', 'name developer')
    .lean();

  if (updated) notifyAssignment(next, updated);
  return { action: updated ? 'reassigned' : 'noop', next: String(next) };
}

module.exports = advancePendingLead;
