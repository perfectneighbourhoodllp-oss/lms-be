const Project = require('../models/Project');

/**
 * Weighted round-robin agent assignment for a project.
 *
 * Each eligible (isActive AND isAvailable) agent is expanded into the
 * rotation list `weight` times. A weight of 1 (the default) reproduces
 * pure round-robin. Higher weights cluster — e.g. weight 2 means the
 * agent receives two leads back-to-back per cycle.
 *
 * - Filters paused/deactivated agents BEFORE expansion (their slots vanish)
 * - Atomically increments project.nextAgentIndex (race-condition safe)
 * - Returns null if the project has no eligible agents
 */
module.exports = async function resolveProjectAgent(projectId) {
  if (!projectId) return null;

  // Read project + populated agents to determine eligibility
  const projectDoc = await Project.findById(projectId)
    .populate('assignedAgents', 'isActive isAvailable')
    .lean();
  if (!projectDoc || !projectDoc.assignedAgents?.length) return null;

  const weights = projectDoc.agentWeights || {};

  // Build expanded weighted list, filtering paused/deactivated first
  const expanded = [];
  for (const agent of projectDoc.assignedAgents) {
    if (agent.isActive === false || agent.isAvailable === false) continue;
    const raw = weights[String(agent._id)];
    // Clamp to [1, 10]; floor non-integers; default 1 when unset
    const w = Math.max(1, Math.min(10, Math.floor(Number(raw) || 1)));
    for (let i = 0; i < w; i++) expanded.push(agent._id);
  }

  if (!expanded.length) return null;

  // Atomically increment the rotation cursor
  const updated = await Project.findOneAndUpdate(
    { _id: projectId },
    { $inc: { nextAgentIndex: 1 } },
    { new: false } // pre-increment value
  );
  if (!updated) return null;

  const idx = (updated.nextAgentIndex || 0) % expanded.length;
  return expanded[idx];
};
