const Notification = require('../models/Notification');

/**
 * Fire-and-forget notification creator.
 * Never throws — failures are logged but don't break parent operations.
 *
 * @param {Object} opts
 * @param {string|ObjectId} opts.userId - Recipient user ID
 * @param {string} opts.type - One of: 'lead.assigned', 'lead.remark', 'lead.followUp'
 * @param {string} opts.title - Short title shown in bell dropdown
 * @param {string} [opts.message] - Optional longer description
 * @param {string|ObjectId} [opts.relatedLead] - Lead ID for click-through
 * @param {string|ObjectId} [opts.actorId] - Actor's user ID. If equal to userId, no notification is created (no self-notify).
 */
const createNotification = async ({ userId, type, title, message, relatedLead, actorId }) => {
  try {
    if (!userId) return;
    if (actorId && String(actorId) === String(userId)) return; // skip self-notify

    await Notification.create({
      user: userId,
      type,
      title,
      message,
      relatedLead,
    });
  } catch (err) {
    console.error('[NOTIFY] Failed to create notification:', err.message);
  }
};

module.exports = createNotification;
