const User = require('../models/User');
const Lead = require('../models/Lead');
const logActivity = require('../utils/logActivity');

/** GET /api/users — all users (active + inactive) for team page */
exports.getUsers = async (req, res, next) => {
  try {
    const users = await User.find()
      .select('name email role phone isActive createdAt')
      .sort({ role: 1, name: 1 })
      .lean();

    // Attach lead count per user
    const counts = await Lead.aggregate([
      { $group: { _id: '$assignedTo', total: { $sum: 1 } } },
    ]);
    const countMap = Object.fromEntries(counts.map((c) => [String(c._id), c.total]));

    const result = users.map((u) => ({
      ...u,
      leadCount: countMap[String(u._id)] || 0,
    }));

    res.json(result);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/users/agent-performance
 * Returns per-agent stats: total leads, by status, overdue count, closed-this-month
 * Admin/manager only.
 */
exports.getAgentPerformance = async (req, res, next) => {
  try {
    const now = new Date();
    const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const users = await User.find({ isActive: true })
      .select('name email role')
      .sort({ role: 1, name: 1 })
      .lean();

    // Aggregate lead stats per agent
    const [byStatus, overdue, closedMonth] = await Promise.all([
      Lead.aggregate([
        { $group: { _id: { agent: '$assignedTo', status: '$status' }, count: { $sum: 1 } } },
      ]),
      Lead.aggregate([
        {
          $match: {
            followUpDate: { $lt: startOfToday },
            status: { $ne: 'Closed' },
          },
        },
        { $group: { _id: '$assignedTo', count: { $sum: 1 } } },
      ]),
      Lead.aggregate([
        { $match: { status: 'Closed', updatedAt: { $gte: startOfMonth } } },
        { $group: { _id: '$assignedTo', count: { $sum: 1 } } },
      ]),
    ]);

    // Build per-agent status map
    const statusMap = {};
    for (const row of byStatus) {
      const agentId = String(row._id.agent || 'unassigned');
      if (!statusMap[agentId]) statusMap[agentId] = { total: 0 };
      statusMap[agentId][row._id.status] = row.count;
      statusMap[agentId].total += row.count;
    }

    const overdueMap = Object.fromEntries(overdue.map((o) => [String(o._id), o.count]));
    const closedMap = Object.fromEntries(closedMonth.map((o) => [String(o._id), o.count]));

    const result = users.map((u) => {
      const key = String(u._id);
      const s = statusMap[key] || {};
      return {
        _id: u._id,
        name: u.name,
        email: u.email,
        role: u.role,
        total: s.total || 0,
        new: s.New || 0,
        called: s.Called || 0,
        interested: s.Interested || 0,
        siteVisit: s['Site Visit'] || 0,
        closed: s.Closed || 0,
        overdue: overdueMap[key] || 0,
        closedThisMonth: closedMap[key] || 0,
      };
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
};

/** POST /api/users — admin/manager creates a new agent */
exports.createUser = async (req, res, next) => {
  try {
    const { name, email, password, role, phone } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'name, email and password are required' });
    }

    // Manager can only create sales agents
    if (req.user.role === 'manager' && role !== 'sales') {
      return res.status(403).json({ message: 'Managers can only create sales agents' });
    }

    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ message: 'Email already registered' });

    const user = await User.create({ name, email, password, role: role || 'sales', phone });

    logActivity({
      req,
      action: 'user.create',
      resource: 'user',
      resourceId: user._id,
      details: `Created ${user.role} user: ${user.name} (${user.email})`,
    });

    res.status(201).json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      phone: user.phone,
      isActive: user.isActive,
      createdAt: user.createdAt,
      leadCount: 0,
    });
  } catch (err) {
    next(err);
  }
};

/** PUT /api/users/:id — admin updates name, phone, role, isActive */
exports.updateUser = async (req, res, next) => {
  try {
    const { name, phone, role, isActive } = req.body;

    if (req.user.role === 'manager') {
      // Managers can only edit sales agents — not other managers or admins
      const target = await User.findById(req.params.id);
      if (!target) return res.status(404).json({ message: 'User not found' });
      if (target.role !== 'sales') {
        return res.status(403).json({ message: 'Managers can only edit sales agents' });
      }
      // Managers cannot change roles — only admins can do that
      const user = await User.findByIdAndUpdate(
        req.params.id,
        { $set: { name, phone, isActive } },
        { new: true, runValidators: true }
      ).select('-password');
      if (!user) return res.status(404).json({ message: 'User not found' });
      logActivity({
        req,
        action: 'user.update',
        resource: 'user',
        resourceId: user._id,
        details: `Updated user ${user.name} (${user.email})`,
      });
      return res.json(user);
    }

    // Admin path — full update including role
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { name, phone, role, isActive } },
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) return res.status(404).json({ message: 'User not found' });

    logActivity({
      req,
      action: 'user.update',
      resource: 'user',
      resourceId: user._id,
      details: `Updated user ${user.name} (${user.email})${role ? ` → role: ${role}` : ''}${isActive === false ? ' — deactivated' : isActive === true ? ' — activated' : ''}`,
    });

    res.json(user);
  } catch (err) {
    next(err);
  }
};

/** PUT /api/users/:id/reset-password — admin resets a user's password */
exports.resetPassword = async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.password = password; // pre-save hook will hash it
    await user.save();

    logActivity({
      req,
      action: 'user.resetPassword',
      resource: 'user',
      resourceId: user._id,
      details: `Password reset for ${user.name} (${user.email})`,
    });

    res.json({ message: 'Password reset successfully' });
  } catch (err) {
    next(err);
  }
};
