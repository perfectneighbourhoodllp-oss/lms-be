const ActivityLog = require('../models/ActivityLog');

/**
 * Fire-and-forget activity logger.
 * Never throws — logging failures should never block the actual operation.
 *
 * @param {Object} opts
 * @param {Object} opts.req - Express request (for user info + IP)
 * @param {string} opts.action - e.g. "login", "lead.create", "lead.delete"
 * @param {string} [opts.resource] - e.g. "lead", "user", "project"
 * @param {string} [opts.resourceId] - the ID of the affected resource
 * @param {string} [opts.details] - human-readable description
 * @param {string} [opts.status] - "success" (default) or "failed"
 * @param {Object} [opts.userOverride] - for cases like failed login where req.user isn't set yet
 */
const logActivity = async (opts) => {
  try {
    const { req, action, resource, resourceId, details, status = 'success', userOverride } = opts;

    const user = userOverride || req?.user;

    await ActivityLog.create({
      user: user?.id || user?._id,
      userName: user?.name,
      userEmail: user?.email,
      action,
      resource,
      resourceId: resourceId ? String(resourceId) : undefined,
      details,
      ip: req?.ip || req?.headers?.['x-forwarded-for'] || req?.connection?.remoteAddress,
      status,
    });
  } catch (err) {
    console.error('[LOG] Failed to record activity:', err.message);
  }
};

module.exports = logActivity;