const Project = require('../models/Project');

/**
 * For a manager user, return the list of project IDs they are responsible for.
 *
 * Rule (opt-in scoping):
 *   • Manager with zero project assignments → returns null (interpret as "no scope, see all")
 *   • Manager with 1+ project assignments → returns the array of project _ids
 *
 * For non-manager roles, callers should use the existing role logic (admin: all,
 * sales: own only) — this helper is specifically for the manager scoping decision.
 *
 * @param {string} userId - the manager's User _id
 * @returns {Promise<null | mongoose.Types.ObjectId[]>}
 */
async function getManagedProjectIds(userId) {
  if (!userId) return null;
  const projects = await Project.find({ assignedManagers: userId })
    .select('_id')
    .lean();
  if (!projects.length) return null;
  return projects.map((p) => p._id);
}

/**
 * Build a Mongoose filter clause that scopes queries to a manager's managed
 * projects. Returns an empty object when the manager has no assignments
 * (so the caller's existing filter is unchanged → manager sees everything).
 *
 * Usage:
 *   const scope = await getManagerProjectFilter(req.user);
 *   const filter = { ...buildRoleFilter(req.user), ...scope, status: 'New' };
 */
async function getManagerProjectFilter(user) {
  if (!user || user.role !== 'manager') return {};
  const ids = await getManagedProjectIds(user.id || user._id);
  if (!ids) return {}; // unscoped — current behaviour
  return { project: { $in: ids } };
}

module.exports = {
  getManagedProjectIds,
  getManagerProjectFilter,
};
