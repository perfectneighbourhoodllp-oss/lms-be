const Project = require('../models/Project');

// Agents must Accept an auto-assigned lead within this many minutes, else it reassigns.
// Override with LEAD_ACCEPT_WINDOW_MIN for testing (e.g. 2). Defaults to 15.
const ACCEPT_WINDOW_MIN = Number(process.env.LEAD_ACCEPT_WINDOW_MIN) || 15;

// Testing escape hatch: set LEAD_REASSIGN_IGNORE_HOURS=true to run the reassign
// logic 24/7 (bypasses the 10:00–18:30 IST business-hours gate). Leave unset in prod.
const IGNORE_BUSINESS_HOURS = process.env.LEAD_REASSIGN_IGNORE_HOURS === 'true';

// Business hours in IST (UTC+5:30), expressed as minutes-since-midnight.
const OPEN_MIN = 10 * 60; // 10:00 AM
const CLOSE_MIN = 18 * 60 + 30; // 6:30 PM

// Current IST minutes-since-midnight, regardless of server timezone.
const istMinutes = (now = new Date()) => {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
};

// True only between 10:00 AM and 6:30 PM IST. The auto-REASSIGNMENT runs only inside
// this window; accepting a lead is allowed anytime (including outside hours).
const isWithinBusinessHours = (now = new Date()) => {
  if (IGNORE_BUSINESS_HOURS) return true; // testing override
  const m = istMinutes(now);
  return m >= OPEN_MIN && m < CLOSE_MIN;
};

// The real-UTC instant of the next 10:00 AM IST business open relative to `now`.
// (Used to set a fair acceptance deadline for leads that arrive outside hours.)
const nextBusinessOpen = (now = new Date()) => {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000); // IST wall-clock as UTC fields
  const m = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  // 10:00 IST on the IST calendar day of `now`, expressed in the IST-shifted epoch.
  let openIstEpoch =
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) + OPEN_MIN * 60 * 1000;
  if (m >= CLOSE_MIN) openIstEpoch += 24 * 60 * 60 * 1000; // after close → tomorrow's open
  // Convert the IST-shifted epoch back to a real UTC instant.
  return new Date(openIstEpoch - 5.5 * 60 * 60 * 1000);
};

// Fields that put a freshly auto-assigned lead into the pending-acceptance flow.
// The 15-min deadline counts from now during business hours, or from the next 10:00 AM
// open if assigned outside hours — so the agent gets a fair window either way and the
// reassignment job (which only runs in hours) never fires the instant hours resume.
const initialAcceptanceFields = (agentId, now = new Date()) => {
  const base = isWithinBusinessHours(now) ? now : nextBusinessOpen(now);
  return {
    acceptanceStatus: 'pending',
    assignedAt: now,
    acceptDeadline: new Date(base.getTime() + ACCEPT_WINDOW_MIN * 60 * 1000),
    reassignmentCount: 0,
    triedAgents: [agentId],
  };
};

// Every auto-assignment now requires acceptance (agents can Accept at any hour);
// only the auto-reassignment is gated to business hours.
const shouldRequireAcceptance = (agentId) => Boolean(agentId);

// Ordered list of eligible (active + available) agent ids for a project,
// in the project's assignedAgents order — that order defines the rotation.
const eligibleAgentIds = async (projectId) => {
  if (!projectId) return [];
  const project = await Project.findById(projectId)
    .populate('assignedAgents', 'isActive isAvailable')
    .lean();
  if (!project?.assignedAgents?.length) return [];
  return project.assignedAgents
    .filter((a) => a.isActive !== false && a.isAvailable !== false)
    .map((a) => String(a._id));
};

// Next eligible agent in rotation order who hasn't been tried yet.
// Returns null when every eligible agent has already had a turn (→ escalate).
const nextUntriedAgent = (eligibleOrdered, triedIds, currentAssignee) => {
  if (!eligibleOrdered.length) return null;
  const tried = new Set((triedIds || []).map(String));
  const n = eligibleOrdered.length;
  const startIdx = currentAssignee ? eligibleOrdered.indexOf(String(currentAssignee)) : -1;
  for (let i = 1; i <= n; i++) {
    const cand = eligibleOrdered[(startIdx + i) % n];
    if (!tried.has(cand)) return cand;
  }
  return null;
};

module.exports = {
  ACCEPT_WINDOW_MIN,
  isWithinBusinessHours,
  nextBusinessOpen,
  initialAcceptanceFields,
  shouldRequireAcceptance,
  eligibleAgentIds,
  nextUntriedAgent,
};
