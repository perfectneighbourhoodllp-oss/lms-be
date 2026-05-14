const { parse } = require('csv-parse/sync');
const Lead = require('../models/Lead');
const notifyAssignment = require('../utils/notifyAssignment');
const logActivity = require('../utils/logActivity');
const cleanPhone = require('../utils/cleanPhone');
const createNotification = require('../utils/createNotification');
const resolveProjectAgent = require('../utils/resolveProjectAgent');
const notifyUnassigned = require('../utils/notifyUnassigned');
const Project = require('../models/Project');
const { getManagerProjectFilter } = require('../utils/managerScope');

/* ─── Helpers ─────────────────────────────────────────────── */

/**
 * Build Mongoose filter based on caller's role.
 *
 *   • sales   → only their own assigned leads
 *   • admin   → no filter (sees all)
 *   • manager → if they have project assignments, scoped to those;
 *               otherwise no filter (sees all).
 *
 * Async because manager scoping requires a DB lookup for assigned projects.
 */
const buildRoleFilter = async (user) => {
  if (user.role === 'sales') return { assignedTo: user.id };
  if (user.role === 'admin') return {};
  // Manager: apply project-scope filter if any projects are assigned.
  return await getManagerProjectFilter(user);
};

/**
 * Safely apply a URL-supplied `project` filter, respecting the role/scope
 * already set on `filter`. If the requested project is outside the manager's
 * scope, returns `null` — caller should short-circuit to empty results.
 *
 * @returns {object | null} mutated filter, or null if scope violation
 */
const applyProjectQuery = (filter, requestedProject) => {
  if (!requestedProject) return filter;
  // If the role filter already restricts to a list of projects (manager scope),
  // the requested project must be inside that list.
  if (filter.project && Array.isArray(filter.project.$in)) {
    const scopedIds = filter.project.$in.map(String);
    if (!scopedIds.includes(String(requestedProject))) {
      return null; // out-of-scope → caller returns empty
    }
  }
  filter.project = requestedProject;
  return filter;
};

const todayRange = () => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

/* ─── Controllers ─────────────────────────────────────────── */

exports.getLeads = async (req, res, next) => {
  try {
    const { status, source, search, assignedTo, project, page, limit,
            createdFrom, createdTo, followUpFrom, followUpTo, hasFollowUp, overdue } = req.query;
    const filter = await buildRoleFilter(req.user);

    if (status) filter.status = status;
    if (source) filter.source = source;
    // Sales users are locked to their own leads (set by buildRoleFilter).
    // Don't let them override assignedTo via query params.
    if (req.user.role !== 'sales') {
      if (assignedTo === 'unassigned') filter.assignedTo = null;
      else if (assignedTo) filter.assignedTo = assignedTo;
    }
    // Apply project filter while respecting manager scope
    if (applyProjectQuery(filter, project) === null) {
      // Manager tried to filter to a project they don't manage — return empty
      const perPage = Math.min(Number(limit) || 30, 100);
      const currentPage = Math.max(Number(page) || 1, 1);
      return res.json({ leads: [], total: 0, page: currentPage, limit: perPage });
    }
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
    } else if (hasFollowUp === 'true') {
      // Any lead with a follow-up scheduled (not null/undefined)
      filter.followUpDate = { $exists: true, $ne: null };
    } else if (hasFollowUp === 'false') {
      // Leads without any follow-up
      filter.followUpDate = { $in: [null, undefined] };
    }

    // Overdue: followUpDate < today's start AND status not in terminal set.
    // Used by the dashboard "Overdue" stat card click-through.
    if (overdue === 'true') {
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      filter.followUpDate = { $lt: startOfToday };
      filter.status = { $nin: ['Closed', 'Not Interested', 'Dead'] };
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
    // 2. Auto-assign from project's round-robin agent list (may return null if all paused)
    // 3. If no project: fall back to creator
    // 4. If project but no eligible agent: leave null (admins/managers will be notified)
    let resolvedAssignee = assignedTo || null;

    if (!resolvedAssignee && project) {
      resolvedAssignee = await resolveProjectAgent(project);
      // If still null after trying project agents, intentionally keep null
    }

    if (!resolvedAssignee && !project) {
      // No project specified at all → assign to creator (existing behavior)
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

    // Notify based on assignment outcome
    if (resolvedAssignee) {
      notifyAssignment(resolvedAssignee, lead, req.user.id);
    } else {
      // Project exists but had no eligible agent — alert admins/managers
      notifyUnassigned(populated);
    }

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
      notifyAssignment(allowed.assignedTo, lead, req.user.id);
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

exports.bulkDelete = async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'ids must be a non-empty array of lead IDs' });
    }

    const result = await Lead.deleteMany({ _id: { $in: ids } });

    logActivity({
      req,
      action: 'lead.bulkDelete',
      resource: 'lead',
      details: `Bulk deleted ${result.deletedCount} lead${result.deletedCount !== 1 ? 's' : ''}`,
    });

    res.json({ deletedCount: result.deletedCount });
  } catch (err) {
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

    // Notify the assigned agent if someone else added the remark
    if (lead.assignedTo) {
      createNotification({
        userId: lead.assignedTo,
        actorId: req.user.id,
        type: 'lead.remark',
        title: `New remark on ${lead.name}`,
        message: `${req.user.name}: ${text.trim().slice(0, 120)}`,
        relatedLead: lead._id,
      });
    }

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

      // Resolve assignee for this row.
      // - If project specified and has an eligible agent → that agent
      // - If project specified but no eligible agent → leave null (notify admins/managers)
      // - If no project → fall back to uploader
      let assignee = null;
      if (rowProject) {
        assignee = await resolveProjectAgent(rowProject);
      } else {
        assignee = req.user.id;
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
        const existing = await Lead.findOne({ phone, project: rowProject || null });
        if (existing) {
          // On duplicate: only update assignedTo if we resolved a real agent —
          // don't overwrite an existing assignment with null
          const updateSet = { name, email: payload.email, source: payload.source, notes: payload.notes };
          if (assignee) updateSet.assignedTo = assignee;
          await Lead.updateOne({ _id: existing._id }, { $set: updateSet });
          updated++;
        } else {
          const newLead = await Lead.create(payload);
          if (assignee) {
            notifyAssignment(assignee, newLead, req.user.id);
          } else {
            const project = rowProject ? await Project.findById(rowProject).select('name').lean() : null;
            notifyUnassigned({ ...newLead.toObject(), project });
          }
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
      ...(await buildRoleFilter(req.user)),
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
      ...(await buildRoleFilter(req.user)),
      followUpDate: { $lt: start },
      status: { $nin: ['Closed', 'Not Interested', 'Dead'] },
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
    const baseFilter = await buildRoleFilter(req.user);
    const { start, end } = todayRange();
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [total, todayFollowups, overdue, closedMonth, byStatus] = await Promise.all([
      Lead.countDocuments(baseFilter),
      Lead.countDocuments({ ...baseFilter, followUpDate: { $gte: start, $lte: end } }),
      Lead.countDocuments({ ...baseFilter, followUpDate: { $lt: start }, status: { $nin: ['Closed', 'Not Interested', 'Dead'] } }),
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

/* ─── CSV Export ──────────────────────────────────────────── */

const csvEscape = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const toCsvRow = (arr) => arr.map(csvEscape).join(',');

const fmtIst = (d) => {
  if (!d) return '';
  return new Date(d).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });
};

exports.exportLeads = async (req, res, next) => {
  try {
    // Same filter logic as getLeads
    const { status, source, search, assignedTo, project,
            createdFrom, createdTo, followUpFrom, followUpTo, hasFollowUp } = req.query;
    const filter = await buildRoleFilter(req.user);

    if (status) filter.status = status;
    if (source) filter.source = source;
    // Sales users are locked to their own leads (set by buildRoleFilter).
    // Don't let them override assignedTo via query params.
    if (req.user.role !== 'sales') {
      if (assignedTo === 'unassigned') filter.assignedTo = null;
      else if (assignedTo) filter.assignedTo = assignedTo;
    }
    // Apply project filter while respecting manager scope
    if (applyProjectQuery(filter, project) === null) {
      // Manager tried to export a project they don't manage — empty CSV
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
      return res.end('');
    }
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }
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
    } else if (hasFollowUp === 'true') {
      filter.followUpDate = { $exists: true, $ne: null };
    } else if (hasFollowUp === 'false') {
      filter.followUpDate = { $in: [null, undefined] };
    }

    const leads = await Lead.find(filter)
      .populate('assignedTo', 'name email')
      .populate('project', 'name developer')
      .sort({ createdAt: -1 })
      .lean();

    // Collect all unique custom field keys across matched leads
    const customKeys = new Set();
    for (const l of leads) {
      if (l.customFields && typeof l.customFields === 'object') {
        for (const k of Object.keys(l.customFields)) customKeys.add(k);
      }
    }
    const customCols = Array.from(customKeys).sort();

    const header = [
      'Name', 'Phone', 'Email', 'Source', 'Status',
      'Project', 'Project Developer',
      'Follow-up Date (IST)', 'Assigned Agent', 'Agent Email',
      'Notes', 'Remarks',
      'Created At (IST)', 'Updated At (IST)',
      ...customCols,
    ];

    // Concatenate all remarks chronologically with date prefix
    const joinRemarks = (remarks = []) =>
      remarks
        .map((r) => {
          const when = r.createdAt
            ? new Date(r.createdAt).toLocaleDateString('en-IN', {
                day: '2-digit', month: 'short', year: 'numeric',
                timeZone: 'Asia/Kolkata',
              })
            : '';
          return when ? `[${when}] ${r.text}` : r.text;
        })
        .join(' | ');

    const rows = [toCsvRow(header)];
    for (const l of leads) {
      const row = [
        l.name,
        l.phone,
        l.email,
        l.source,
        l.status,
        l.project?.name,
        l.project?.developer,
        fmtIst(l.followUpDate),
        l.assignedTo?.name,
        l.assignedTo?.email,
        l.notes,
        joinRemarks(l.remarks),
        fmtIst(l.createdAt),
        fmtIst(l.updatedAt),
        ...customCols.map((k) => l.customFields?.[k] ?? ''),
      ];
      rows.push(toCsvRow(row));
    }

    const csv = rows.join('\r\n');
    const today = new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${today}.csv"`);
    // BOM so Excel opens UTF-8 correctly
    res.send('\uFEFF' + csv);

    logActivity({
      req,
      action: 'lead.export',
      resource: 'lead',
      details: `Exported ${leads.length} leads as CSV`,
    });
  } catch (err) {
    next(err);
  }
};
