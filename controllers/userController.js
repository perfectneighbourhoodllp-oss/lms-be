const User = require('../models/User');
const Lead = require('../models/Lead');
const Project = require('../models/Project');
const ActivityLog = require('../models/ActivityLog');
const logActivity = require('../utils/logActivity');
const { getManagedProjectIds } = require('../utils/managerScope');

/** GET /api/users — all users (active + inactive) for team page */
exports.getUsers = async (req, res, next) => {
  try {
    const users = await User.find()
      .select('name email role phone isActive isAvailable createdAt')
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
            status: { $nin: ['Closed', 'Not Interested', 'Dead'] },
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

/** PUT /api/users/:id — admin updates name, phone, role, isActive, isAvailable */
exports.updateUser = async (req, res, next) => {
  try {
    const { name, phone, role, isActive, isAvailable } = req.body;

    // Cannot pause an admin (preserves at least one active admin for fallback ops)
    if (isAvailable === false) {
      const target = await User.findById(req.params.id).select('role').lean();
      if (target?.role === 'admin') {
        return res.status(403).json({ message: 'Admins cannot be paused' });
      }
    }

    if (req.user.role === 'manager') {
      // Managers can only edit sales agents — not other managers or admins
      const target = await User.findById(req.params.id);
      if (!target) return res.status(404).json({ message: 'User not found' });
      if (target.role !== 'sales') {
        return res.status(403).json({ message: 'Managers can only edit sales agents' });
      }
      // Managers can't change roles or activate/deactivate (admin-only)
      const user = await User.findByIdAndUpdate(
        req.params.id,
        { $set: { name, phone, isAvailable } },
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
      { $set: { name, phone, role, isActive, isAvailable } },
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

/**
 * PUT /api/users/me/availability — current user toggles their own availability.
 * When isAvailable=false, they're skipped in project round-robin but can still
 * log in and work existing leads.
 */
exports.setMyAvailability = async (req, res, next) => {
  try {
    const { isAvailable } = req.body;
    if (typeof isAvailable !== 'boolean') {
      return res.status(400).json({ message: 'isAvailable (boolean) is required' });
    }

    // Admin cannot pause themselves — system needs at least one active admin.
    // Sales agents and managers can self-toggle freely.
    if (req.user.role === 'admin') {
      return res.status(403).json({ message: 'Admins cannot pause themselves' });
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: { isAvailable } },
      { new: true }
    ).select('-password');

    if (!user) return res.status(404).json({ message: 'User not found' });

    logActivity({
      req,
      action: 'user.availability',
      resource: 'user',
      resourceId: user._id,
      details: `${user.name} set availability to ${isAvailable ? 'available' : 'paused'}`,
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

/**
 * GET /api/users/:id/profile-stats
 *
 * Rich per-agent stats for the agent profile page. Single endpoint that
 * aggregates everything a manager/admin needs to evaluate an agent at a glance.
 *
 * Permissions:
 *   • Admin → any agent
 *   • Manager (unscoped, no project assignments) → any agent
 *   • Manager (scoped) → only agents in their managed projects' rosters
 *   • Sales → self only
 */
exports.getAgentProfileStats = async (req, res, next) => {
  try {
    const targetId = req.params.id;

    // Permission gate
    const isSelf = String(req.user.id) === String(targetId);
    if (!isSelf && req.user.role === 'sales') {
      return res.status(403).json({ message: 'You can only view your own profile' });
    }
    if (!isSelf && req.user.role === 'manager') {
      const managedProjectIds = await getManagedProjectIds(req.user.id);
      if (managedProjectIds) {
        // Manager is scoped — agent must be assigned to one of these projects
        const agentInScope = await Project.findOne({
          _id: { $in: managedProjectIds },
          assignedAgents: targetId,
        }).select('_id').lean();
        if (!agentInScope) {
          return res.status(403).json({ message: 'This agent is not in your managed projects' });
        }
      }
      // If managedProjectIds is null → manager is unscoped → can view anyone
    }

    const user = await User.findById(targetId)
      .select('name email role phone isActive isAvailable createdAt')
      .lean();
    if (!user) return res.status(404).json({ message: 'Agent not found' });

    // Time markers (IST-safe — JS Date is UTC under the hood, day-boundary handled below)
    const now = new Date();
    const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date(now); endOfToday.setHours(23, 59, 59, 999);
    const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - 7); startOfWeek.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfQuarter = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const twentyMinAgo = new Date(now.getTime() - 20 * 60 * 1000);
    const TERMINAL = ['Closed', 'Not Interested', 'Dead'];

    const agentFilter = { assignedTo: targetId };

    // Single Promise.all for all aggregations — fast
    const [
      pipelineByStatus,
      followUpsToday,
      newLeadsToday,
      overdueLeads,
      unattendedCount,
      noFollowUpCount,
      staleInterested,
      staleSiteVisit,
      closedThisMonth,
      closedThisQuarter,
      closedAllTime,
      remarksToday,
      remarksThisWeek,
      timeToFirstContact,
      leadToCloseTime,
      assignedProjects,
      lastActivity,
      recentActivity,
      overdueAgeBuckets,
    ] = await Promise.all([
      // Pipeline counts by status
      Lead.aggregate([
        { $match: agentFilter },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),

      // Today's follow-ups (full list)
      Lead.find({
        ...agentFilter,
        followUpDate: { $gte: startOfToday, $lte: endOfToday },
        status: { $nin: TERMINAL },
      })
        .populate('project', 'name')
        .select('name phone status followUpDate project remarks')
        .sort({ followUpDate: 1 })
        .lean(),

      // New leads assigned today (no remarks yet)
      Lead.find({
        ...agentFilter,
        createdAt: { $gte: startOfToday, $lte: endOfToday },
        $or: [{ remarks: { $size: 0 } }, { remarks: { $exists: false } }],
      })
        .populate('project', 'name')
        .select('name phone status createdAt project')
        .sort({ createdAt: -1 })
        .lean(),

      // Overdue follow-ups (full list)
      Lead.find({
        ...agentFilter,
        followUpDate: { $lt: startOfToday },
        status: { $nin: TERMINAL },
      })
        .populate('project', 'name')
        .select('name phone status followUpDate project remarks')
        .sort({ followUpDate: 1 })
        .limit(50)
        .lean(),

      // Unattended count — created > 20 min ago, no remarks, active status
      Lead.countDocuments({
        ...agentFilter,
        createdAt: { $lt: twentyMinAgo },
        status: { $nin: TERMINAL },
        $or: [{ remarks: { $size: 0 } }, { remarks: { $exists: false } }],
      }),

      // Active leads with no follow-up scheduled
      Lead.countDocuments({
        ...agentFilter,
        status: { $nin: TERMINAL },
        $or: [{ followUpDate: null }, { followUpDate: { $exists: false } }],
      }),

      // Stale Interested — no activity in 7+ days
      Lead.countDocuments({
        ...agentFilter,
        status: 'Interested',
        updatedAt: { $lt: sevenDaysAgo },
      }),

      // Stale Site Visit
      Lead.countDocuments({
        ...agentFilter,
        status: 'Site Visit',
        updatedAt: { $lt: sevenDaysAgo },
      }),

      // Closed this month
      Lead.countDocuments({
        ...agentFilter,
        status: 'Closed',
        updatedAt: { $gte: startOfMonth },
      }),

      // Closed this quarter
      Lead.countDocuments({
        ...agentFilter,
        status: 'Closed',
        updatedAt: { $gte: startOfQuarter },
      }),

      // Closed all-time
      Lead.countDocuments({
        ...agentFilter,
        status: 'Closed',
      }),

      // Remarks added today (count from subdocs)
      Lead.aggregate([
        { $match: agentFilter },
        { $unwind: '$remarks' },
        { $match: { 'remarks.addedBy': user._id, 'remarks.createdAt': { $gte: startOfToday } } },
        { $count: 'count' },
      ]),

      // Remarks this week
      Lead.aggregate([
        { $match: agentFilter },
        { $unwind: '$remarks' },
        { $match: { 'remarks.addedBy': user._id, 'remarks.createdAt': { $gte: startOfWeek } } },
        { $count: 'count' },
      ]),

      // Avg time-to-first-contact (createdAt → first remark)
      // For leads where the assigned agent themselves added the first remark
      Lead.aggregate([
        { $match: { ...agentFilter, remarks: { $exists: true, $ne: [] } } },
        {
          $project: {
            firstRemarkAt: { $arrayElemAt: ['$remarks.createdAt', 0] },
            createdAt: 1,
          },
        },
        {
          $project: {
            diffMs: { $subtract: ['$firstRemarkAt', '$createdAt'] },
          },
        },
        { $match: { diffMs: { $gte: 0 } } },
        { $group: { _id: null, avgMs: { $avg: '$diffMs' }, count: { $sum: 1 } } },
      ]),

      // Avg lead-to-close time (createdAt → updatedAt of Closed leads)
      Lead.aggregate([
        { $match: { ...agentFilter, status: 'Closed' } },
        {
          $project: {
            diffMs: { $subtract: ['$updatedAt', '$createdAt'] },
          },
        },
        { $group: { _id: null, avgMs: { $avg: '$diffMs' }, count: { $sum: 1 } } },
      ]),

      // Projects this agent is assigned to
      Project.find({ assignedAgents: targetId })
        .select('name developer agentWeights')
        .sort({ name: 1 })
        .lean(),

      // Last activity from ActivityLog
      ActivityLog.findOne({ user: targetId })
        .sort({ createdAt: -1 })
        .select('action createdAt')
        .lean(),

      // Recent activity feed (last 20)
      ActivityLog.find({ user: targetId })
        .sort({ createdAt: -1 })
        .limit(20)
        .select('action resource resourceId details createdAt')
        .lean(),

      // Overdue age buckets — leads overdue 1 day / 3 days / 7+ days
      Lead.aggregate([
        {
          $match: {
            ...agentFilter,
            followUpDate: { $lt: startOfToday },
            status: { $nin: TERMINAL },
          },
        },
        {
          $project: {
            ageDays: {
              $divide: [
                { $subtract: [startOfToday, '$followUpDate'] },
                1000 * 60 * 60 * 24,
              ],
            },
          },
        },
        {
          $bucket: {
            groupBy: '$ageDays',
            boundaries: [0, 1, 3, 7, 1000],
            default: 'other',
            output: { count: { $sum: 1 } },
          },
        },
      ]),
    ]);

    // Build pipeline object
    const pipeline = {
      New: 0, Called: 0, Interested: 0, Webinar: 0,
      'Site Visit': 0, Closed: 0, 'Not Interested': 0, Dead: 0,
    };
    pipelineByStatus.forEach((r) => { pipeline[r._id] = r.count; });
    const grandTotal = Object.values(pipeline).reduce((s, n) => s + n, 0);
    const activeTotal = grandTotal - pipeline.Closed - pipeline['Not Interested'] - pipeline.Dead;
    const conversionRate = grandTotal > 0 ? pipeline.Closed / grandTotal : 0;

    // Build overdue age buckets — map boundaries [0,1,3,7] to labels
    const ageMap = { '0d': 0, '1d': 0, '3d': 0, '7d+': 0 };
    overdueAgeBuckets.forEach((b) => {
      if (b._id === 0) ageMap['0d'] = b.count;
      else if (b._id === 1) ageMap['1d'] = b.count;
      else if (b._id === 3) ageMap['3d'] = b.count;
      else ageMap['7d+'] = b.count;
    });

    res.json({
      user,

      today: {
        followUpsCount: followUpsToday.length,
        newLeadsCount: newLeadsToday.length,
        overdueCount: overdueLeads.length,
        unattendedCount,
      },
      followUpsList: followUpsToday,
      newLeadsList: newLeadsToday,
      overdueList: overdueLeads,

      pipeline: {
        ...pipeline,
        activeTotal,
        grandTotal,
        conversionRate,
      },

      performance: {
        closedThisMonth,
        closedThisQuarter,
        closedAllTime,
        remarksToday: remarksToday[0]?.count || 0,
        remarksThisWeek: remarksThisWeek[0]?.count || 0,
        avgTimeToFirstContactHours: timeToFirstContact[0]?.avgMs
          ? Math.round((timeToFirstContact[0].avgMs / (1000 * 60 * 60)) * 10) / 10
          : null,
        avgLeadToCloseDays: leadToCloseTime[0]?.avgMs
          ? Math.round((leadToCloseTime[0].avgMs / (1000 * 60 * 60 * 24)) * 10) / 10
          : null,
      },

      quality: {
        noFollowUpScheduled: noFollowUpCount,
        staleInterested,
        staleSiteVisit,
        overdueByAge: ageMap,
      },

      operational: {
        assignedProjects: assignedProjects.map((p) => ({
          _id: p._id,
          name: p.name,
          developer: p.developer,
          weight: p.agentWeights?.[String(targetId)] || 1,
        })),
        lastActivityAt: lastActivity?.createdAt || null,
      },

      recentActivity,
    });
  } catch (err) {
    next(err);
  }
};
