const { parse } = require('csv-parse/sync');
const Lead = require('../models/Lead');
const Project = require('../models/Project');
const notifyAssignment = require('../utils/notifyAssignment');
const logActivity = require('../utils/logActivity');
const cleanPhone = require('../utils/cleanPhone');

/* ─── Helpers ─────────────────────────────────────────────── */

/** Build Mongoose filter based on caller's role */
const buildRoleFilter = (user) => {
  if (user.role === 'sales') return { assignedTo: user.id };
  return {}; // admin and manager see all
};

const todayRange = () => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

/**
 * Given a project ID, find the next agent to assign using round-robin.
 * Increments nextAgentIndex on the project atomically.
 * Returns the agent ObjectId, or null if no agents are assigned.
 */
const resolveProjectAgent = async (projectId) => {
  // Use findOneAndUpdate for atomic increment to avoid race conditions
  const project = await Project.findOneAndUpdate(
    { _id: projectId, assignedAgents: { $exists: true, $not: { $size: 0 } } },
    { $inc: { nextAgentIndex: 1 } },
    { new: false } // get the document BEFORE increment so we can use current index
  );

  if (!project || !project.assignedAgents.length) return null;

  // Use modulo so index wraps around the agent list
  const idx = project.nextAgentIndex % project.assignedAgents.length;
  return project.assignedAgents[idx];
};

/* ─── Controllers ─────────────────────────────────────────── */

exports.getLeads = async (req, res, next) => {
  try {
    const { status, source, search, assignedTo, project, page, limit,
            createdFrom, createdTo, followUpFrom, followUpTo } = req.query;
    const filter = buildRoleFilter(req.user);

    if (status) filter.status = status;
    if (source) filter.source = source;
    if (assignedTo) filter.assignedTo = assignedTo;
    if (project) filter.project = project;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    // Date range filters — include full end day
    if (createdFrom || createdTo) {
      filter.createdAt = {};
      if (createdFrom) filter.createdAt.$gte = new Date(createdFrom);
      if (createdTo) {
        const end = new Date(createdTo);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }
    if (followUpFrom || followUpTo) {
      filter.followUpDate = {};
      if (followUpFrom) filter.followUpDate.$gte = new Date(followUpFrom);
      if (followUpTo) {
        const end = new Date(followUpTo);
        end.setHours(23, 59, 59, 999);
        filter.followUpDate.$lte = end;
      }
    }

    const perPage = Math.min(Number(limit) || 30, 100);
    const currentPage = Math.max(Number(page) || 1, 1);
    const skip = (currentPage - 1) * perPage;

    const [leads, total] = await Promise.all([
      Lead.find(filter)
        .populate('assignedTo', 'name email')
        .populate('createdBy', 'name')
        .populate('project', 'name developer')
        .populate('remarks.addedBy', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(perPage)
        .lean(),
      Lead.countDocuments(filter),
    ]);

    res.json({
      leads,
      total,
      page: currentPage,
      pages: Math.ceil(total / perPage),
    });
  } catch (err) {
    next(err);
  }
};

exports.getLead = async (req, res, next) => {
  try {
    const lead = await Lead.findById(req.params.id)
      .populate('assignedTo', 'name email')
      .populate('createdBy', 'name')
      .populate('project', 'name developer')
      .populate('remarks.addedBy', 'name');

    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    // Sales users may only view leads assigned to them
    if (req.user.role === 'sales' &&
        String(lead.assignedTo?._id ?? lead.assignedTo) !== String(req.user.id)) {
      return res.status(403).json({ message: 'Not authorised' });
    }

    res.json(lead);
  } catch (err) {
    next(err);
  }
};

exports.createLead = async (req, res, next) => {
  try {
    const { name, phone, email, source, status, notes, followUpDate, assignedTo, project, customFields } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ message: 'name and phone are required' });
    }

    const cleaned = cleanPhone(phone);

    // Determine assignee:
    // 1. Explicit assignedTo from body (admin/manager override)
    // 2. Auto-assign from project's round-robin agent list
    // 3. Fall back to the creator
    let resolvedAssignee = assignedTo || null;

    if (!resolvedAssignee && project) {
      resolvedAssignee = await resolveProjectAgent(project);
    }

    if (!resolvedAssignee) {
      resolvedAssignee = req.user.id;
    }

    // Duplicate detection — same (phone + project) pair is treated as duplicate.
    // Different projects with same phone are separate leads (separate opportunities).
    const existing = await Lead.findOne({ phone: cleaned, project: project || null });
    if (existing) {
      const mergedCustomFields = customFields
        ? { ...(existing.customFields || {}), ...customFields }
        : existing.customFields;
      const updated = await Lead.findByIdAndUpdate(
        existing._id,
        {
          $set: {
            name,
            email,
            source,
            notes,
            followUpDate,
            assignedTo: resolvedAssignee,
            customFields: mergedCustomFields,
            lastContactedAt: new Date(),
          },
        },
        { new: true, runValidators: true }
      )
        .populate('assignedTo', 'name email')
        .populate('project', 'name developer');

      return res.status(200).json({ lead: updated, duplicate: true });
    }

    const lead = await Lead.create({
      name,
      phone: cleaned,
      email,
      source,
      status: status || 'New',
      notes,
      followUpDate,
      project: project || null,
      assignedTo: resolvedAssignee,
      createdBy: req.user.id,
      customFields: customFields || undefined,
    });

    const populated = await lead.populate([
      { path: 'assignedTo', select: 'name email' },
      { path: 'project', select: 'name developer' },
    ]);

    // Notify the assigned agent (fire-and-forget)
    notifyAssignment(resolvedAssignee, lead);

    logActivity({
      req,
      action: 'lead.create',
      resource: 'lead',
      resourceId: lead._id,
      details: `Created lead "${lead.name}" (${lead.phone})`,
    });

    res.status(201).json({ lead: populated, duplicate: false });
  } catch (err) {
    next(err);
  }
};

exports.updateLead = async (req, res, next) => {
  try {
    let allowed = req.body;

    // Capture previous assignee to detect reassignment
    const existing = await Lead.findById(req.params.id).select('assignedTo');
    if (!existing) return res.status(404).json({ message: 'Lead not found' });

    if (req.user.role === 'sales') {
      if (String(existing.assignedTo) !== String(req.user.id)) {
        return res.status(403).json({ message: 'Not authorised' });
      }
      // Sales can only update a restricted set of fields
      const { status, notes, followUpDate, lastContactedAt } = req.body;
      allowed = { status, notes, followUpDate, lastContactedAt };
    }

    const lead = await Lead.findByIdAndUpdate(
      req.params.id,
      { $set: allowed },
      { new: true, runValidators: true }
    )
      .populate('assignedTo', 'name email')
      .populate('project', 'name developer');

    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    // Notify if assignedTo changed to a different agent
    if (allowed.assignedTo && String(allowed.assignedTo) !== String(existing.assignedTo)) {
      notifyAssignment(allowed.assignedTo, lead);
    }

    // Build a friendly details string of what changed
    const changes = [];
    if (allowed.status) changes.push(`status → ${allowed.status}`);
    if (allowed.followUpDate !== undefined) changes.push('followUp');
    if (allowed.assignedTo && String(allowed.assignedTo) !== String(existing.assignedTo)) changes.push('reassigned');
    if (allowed.notes !== undefined) changes.push('notes');

    logActivity({
      req,
      action: 'lead.update',
      resource: 'lead',
      resourceId: lead._id,
      details: `Updated "${lead.name}": ${changes.join(', ') || 'fields'}`,
    });

    res.json(lead);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: 'Another lead for this phone already exists on that project' });
    }
    next(err);
  }
};

exports.deleteLead = async (req, res, next) => {
  try {
    const lead = await Lead.findByIdAndDelete(req.params.id);
    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    logActivity({
      req,
      action: 'lead.delete',
      resource: 'lead',
      resourceId: lead._id,
      details: `Deleted lead "${lead.name}" (${lead.phone})`,
    });

    res.json({ message: 'Lead deleted' });
  } catch (err) {
    next(err);
  }
};

/* ─── Related Leads (same phone, different projects) ─────── */

exports.getRelatedLeads = async (req, res, next) => {
  try {
    const lead = await Lead.findById(req.params.id).select('phone');
    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    const related = await Lead.find({
      phone: lead.phone,
      _id: { $ne: lead._id },
    })
      .populate('project', 'name developer')
      .populate('assignedTo', 'name')
      .select('name status project assignedTo followUpDate createdAt')
      .sort({ createdAt: -1 })
      .lean();

    res.json(related);
  } catch (err) {
    next(err);
  }
};

/* ─── Remarks ─────────────────────────────────────────────── */

exports.addRemark = async (req, res, next) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ message: 'Remark text is required' });
    }

    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    // Sales users can only add remarks to their own leads
    if (req.user.role === 'sales' && String(lead.assignedTo) !== String(req.user.id)) {
      return res.status(403).json({ message: 'Not authorised' });
    }

    lead.remarks.push({ text: text.trim(), addedBy: req.user.id });
    await lead.save();

    logActivity({
      req,
      action: 'lead.remark',
      resource: 'lead',
      resourceId: lead._id,
      details: `Added remark to "${lead.name}": ${text.trim().slice(0, 100)}`,
    });

    // Return the lead with populated remarks
    const updated = await Lead.findById(lead._id)
      .populate('assignedTo', 'name email')
      .populate('createdBy', 'name')
      .populate('project', 'name developer')
      .populate('remarks.addedBy', 'name');

    res.status(201).json(updated);
  } catch (err) {
    next(err);
  }
};

/* ─── Bulk CSV Upload ──────────────────────────────────────── */

exports.bulkUpload = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No CSV file uploaded' });

    // Optional: project ID passed as query param for bulk upload
    const projectId = req.query.project || null;
    let projectAgentCache = null; // resolved lazily per project

    let records;
    try {
      records = parse(req.file.buffer, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
    } catch {
      return res.status(400).json({ message: 'Invalid CSV format' });
    }

    let added = 0, updated = 0;
    const errors = [];

    for (const row of records) {
      const rawPhone = row.phone || row.Phone || row.PHONE || '';
      const name = (row.name || row.Name || row.NAME || '').trim();
      const phone = cleanPhone(rawPhone);
      const rowProject = row.project_id || projectId;

      if (!name || !phone) {
        errors.push(`Skipped — missing name or phone: ${JSON.stringify(row)}`);
        continue;
      }

      // Resolve assignee for this row
      let assignee = req.user.id;
      if (rowProject) {
        const agentId = await resolveProjectAgent(rowProject);
        if (agentId) assignee = agentId;
      }

      const payload = {
        name,
        phone,
        email: row.email || row.Email || '',
        source: row.source || row.Source || 'Other',
        notes: row.notes || row.Notes || '',
        project: rowProject || null,
        assignedTo: assignee,
        createdBy: req.user.id,
      };

      try {
        // Dedupe by phone + project — same person on different projects = separate leads
        const existing = await Lead.findOne({ phone, project: rowProject || null });
        if (existing) {
          await Lead.updateOne(
            { _id: existing._id },
            { $set: { name, email: payload.email, source: payload.source, notes: payload.notes, assignedTo: payload.assignedTo } }
          );
          updated++;
        } else {
          const newLead = await Lead.create(payload);
          notifyAssignment(assignee, newLead);
          added++;
        }
      } catch (rowErr) {
        errors.push(`Error for ${name} (${phone}): ${rowErr.message}`);
      }
    }

    logActivity({
      req,
      action: 'lead.bulkUpload',
      resource: 'lead',
      details: `Bulk CSV: ${added} added, ${updated} updated, ${errors.length} skipped (${records.length} rows)`,
    });

    res.json({
      total: records.length,
      added,
      updated,
      skipped: errors.length,
      errors: errors.slice(0, 10),
    });
  } catch (err) {
    next(err);
  }
};

/* ─── Followups & Overdue ─────────────────────────────────── */

exports.getTodayFollowups = async (req, res, next) => {
  try {
    const { start, end } = todayRange();
    const filter = {
      ...buildRoleFilter(req.user),
      followUpDate: { $gte: start, $lte: end },
    };

    const leads = await Lead.find(filter)
      .populate('assignedTo', 'name email')
      .populate('project', 'name')
      .sort({ followUpDate: 1 })
      .lean();

    res.json(leads);
  } catch (err) {
    next(err);
  }
};

exports.getOverdueLeads = async (req, res, next) => {
  try {
    const { start } = todayRange();
    const filter = {
      ...buildRoleFilter(req.user),
      followUpDate: { $lt: start },
      status: { $ne: 'Closed' },
    };

    const leads = await Lead.find(filter)
      .populate('assignedTo', 'name email')
      .populate('project', 'name')
      .sort({ followUpDate: 1 })
      .lean();

    res.json(leads);
  } catch (err) {
    next(err);
  }
};

/* ─── Stats for Dashboard ─────────────────────────────────── */

exports.getStats = async (req, res, next) => {
  try {
    const baseFilter = buildRoleFilter(req.user);
    const { start, end } = todayRange();
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [total, todayFollowups, overdue, closedMonth, byStatus] = await Promise.all([
      Lead.countDocuments(baseFilter),
      Lead.countDocuments({ ...baseFilter, followUpDate: { $gte: start, $lte: end } }),
      Lead.countDocuments({ ...baseFilter, followUpDate: { $lt: start }, status: { $ne: 'Closed' } }),
      Lead.countDocuments({ ...baseFilter, status: 'Closed', updatedAt: { $gte: monthStart } }),
      Lead.aggregate([
        { $match: baseFilter },
        { $group: { _id: '$status', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
    ]);

    res.json({ total, todayFollowups, overdue, closedMonth, byStatus });
  } catch (err) {
    next(err);
  }
};
