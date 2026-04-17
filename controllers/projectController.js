const Project = require('../models/Project');
const logActivity = require('../utils/logActivity');

exports.getProjects = async (req, res, next) => {
  try {
    const projects = await Project.find()
      .populate('assignedAgents', 'name email role')
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
      .populate('assignedAgents', 'name email role');
    if (!project) return res.status(404).json({ message: 'Project not found' });
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
 * Body: { agentIds: ['id1', 'id2', ...] }
 */
exports.assignAgents = async (req, res, next) => {
  try {
    const { agentIds = [] } = req.body;

    const project = await Project.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          assignedAgents: agentIds,
          nextAgentIndex: 0, // reset round-robin when roster changes
        },
      },
      { new: true }
    ).populate('assignedAgents', 'name email role');

    if (!project) return res.status(404).json({ message: 'Project not found' });
    logActivity({ req, action: 'project.assignAgents', resource: 'project', resourceId: project._id, details: `Updated agent roster for "${project.name}" (${agentIds.length} agents)` });
    res.json(project);
  } catch (err) {
    next(err);
  }
};
