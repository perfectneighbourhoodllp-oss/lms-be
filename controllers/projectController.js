const Project = require('../models/Project');
const logActivity = require('../utils/logActivity');

exports.getProjects = async (req, res, next) => {
  try {
    // Scope for managers — if they have project assignments, only return those.
    // Admins and unscoped managers see all.
    const filter = {};
    if (req.user?.role === 'manager') {
      const { getManagedProjectIds } = require('../utils/managerScope');
      const ids = await getManagedProjectIds(req.user.id);
      if (ids) filter._id = { $in: ids };
    }

    const projects = await Project.find(filter)
      .populate('assignedAgents', 'name email role')
      .populate('assignedManagers', 'name email role')
      .sort({ name: 1 })
      .lean();
    res.json(projects);
  } catch (err) {
    next(err);
  }
};

exports.getProject = async (req, res, next) => {
  try {
    const project = await Project.findById(req.params.id)
      .populate('assignedAgents', 'name email role')
      .populate('assignedManagers', 'name email role');
    if (!project) return res.status(404).json({ message: 'Project not found' });

    // Manager scope: if they have any project assignments, they can only see
    // projects in that list. Without assignments → can see all (default).
    if (req.user?.role === 'manager') {
      const { getManagedProjectIds } = require('../utils/managerScope');
      const ids = await getManagedProjectIds(req.user.id);
      if (ids && !ids.map(String).includes(String(project._id))) {
        return res.status(404).json({ message: 'Project not found' });
      }
    }

    res.json(project);
  } catch (err) {
    next(err);
  }
};

exports.createProject = async (req, res, next) => {
  try {
    const { name, developer, location, type, notes } = req.body;
    if (!name) return res.status(400).json({ message: 'Project name is required' });

    const project = await Project.create({ name, developer, location, type, notes });
    logActivity({ req, action: 'project.create', resource: 'project', resourceId: project._id, details: `Created project "${project.name}"` });
    res.status(201).json(project);
  } catch (err) {
    next(err);
  }
};

exports.updateProject = async (req, res, next) => {
  try {
    const { name, developer, location, type, notes, isActive } = req.body;
    const project = await Project.findByIdAndUpdate(
      req.params.id,
      { $set: { name, developer, location, type, notes, isActive } },
      { new: true, runValidators: true }
    ).populate('assignedAgents', 'name email role');

    if (!project) return res.status(404).json({ message: 'Project not found' });
    logActivity({ req, action: 'project.update', resource: 'project', resourceId: project._id, details: `Updated project "${project.name}"` });
    res.json(project);
  } catch (err) {
    next(err);
  }
};

exports.deleteProject = async (req, res, next) => {
  try {
    const project = await Project.findByIdAndDelete(req.params.id);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    logActivity({ req, action: 'project.delete', resource: 'project', resourceId: project._id, details: `Deleted project "${project.name}"` });
    res.json({ message: 'Project deleted' });
  } catch (err) {
    next(err);
  }
};

/**
 * Assign agents to a project (replaces the full list).
 * Body: {
 *   agentIds: ['id1', 'id2', ...],
 *   agentWeights?: { 'id1': 2, 'id2': 1, ... }  // optional, defaults to weight 1 each
 * }
 * Weights are clamped to [1, 10]. Stale entries (for un-selected agents) are pruned.
 */
exports.assignAgents = async (req, res, next) => {
  try {
    const { agentIds = [], agentWeights = {} } = req.body;

    // Sanitise weights: only keep entries for currently selected agents,
    // clamp to [1, 10], coerce to integer. Omit default (1) values to keep
    // the stored object sparse.
    const cleanWeights = {};
    let hasCustomWeights = false;
    for (const id of agentIds) {
      const raw = agentWeights[id];
      if (raw === undefined || raw === null || raw === '') continue;
      const w = Math.max(1, Math.min(10, Math.floor(Number(raw)) || 1));
      if (w !== 1) {
        cleanWeights[id] = w;
        hasCustomWeights = true;
      }
    }

    const project = await Project.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          assignedAgents: agentIds,
          agentWeights: cleanWeights,
          nextAgentIndex: 0, // reset rotation when roster or weights change
        },
      },
      { new: true }
    )
      .populate('assignedAgents', 'name email role')
      .populate('assignedManagers', 'name email role');

    if (!project) return res.status(404).json({ message: 'Project not found' });

    const weightSummary = hasCustomWeights
      ? ` with proportions (${Object.entries(cleanWeights).map(([, w]) => w).join(':')})`
      : '';
    logActivity({
      req,
      action: 'project.assignAgents',
      resource: 'project',
      resourceId: project._id,
      details: `Updated agent roster for "${project.name}" (${agentIds.length} agents)${weightSummary}`,
    });
    res.json(project);
  } catch (err) {
    next(err);
  }
};

/**
 * Assign managers to a project (replaces the full list).
 * Body: { managerIds: ['id1', 'id2', ...] }
 *
 * Managers in this list will be scoped to oversee this project (and any others
 * they're assigned to). Managers with no assignments anywhere see all projects.
 *
 * Admin-only (separate from assignAgents which managers can also do).
 */
exports.assignManagers = async (req, res, next) => {
  try {
    const { managerIds = [] } = req.body;

    // Validate that all IDs actually belong to manager-role users
    if (managerIds.length) {
      const User = require('../models/User');
      const users = await User.find({ _id: { $in: managerIds } })
        .select('role')
        .lean();
      const nonManagers = users.filter((u) => u.role !== 'manager');
      if (nonManagers.length || users.length !== managerIds.length) {
        return res.status(400).json({
          message: 'All managerIds must reference users with role=manager',
        });
      }
    }

    const project = await Project.findByIdAndUpdate(
      req.params.id,
      { $set: { assignedManagers: managerIds } },
      { new: true }
    )
      .populate('assignedAgents', 'name email role')
      .populate('assignedManagers', 'name email role');

    if (!project) return res.status(404).json({ message: 'Project not found' });

    logActivity({
      req,
      action: 'project.assignManagers',
      resource: 'project',
      resourceId: project._id,
      details: `Updated manager list for "${project.name}" (${managerIds.length} manager${managerIds.length === 1 ? '' : 's'})`,
    });
    res.json(project);
  } catch (err) {
    next(err);
  }
};
