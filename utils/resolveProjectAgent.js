const Project = require('../models/Project');

/**
 * Round-robin agent assignment for a project, filtered to only
 * agents that are isActive AND isAvailable.
 *
 * - Increments project.nextAgentIndex atomically (race-condition safe)
 * - Skips deactivated or paused agents
 * - Returns null if the project has no eligible agents
 */
module.exports = async function resolveProjectAgent(projectId) {
  if (!projectId) return null;

  // Read the project + populated agents to find which are eligible
  const projectDoc = await Project.findById(projectId)
    .populate('assignedAgents', 'isActive isAvailable')
    .lean();
  if (!projectDoc || !projectDoc.assignedAgents?.length) return null;

  const eligibleIds = projectDoc.assignedAgents
    .filter((a) => a.isActive !== false && a.isAvailable !== false)
    .map((a) => a._id);

  if (!eligibleIds.length) return null;

  // Atomically increment the rotation cursor
  const updated = await Project.findOneAndUpdate(
    { _id: projectId },
    { $inc: { nextAgentIndex: 1 } },
    { new: false } // pre-increment value
  );
  if (!updated) return null;

  const idx = updated.nextAgentIndex % eligibleIds.length;
  return eligibleIds[idx];
};
