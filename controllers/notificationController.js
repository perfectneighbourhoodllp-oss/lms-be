const Notification = require('../models/Notification');

// Recent notifications for the current user (latest 30)
exports.list = async (req, res, next) => {
  try {
    const { unread } = req.query;
    const filter = { user: req.user.id };
    if (unread === 'true') filter.isRead = false;

    const notifications = await Notification.find(filter)
      .populate('relatedLead', 'name phone')
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    res.json(notifications);
  } catch (err) {
    next(err);
  }
};

// Just the unread count (for the bell badge)
exports.unreadCount = async (req, res, next) => {
  try {
    const count = await Notification.countDocuments({
      user: req.user.id,
      isRead: false,
    });
    res.json({ count });
  } catch (err) {
    next(err);
  }
};

exports.markRead = async (req, res, next) => {
  try {
    const result = await Notification.updateOne(
      { _id: req.params.id, user: req.user.id },
      { $set: { isRead: true, readAt: new Date() } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ message: 'Notification not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

exports.markAllRead = async (req, res, next) => {
  try {
    const result = await Notification.updateMany(
      { user: req.user.id, isRead: false },
      { $set: { isRead: true, readAt: new Date() } }
    );
    res.json({ updated: result.modifiedCount });
  } catch (err) {
    next(err);
  }
};
