const ActivityLog = require('../models/ActivityLog');

exports.getLogs = async (req, res, next) => {
  try {
    const { user, action, status, search, page = 1, limit = 50, from, to } = req.query;
    const filter = {};
    if (user) filter.user = user;
    if (action) filter.action = action;
    if (status) filter.status = status;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }
    if (search) {
      filter.$or = [
        { userName: { $regex: search, $options: 'i' } },
        { userEmail: { $regex: search, $options: 'i' } },
        { details: { $regex: search, $options: 'i' } },
      ];
    }

    const perPage = Math.min(Number(limit) || 50, 200);
    const currentPage = Math.max(Number(page) || 1, 1);
    const skip = (currentPage - 1) * perPage;

    const [logs, total] = await Promise.all([
      ActivityLog.find(filter)
        .populate('user', 'name email role')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(perPage)
        .lean(),
      ActivityLog.countDocuments(filter),
    ]);

    res.json({ logs, total, page: currentPage, pages: Math.ceil(total / perPage) });
  } catch (err) {
    next(err);
  }
};

exports.getActions = async (req, res, next) => {
  try {
    const actions = await ActivityLog.distinct('action');
    res.json(actions.sort());
  } catch (err) {
    next(err);
  }
};
