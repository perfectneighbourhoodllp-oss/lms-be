const { parse } = require('csv-parse/sync');
const Lead = require('../models/Lead');
const notifyAssignment = require('../utils/notifyAssignment');
const logActivity = require('../utils/logActivity');
const cleanPhone = require('../utils/cleanPhone');
const createNotification = require('../utils/createNotification');
const resolveProjectAgent = require('../utils/resolveProjectAgent');
const notifyUnassigned = require('../utils/notifyUnassigned');
const notifyBulkAssignment = require('../utils/notifyBulkAssignment');
const User = require('../models/User');
const { shouldRequireAcceptance, initialAcceptanceFields } = require('../utils/leadAcceptance');
const advancePendingLead = require('../utils/advancePendingLead');
const Project = require('../models/Project');
const { getManagerLeadFilter } = require('../utils/managerScope');
const sendCapiEvent = require('../utils/sendCapiEvent');
const { QUALIFICATION_EVENTS } = require('../utils/sendCapiEvent');

/* ─── Helpers ─────────────────────────────────────────────── */

/**
 * Build Mongoose filter based on caller's role.
 *
 *   • sales   → only their own assigned leads
 *   • admin   → no filter (sees all)
 *   • manager → leads in their managed projects OR assigned to their team
 *               (people who report to them); no scope of either → sees all.
 *
 * Async because manager scoping requires DB lookups for projects + team.
 */
const buildRoleFilter = async (user) => {
  if (user.role === 'sales') return { assignedTo: user.id };
  if (user.role === 'admin') return {};
  // Manager: project-scope OR team-scope (union).
  return await getManagerLeadFilter(user);
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
    const { status, source, search, assignedTo, project, page, limit, leadType, tag,
            createdFrom, createdTo, followUpFrom, followUpTo, hasFollowUp, overdue, siteVisitDone } = req.query;
    const filter = await buildRoleFilter(req.user);

    if (status) filter.status = status;
    if (source) filter.source = source;
    // Tag filter — matches leads carrying this tag (tags is an array).
    if (tag) filter.tags = tag;
    // 'database' → bulk-uploaded cold data. 'live' includes legacy leads that
    // predate the leadType field (field absent), so match "not database".
    if (leadType === 'database') filter.leadType = 'database';
    else if (leadType === 'live') filter.leadType = { $ne: 'database' };
    // Site-visit milestone — catches leads with any visit, regardless of current status.
    if (siteVisitDone === 'true') filter['siteVisits.0'] = { $exists: true };
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
        .populate('statusLog.by', 'name')
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
      .populate('remarks.addedBy', 'name')
      .populate('contactLog.by', 'name')
      .populate('statusLog.by', 'name');

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
    const { name, phone, email, source, status, notes, followUpDate, assignedTo, project, customFields, tags } = req.body;

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
    // Track whether this was an automatic round-robin assignment (vs an explicit
    // pick or the creator fallback). Only auto-assignments require acceptance.
    let autoAssigned = false;

    if (!resolvedAssignee && project) {
      resolvedAssignee = await resolveProjectAgent(project);
      if (resolvedAssignee) autoAssigned = true;
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

    // Auto-assigned (round-robin) leads need the agent to Accept within 15 min
    // during business hours; explicit/manual assignments do not.
    const acceptance =
      autoAssigned && shouldRequireAcceptance(resolvedAssignee)
        ? initialAcceptanceFields(resolvedAssignee)
        : {};

    const lead = await Lead.create({
      name,
      phone: cleaned,
      email,
      source,
      status: status || 'New',
      tags: Array.isArray(tags) ? tags : [],
      notes,
      followUpDate,
      project: project || null,
      assignedTo: resolvedAssignee,
      createdBy: req.user.id,
      customFields: customFields || undefined,
      ...acceptance,
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

    // WhatsApp instant first-touch — gated inside startConversation to
    // ad-source (Ads/Instagram) live leads only. Fire-and-forget.
    require('./waAgentController').startConversation(populated).catch(() => {});

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

    // Capture previous assignee + status + qualification + project to detect changes
    const existing = await Lead.findById(req.params.id).select('assignedTo status qualification project');
    if (!existing) return res.status(404).json({ message: 'Lead not found' });

    if (req.user.role === 'sales') {
      if (String(existing.assignedTo) !== String(req.user.id)) {
        return res.status(403).json({ message: 'Not authorised' });
      }
      // Sales can only update a restricted set of fields (tags + qualification
      // included — they qualify their own leads).
      const { status, notes, followUpDate, lastContactedAt, tags, qualification } = req.body;
      allowed = { status, notes, followUpDate, lastContactedAt, tags, qualification };
    }

    // Only admins may rename a lead. Strip `name` for everyone else (managers included).
    if (req.user.role !== 'admin' && allowed.name !== undefined) delete allowed.name;
    // Site visits are append-only via POST /:id/site-visits — never via a full update.
    if (allowed.siteVisits !== undefined) delete allowed.siteVisits;

    // Stamp qualifiedAt whenever the qualification actually changes.
    const qualificationChanged =
      allowed.qualification !== undefined && allowed.qualification !== existing.qualification;
    if (qualificationChanged) allowed.qualifiedAt = new Date();

    // Admin/manager sets a project on a lead that has no agent → auto-route it to
    // that project's round-robin agent so the lead becomes actionable. Skips leads
    // that already have an agent, or when the caller explicitly picked an assignee.
    const projectChanged =
      allowed.project && String(allowed.project) !== String(existing.project || '');
    if (projectChanged && !allowed.assignedTo && !existing.assignedTo) {
      const agent = await resolveProjectAgent(allowed.project);
      if (agent) allowed.assignedTo = agent;
    }

    // A manual reassignment is deliberate and does NOT require acceptance. Clear the
    // pending-acceptance flow so the reassignment cron won't override the admin's choice.
    const manualReassign =
      allowed.assignedTo && String(allowed.assignedTo) !== String(existing.assignedTo);
    if (manualReassign) {
      allowed.acceptanceStatus = 'accepted';
      allowed.acceptDeadline = null;
    }

    // Record a status-change entry when the status actually changes.
    const update = { $set: allowed };
    if (allowed.status && allowed.status !== existing.status) {
      update.$push = {
        statusLog: {
          from: existing.status,
          to: allowed.status,
          by: req.user.id,
          at: new Date(),
        },
      };
    }

    const lead = await Lead.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true, runValidators: true }
    )
      .populate('assignedTo', 'name email')
      .populate('project', 'name developer')
      .populate('statusLog.by', 'name');

    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    // Notify if assignedTo changed to a different agent
    if (allowed.assignedTo && String(allowed.assignedTo) !== String(existing.assignedTo)) {
      notifyAssignment(allowed.assignedTo, lead, req.user.id);
    }

    // CAPI: when the lead's qualification changes to one that maps to an event
    // (Qualified / Not Qualified), send it to Meta. Fire-and-forget; no-op until
    // the dataset id + token are configured.
    if (qualificationChanged) {
      const eventName = QUALIFICATION_EVENTS[allowed.qualification];
      if (eventName) {
        sendCapiEvent(lead, eventName, {
          qualification: allowed.qualification,
          triggeredBy: req.user.id,
        }).catch(() => {});
      }
    }

    // Build a friendly details string of what changed
    const changes = [];
    if (allowed.status) changes.push(`status → ${allowed.status}`);
    if (allowed.followUpDate !== undefined) changes.push('followUp');
    if (allowed.assignedTo && String(allowed.assignedTo) !== String(existing.assignedTo)) changes.push('reassigned');
    if (projectChanged) changes.push('project');
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

/**
 * POST /api/leads/bulk-type — move selected leads between the 'live' and
 * 'database' buckets (admin). Moving to 'database' also clears any pending
 * accept flow, since database (cold) leads don't use the 15-min accept timer.
 */
exports.bulkSetLeadType = async (req, res, next) => {
  try {
    const { ids, leadType } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'ids must be a non-empty array of lead IDs' });
    }
    if (leadType !== 'live' && leadType !== 'database') {
      return res.status(400).json({ message: "leadType must be 'live' or 'database'" });
    }

    const set = { leadType };
    if (leadType === 'database') {
      // Cold database leads skip the accept/reassign flow — clear it so the cron
      // never acts on them.
      set.acceptanceStatus = 'not_required';
      set.acceptDeadline = null;
    }

    const result = await Lead.updateMany({ _id: { $in: ids } }, { $set: set });
    const n = result.modifiedCount ?? result.nModified ?? 0;

    logActivity({
      req,
      action: 'lead.bulkSetLeadType',
      resource: 'lead',
      details: `Moved ${n} lead${n !== 1 ? 's' : ''} to ${leadType === 'database' ? 'Database' : 'Live'}`,
    });

    res.json({ modifiedCount: n, leadType });
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

// POST /api/leads/:id/site-visits — append a site visit to the lead's history.
exports.addSiteVisit = async (req, res, next) => {
  try {
    const { at, feedback } = req.body;
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ message: 'Lead not found' });
    // Sales users can only log visits on their own leads.
    if (req.user.role === 'sales' && String(lead.assignedTo) !== String(req.user.id)) {
      return res.status(403).json({ message: 'Not authorised' });
    }

    lead.siteVisits.push({
      at: at ? new Date(at) : new Date(),
      feedback: (feedback || '').trim(),
      by: req.user.id,
    });
    await lead.save();

    const updated = await Lead.findById(lead._id)
      .populate('assignedTo', 'name email')
      .populate('createdBy', 'name')
      .populate('project', 'name developer')
      .populate('remarks.addedBy', 'name')
      .populate('siteVisits.by', 'name');
    res.status(201).json(updated);
  } catch (err) {
    next(err);
  }
};

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

    // Adding a remark counts as acceptance — stop the rotation churning a lead
    // that's clearly being worked.
    if (['pending', 'escalated'].includes(lead.acceptanceStatus)) {
      lead.acceptanceStatus = 'accepted';
      lead.acceptedAt = new Date();
      lead.acceptDeadline = null;
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

/**
 * POST /api/leads/:id/log-contact   body: { channel: 'call' | 'whatsapp' }
 * (alias: POST /api/leads/:id/log-call → channel defaults to 'call')
 * Records a contact attempt: appends to the lead's contactLog, stamps
 * lastContactedAt, and writes an activity ('lead.call' / 'lead.whatsapp')
 * so calls can be counted in reports.
 */
exports.logCall = async (req, res, next) => {
  try {
    const channel = req.body?.channel === 'whatsapp' ? 'whatsapp' : 'call';
    const lead = await Lead.findById(req.params.id).select('name assignedTo acceptanceStatus').lean();
    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    // Sales can only log contact on their own leads; admin/manager on any.
    if (req.user.role === 'sales' && String(lead.assignedTo) !== String(req.user.id)) {
      return res.status(403).json({ message: 'Not authorised' });
    }

    const now = new Date();
    // Working the lead (logging a call/WhatsApp) counts as acceptance — clears the
    // pending/escalated flag so the reassignment rotation stops churning it.
    const acceptPatch = ['pending', 'escalated'].includes(lead.acceptanceStatus)
      ? { acceptanceStatus: 'accepted', acceptedAt: now, acceptDeadline: null }
      : {};
    await Lead.updateOne(
      { _id: lead._id },
      {
        $set: { lastContactedAt: now, ...acceptPatch },
        $push: { contactLog: { type: channel, at: now, by: req.user.id } },
      }
    );

    logActivity({
      req,
      action: channel === 'whatsapp' ? 'lead.whatsapp' : 'lead.call',
      resource: 'lead',
      resourceId: lead._id,
      details: `${channel === 'whatsapp' ? 'WhatsApp' : 'Called'} "${lead.name}"`,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/leads/:id/accept
 * The assigned agent accepts a pending auto-assigned lead, stopping the reassign timer.
 * Atomic guard: only succeeds if the lead is still pending AND assigned to this user.
 */
exports.acceptLead = async (req, res, next) => {
  try {
    const lead = await Lead.findOneAndUpdate(
      { _id: req.params.id, assignedTo: req.user.id, acceptanceStatus: 'pending' },
      { $set: { acceptanceStatus: 'accepted', acceptedAt: new Date() } },
      { new: true }
    )
      .populate('assignedTo', 'name email')
      .populate('createdBy', 'name')
      .populate('project', 'name developer')
      .populate('remarks.addedBy', 'name');

    if (!lead) {
      return res.status(409).json({
        message: 'This lead is no longer awaiting your acceptance (already accepted or reassigned).',
      });
    }

    logActivity({
      req,
      action: 'lead.accept',
      resource: 'lead',
      resourceId: lead._id,
      details: `Accepted lead "${lead.name}" (${lead.phone})`,
    });

    res.json(lead);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/leads/:id/reject
 * The assigned agent declines a pending lead — it immediately moves to the next agent
 * in the rotation (or escalates if nobody is left), without waiting out the 15-min timer.
 */
exports.rejectLead = async (req, res, next) => {
  try {
    // Only the current assignee can reject, and only while it's still pending.
    const lead = await Lead.findOne({
      _id: req.params.id,
      assignedTo: req.user.id,
      acceptanceStatus: 'pending',
    })
      .select('name phone project assignedTo triedAgents assignmentPool')
      .lean();

    if (!lead) {
      return res.status(409).json({
        message: 'This lead is no longer awaiting your acceptance (already accepted or reassigned).',
      });
    }

    // Explicit reject → hand to the next agent in the rotation; if there's no one
    // else, it re-arms with the same (sole) agent and an admin can reassign manually.
    const { action } = await advancePendingLead(lead, { now: new Date() });

    logActivity({
      req,
      action: 'lead.reject',
      resource: 'lead',
      resourceId: lead._id,
      details: `Declined lead "${lead.name}" (${lead.phone}) — ${action}`,
    });

    res.json({ action });
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

    // Which bucket these rows land in. Defaults to 'database' (cold bulk data) —
    // uploader can tick "live leads" in the UI to send them to the real pipeline.
    // Either way, bulk uploads skip the 15-min accept/reassign flow (assign only).
    const uploadLeadType = req.query.leadType === 'live' ? 'live' : 'database';

    // Optional: assign EVERY uploaded lead to one specific agent (overrides round-robin).
    // Deliberate assignment → no 15-min acceptance flow.
    let assignToId = null;
    if (req.query.assignTo) {
      const target = await User.findOne({ _id: req.query.assignTo, isActive: true })
        .select('_id')
        .lean()
        .catch(() => null);
      if (!target) {
        return res.status(400).json({ message: 'Selected agent not found or inactive' });
      }
      assignToId = String(target._id);
    }

    // Tally assignments so we can send ONE summary notification per agent at the end
    // (instead of one email/push per lead — which would spam inboxes + hit rate limits).
    const assignedCounts = {}; // { agentId: count } for newly created leads

    // Flexible CSV header matching — case/space/underscore/hyphen-insensitive, with
    // common aliases. So "Full Name", "Mobile No", "Phone Number", "Email Address" all work.
    const ALIASES = {
      name: ['name', 'full name', 'lead name', 'customer name', 'client name'],
      phone: ['phone', 'phone number', 'mobile', 'mobile number', 'mobile no', 'contact', 'contact number', 'contact no', 'whatsapp', 'whatsapp number', 'number'],
      email: ['email', 'email address', 'e-mail', 'mail'],
      source: ['source', 'lead source'],
      notes: ['notes', 'note', 'remark', 'remarks', 'comment', 'comments', 'message'],
      project: ['project_id', 'project id', 'project', 'projectid'],
    };
    const normKey = (s) => String(s).trim().toLowerCase().replace(/[\s_-]+/g, '');
    const fieldGetter = (row) => {
      const map = {};
      for (const k of Object.keys(row)) map[normKey(k)] = row[k];
      return (key) => {
        for (const alias of ALIASES[key]) {
          const v = map[normKey(alias)];
          if (v != null && String(v).trim() !== '') return String(v).trim();
        }
        return '';
      };
    };

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
      const get = fieldGetter(row);
      const name = get('name');
      const phone = cleanPhone(get('phone'));
      const rowProject = get('project') || projectId;

      if (!name || !phone) {
        errors.push(`Skipped — missing name or phone: ${JSON.stringify(row)}`);
        continue;
      }

      // Bulk-uploaded leads are cold "database" leads — assigned (round-robin or to the
      // chosen agent) but WITHOUT the 15-min accept/reassign urgency that live leads get.
      let assignee = null;
      if (assignToId) {
        assignee = assignToId;
      } else if (rowProject) {
        assignee = await resolveProjectAgent(rowProject);
      } else {
        assignee = req.user.id; // fall back to uploader
      }

      const payload = {
        name,
        phone,
        email: get('email'),
        source: get('source') || 'Other',
        notes: get('notes'),
        project: rowProject || null,
        assignedTo: assignee,
        createdBy: req.user.id,
        leadType: uploadLeadType, // 'database' (cold) by default, or 'live' if chosen
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
          // Database leads skip the accept/reassign flow — just create + assign.
          const newLead = await Lead.create(payload);
          if (assignee) {
            // Defer notification — tally now, send ONE summary per agent after the loop.
            assignedCounts[String(assignee)] = (assignedCounts[String(assignee)] || 0) + 1;
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

    // One summary notification per agent (not per lead) — avoids inbox/push spam.
    for (const [agentId, count] of Object.entries(assignedCounts)) {
      notifyBulkAssignment(agentId, count, req.user.id);
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

    // 'live' = real pipeline (excludes bulk-uploaded cold data); legacy leads
    // without a leadType field count as live. 'database' = cold bulk uploads.
    const liveFilter = { ...baseFilter, leadType: { $ne: 'database' } };

    const [total, database, todayFollowups, overdue, closedMonth, byStatus] = await Promise.all([
      Lead.countDocuments(liveFilter),
      Lead.countDocuments({ ...baseFilter, leadType: 'database' }),
      Lead.countDocuments({ ...baseFilter, followUpDate: { $gte: start, $lte: end } }),
      Lead.countDocuments({ ...baseFilter, followUpDate: { $lt: start }, status: { $nin: ['Closed', 'Not Interested', 'Dead'] } }),
      Lead.countDocuments({ ...baseFilter, status: 'Closed', updatedAt: { $gte: monthStart } }),
      Lead.aggregate([
        { $match: baseFilter },
        { $group: { _id: '$status', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
    ]);

    res.json({ total, database, todayFollowups, overdue, closedMonth, byStatus });
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
