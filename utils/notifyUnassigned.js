const User = require('../models/User');
const createNotification = require('./createNotification');

/**
 * Notify all active admins and managers when a lead arrives but has no
 * eligible agent (e.g. all agents on the project are paused/inactive).
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

    const recipients = await User.find({
      role: { $in: ['admin', 'manager'] },
      isActive: true,
    })
      .select('_id')
      .lean();

    const projectName = lead.project?.name || 'No project';
    const message = `${lead.name} (${lead.phone}) — ${projectName}`;

    for (const u of recipients) {
      createNotification({
        userId: u._id,
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
