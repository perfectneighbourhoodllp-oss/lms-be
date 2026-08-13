const Project = require('../models/Project');
const User = require('../models/User');

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

/**
 * The user IDs of everyone who reports to this manager (their direct team).
 * @returns {Promise<mongoose.Types.ObjectId[]>} (empty array if none)
 */
async function getManagedAgentIds(managerId) {
  if (!managerId) return [];
  const reports = await User.find({ reportsTo: managerId }).select('_id').lean();
  return reports.map((u) => u._id);
}

/**
 * Unified lead-visibility filter for a manager: they see a lead if it's in one
 * of their managed projects OR assigned to their team OR assigned to themselves.
 *
 *   • no projects AND no team  → {}  (unscoped — sees all, current default)
 *   • otherwise (scoped)       → { $or: [ {project…}, {assignedTo ∈ team+self} ] }
 *
 * Including the manager's OWN id means leads handed directly to a manager (e.g. a
 * cold pool assigned to them with no project) stay visible and re-assignable by them.
 */
async function getManagerLeadFilter(user) {
  if (!user || user.role !== 'manager') return {};
  const uid = user.id || user._id;
  const [projectIds, agentIds] = await Promise.all([
    getManagedProjectIds(uid),
    getManagedAgentIds(uid),
  ]);

  const hasProjects = projectIds && projectIds.length;
  const hasTeam = agentIds && agentIds.length;

  // Unscoped manager (no projects and no team) → sees everything (unchanged).
  if (!hasProjects && !hasTeam) return {};

  const clauses = [];
  if (hasProjects) clauses.push({ project: { $in: projectIds } });
  // Team's leads OR the manager's own leads.
  clauses.push({ assignedTo: { $in: [uid, ...(agentIds || [])] } });

  if (clauses.length === 1) return clauses[0];
  return { $or: clauses };
}

module.exports = {
  getManagedProjectIds,
  getManagedAgentIds,
  getManagerProjectFilter,
  getManagerLeadFilter,
};
