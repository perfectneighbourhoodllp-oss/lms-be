const User = require('../models/User');

/**
 * Round-robin agent assignment within a document's own agent set
 * (doc.assignedAgents), independent of any project rotation. Used by both
 * Meta form/page mappings and (conceptually) sheet configs.
 *
 * - Filters paused/deactivated/unavailable agents out of the rotation first
 * - Atomically increments the doc's own nextAgentIndex (race-condition safe)
 * - A set of one behaves as a fixed pin (always that agent)
 * - Returns null when the set has no currently-eligible agent (caller then
 *   falls back to the project-wide rotation)
 *
 * @param {mongoose.Model} Model - the model owning the doc (must have nextAgentIndex)
 * @param {object} doc - lean/hydrated doc with { _id, assignedAgents }
 * @returns {Promise<mongoose.Types.ObjectId|null>}
 */
module.exports = async function rotateAgentInPool(Model, doc) {
  const poolIds = (doc?.assignedAgents || []).map(String);
  if (!poolIds.length) return null;

  // Keep only active + available agents, preserving the declared order
  // (that order defines the rotation).
  const agents = await User.find({
    _id: { $in: poolIds },
    isActive: { $ne: false },
    isAvailable: { $ne: false },
  })
    .select('_id')
    .lean();
  const eligibleSet = new Set(agents.map((a) => String(a._id)));
  const eligible = poolIds.filter((id) => eligibleSet.has(id));
  if (!eligible.length) return null;

  // Atomically advance this doc's own rotation cursor.
  const updated = await Model.findOneAndUpdate(
    { _id: doc._id },
    { $inc: { nextAgentIndex: 1 } },
    { new: false } // pre-increment value
  );
  if (!updated) return null;

  const idx = (updated.nextAgentIndex || 0) % eligible.length;
  return eligible[idx];
};
