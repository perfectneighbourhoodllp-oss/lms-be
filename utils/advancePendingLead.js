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
async function advancePendingLead(lead, { now = new Date() } = {}) {
  // Leads from a multi-agent sheet carry an assignmentPool — reassignment stays
  // within that subset. Otherwise use the full project rotation.
  const eligible = lead.assignmentPool?.length
    ? await eligibleAgentIdsFromPool(lead.assignmentPool)
    : await eligibleAgentIds(lead.project);
  const next = nextUntriedAgent(eligible, lead.triedAgents, lead.assignedTo);
  const newDeadline = new Date(now.getTime() + ACCEPT_WINDOW_MIN * 60 * 1000);
  const openFilter = { _id: lead._id, acceptanceStatus: 'pending' };

  if (!next) {
    // Only one eligible agent and it's already the assignee → just re-arm their
    // timer; there's no one else to revolve to.
    if (eligible.length === 1 && String(eligible[0]) === String(lead.assignedTo)) {
      await Lead.updateOne(openFilter, { $set: { acceptanceStatus: 'pending', acceptDeadline: newDeadline } });
      return { action: 'rearmed' };
    }
    if (eligible.length === 0) return { action: 'noop' }; // no agents to route to at all

    // Everyone has been tried without acceptance → DON'T stop. Start a fresh
    // rotation and keep revolving until someone Accepts or an admin manually
    // assigns. Reset triedAgents, hand to the next agent (not the current one),
    // re-arm the timer, and ping admins once per full round for visibility.
    const nextAgent = eligible.find((a) => String(a) !== String(lead.assignedTo)) || eligible[0];
    const recycled = await Lead.findOneAndUpdate(
      openFilter,
      {
        $set: {
          acceptanceStatus: 'pending',
          assignedTo: nextAgent,
          assignedAt: now,
          acceptDeadline: newDeadline,
          triedAgents: [nextAgent],
        },
        $inc: { reassignmentCount: 1, cyclesCompleted: 1 },
      },
      { new: true }
    )
      .populate('project', 'name developer')
      .lean();
    if (recycled) {
      notifyAssignment(nextAgent, recycled);
      notifyUnassigned(recycled); // visibility: a full round passed unaccepted, still revolving
    }
    return { action: 'recycled', next: String(nextAgent) };
  }

  // Hand it to the next untried agent and restart the timer.
  const updated = await Lead.findOneAndUpdate(
    openFilter,
    {
      $set: { acceptanceStatus: 'pending', assignedTo: next, assignedAt: now, acceptDeadline: newDeadline },
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
