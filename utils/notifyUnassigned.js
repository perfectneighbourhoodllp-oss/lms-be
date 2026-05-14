const User = require('../models/User');
const Project = require('../models/Project');
const createNotification = require('./createNotification');

/**
 * Notify the right people when a lead arrives but has no eligible agent.
 *
 * Routing rules:
 *   • All active admins always notified.
 *   • If the lead has a project AND that project has assignedManagers →
 *       only those specific managers are notified (project-scoped).
 *   • If the lead has a project but NO assigned managers → all unscoped
 *       managers are notified (i.e. managers with zero project assignments
 *       anywhere, who default to seeing all projects).
 *   • If the lead has no project at all → all unscoped managers + admins.
 *
 * Fire-and-forget — failures are logged but never thrown.
 *
 * @param {Object} lead - The created Lead document (or lean object). Must have
 *                       at least name, phone, _id, and ideally a populated
 *                       project field.
 */
module.exports = async function notifyUnassigned(lead) {
  try {
    if (!lead) return;

    // Always notify all active admins
    const recipientIds = new Set();
    const admins = await User.find({ role: 'admin', isActive: true })
      .select('_id')
      .lean();
    admins.forEach((a) => recipientIds.add(String(a._id)));

    // Determine which managers to notify, based on the lead's project
    const projectId = lead.project?._id || lead.project;
    let projectManagerIds = [];
    if (projectId) {
      const project = await Project.findById(projectId)
        .select('assignedManagers')
        .lean();
      projectManagerIds = (project?.assignedManagers || []).map(String);
    }

    if (projectManagerIds.length) {
      // Project has designated managers — notify only them (active only)
      const scopedManagers = await User.find({
        _id: { $in: projectManagerIds },
        role: 'manager',
        isActive: true,
      })
        .select('_id')
        .lean();
      scopedManagers.forEach((m) => recipientIds.add(String(m._id)));
    } else {
      // No designated managers (or no project) — notify managers who are
      // "unscoped" (i.e. NOT in any project's assignedManagers list). These
      // are the managers who default to seeing everything.
      const projectsWithManagers = await Project.find({
        assignedManagers: { $exists: true, $ne: [] },
      })
        .select('assignedManagers')
        .lean();
      const scopedManagerIds = new Set();
      projectsWithManagers.forEach((p) =>
        (p.assignedManagers || []).forEach((id) => scopedManagerIds.add(String(id)))
      );

      const allManagers = await User.find({ role: 'manager', isActive: true })
        .select('_id')
        .lean();
      const unscopedManagers = allManagers.filter(
        (m) => !scopedManagerIds.has(String(m._id))
      );
      unscopedManagers.forEach((m) => recipientIds.add(String(m._id)));
    }

    const projectName = lead.project?.name || 'No project';
    const message = `${lead.name} (${lead.phone}) — ${projectName}`;

    for (const userId of recipientIds) {
      createNotification({
        userId,
        type: 'lead.unassigned',
        title: 'Lead needs assignment',
        message,
        relatedLead: lead._id,
      });
    }
  } catch (err) {
    console.error('[NOTIFY-UNASSIGNED] Failed:', err.message);
  }
};
