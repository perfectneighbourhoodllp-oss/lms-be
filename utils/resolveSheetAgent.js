const SheetConfig = require('../models/SheetConfig');
const User = require('../models/User');

/**
 * Round-robin agent assignment within a single sheet's own agent set
 * (SheetConfig.assignedAgents), independent of the project rotation.
 *
 * - Filters paused/deactivated/unavailable agents out of the rotation first
 * - Atomically increments the sheet's own nextAgentIndex (race-condition safe)
 * - A set of one behaves as a fixed pin (always that agent)
 * - Returns null when the sheet has no currently-eligible agent (caller then
 *   falls back to the project-wide rotation)
 *
 * @param {object} sheetConfig - lean/hydrated SheetConfig with assignedAgents
 * @returns {Promise<mongoose.Types.ObjectId|null>}
 */
module.exports = async function resolveSheetAgent(sheetConfig) {
  const poolIds = (sheetConfig?.assignedAgents || []).map(String);
  if (!poolIds.length) return null;

  // Keep only active + available agents, preserving the sheet's declared order
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

  // Atomically advance this sheet's own rotation cursor.
  const updated = await SheetConfig.findOneAndUpdate(
    { _id: sheetConfig._id },
    { $inc: { nextAgentIndex: 1 } },
    { new: false } // pre-increment value
  );
  if (!updated) return null;

  const idx = (updated.nextAgentIndex || 0) % eligible.length;
  return eligible[idx];
};
