const https = require('https');
const Lead = require('../models/Lead');
const User = require('../models/User');
const WebhookLog = require('../models/WebhookLog');
const MetaMapping = require('../models/MetaMapping');
const notifyAssignment = require('../utils/notifyAssignment');
const notifyUnassigned = require('../utils/notifyUnassigned');
const logActivity = require('../utils/logActivity');
const cleanPhone = require('../utils/cleanPhone');
const resolveProjectAgent = require('../utils/resolveProjectAgent');
const rotateAgentInPool = require('../utils/rotateAgentInPool');
const sendCapiEvent = require('../utils/sendCapiEvent');
const { shouldRequireAcceptance, initialAcceptanceFields } = require('../utils/leadAcceptance');
const Project = require('../models/Project');
const { resolvePageContext } = require('./metaOAuthController');

/* ─── Helpers ─────────────────────────────────────────────── */

/**
 * Call Meta Graph API to get full lead details.
 * Uses the connected Page's token when available, else the env token.
 * Returns the parsed JSON or throws.
 */
const fetchMetaLead = (leadgenId, pageToken) =>
  new Promise((resolve, reject) => {
    const token = pageToken || process.env.META_ACCESS_TOKEN;
    if (!token) return reject(new Error('No Meta access token — connect a Page or set META_ACCESS_TOKEN'));

    const path = `/v19.0/${leadgenId}?fields=field_data,created_time,ad_name,form_id,ad_id&access_token=${encodeURIComponent(token)}`;

    const req = https.get({ hostname: 'graph.facebook.com', path, timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`Meta API error ${parsed.error.code}: ${parsed.error.message}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error('Failed to parse Meta API response'));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Meta Graph API timed out after 15s'));
    });
    req.on('error', reject);
  });

// Meta field names that map to the Lead's structured columns — everything else
// the lead answered is kept as a custom field.
const STANDARD_META_FIELDS = new Set([
  'full_name', 'name', 'first_name', 'last_name',
  'phone_number', 'phone', 'mobile_number', 'contact_number',
  'email', 'email_address',
]);

// "what_is_your_budget?" → "What Is Your Budget"
const humanizeFieldName = (key) =>
  String(key)
    .replace(/\?+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Map Meta field_data array → { name, phone, email, customFields }.
 * Meta uses various field name conventions across forms; every question the
 * lead answered that isn't one of the standard contact fields is captured into
 * customFields (multi-select answers are comma-joined).
 */
const extractFields = (fieldData = []) => {
  const first = {};   // first value per field — for the single-value contact fields
  const joined = {};  // all values joined — for custom (possibly multi-select) answers
  for (const f of fieldData) {
    const vals = (f.values ?? []).filter((v) => v != null && v !== '');
    first[f.name] = vals[0] ?? '';
    joined[f.name] = vals.join(', ');
  }

  const name =
    first['full_name'] ||
    first['name'] ||
    `${first['first_name'] || ''} ${first['last_name'] || ''}`.trim() ||
    'Unknown';

  const phone =
    first['phone_number'] ||
    first['phone'] ||
    first['mobile_number'] ||
    first['contact_number'] ||
    '';

  const email =
    first['email'] ||
    first['email_address'] ||
    '';

  // Everything else the lead answered (budget, config, city, custom questions…)
  const customFields = {};
  for (const [key, value] of Object.entries(joined)) {
    if (STANDARD_META_FIELDS.has(key) || !value) continue;
    customFields[humanizeFieldName(key)] = value;
  }

  return { name, phone, email, customFields };
};

// Round-robin agent assignment now lives in shared utils/resolveProjectAgent.js
// (filters by isActive + isAvailable). See top of file for import.

/**
 * Find the user to set as createdBy / assignedTo fallback.
 * Uses META_DEFAULT_ASSIGNEE_EMAIL env var first, then first admin.
 */
const resolveSystemUser = async () => {
  const email = process.env.META_DEFAULT_ASSIGNEE_EMAIL;
  if (email) {
    const user = await User.findOne({ email, isActive: true }).lean();
    if (user) return user._id;
  }
  const admin = await User.findOne({ role: 'admin', isActive: true }).lean();
  if (!admin) throw new Error('No active admin user found — set META_DEFAULT_ASSIGNEE_EMAIL');
  return admin._id;
};

/**
 * Match incoming Meta page/form to a CRM project AND the matched mapping doc
 * (so callers can honour the mapping's own agent set).
 * Checks DB mappings first (formId is more specific, then pageId).
 * Falls back to META_PROJECT_MAP env var for backwards compatibility.
 *
 * @returns {{ projectId: string|null, mapping: object|null }}
 */
const resolveRouting = async (pageId, formId) => {
  // 1. Check DB — formId first (more specific)
  if (formId) {
    const formMapping = await MetaMapping.findOne({ metaId: formId, type: 'form' }).lean();
    if (formMapping) return { projectId: formMapping.project?.toString() || null, mapping: formMapping };
  }
  if (pageId) {
    const pageMapping = await MetaMapping.findOne({ metaId: pageId, type: 'page' }).lean();
    if (pageMapping) return { projectId: pageMapping.project?.toString() || null, mapping: pageMapping };
  }

  // 2. Fallback to .env (no agent set — project routing only)
  try {
    const raw = process.env.META_PROJECT_MAP;
    if (raw) {
      const map = JSON.parse(raw);
      const pid = map[formId] || map[pageId] || null;
      if (pid) return { projectId: pid, mapping: null };
    }
  } catch {
    /* ignore malformed env map */
  }
  return { projectId: null, mapping: null };
};

/* ─── Core Lead Processing ────────────────────────────────── */

const processLeadgenEvent = async (value) => {
  const { leadgen_id, page_id, form_id, ad_id, ad_name } = value;

  const logData = {
    metaLeadId: leadgen_id,
    metaFormId: form_id,
    metaPageId: page_id,
    metaAdId: ad_id,
    metaAdName: ad_name,
  };

  // 0. Meta's Webhooks "Send to server" sample uses all-4s placeholder ids
  // (leadgen_id/page_id = "444444444444"). It's not a real lead — skip cleanly
  // so it doesn't look like a failure. Real test leads come from the Lead Ads
  // Testing Tool with genuine ids.
  if (/^4+$/.test(String(leadgen_id || '')) || /^4+$/.test(String(page_id || ''))) {
    await WebhookLog.create({
      ...logData,
      status: 'skipped',
      error: 'Meta webhook sample ping (placeholder data) — use the Lead Ads Testing Tool for a real lead',
    });
    console.log('[META] Skipped Meta webhook sample ping (dummy 4s payload)');
    return;
  }

  // 1. Idempotency — skip if already processed
  const alreadyExists = await Lead.findOne({ metaLeadId: leadgen_id }).lean();
  if (alreadyExists) {
    await WebhookLog.create({
      ...logData,
      status: 'duplicate',
      isDuplicate: true,
      lead: alreadyExists._id,
    });
    console.log(`[META] Duplicate leadgen_id ${leadgen_id} — skipped`);
    return;
  }

  // 1b. Resolve the connected Page (token to fetch the lead + default routing project)
  const pageCtx = await resolvePageContext(page_id).catch(() => null);

  // 2. Fetch full lead data from Graph API (using the Page's token when connected)
  let metaData;
  try {
    metaData = await fetchMetaLead(leadgen_id, pageCtx?.token);
  } catch (err) {
    await WebhookLog.create({
      ...logData,
      status: 'failed',
      error: `Graph API fetch failed: ${err.message}`,
    });
    console.error(`[META] Graph API error for ${leadgen_id}:`, err.message);
    return;
  }

  logData.rawPayload = metaData;

  // 3. Extract fields
  const fields = extractFields(metaData.field_data);
  logData.extractedName = fields.name;
  logData.extractedPhone = fields.phone;
  logData.extractedEmail = fields.email;

  // 4. Validate — phone is required
  const cleanedPhone = cleanPhone(fields.phone);
  if (!cleanedPhone) {
    await WebhookLog.create({
      ...logData,
      status: 'skipped',
      error: 'No phone number in lead form data',
    });
    console.warn(`[META] No phone for leadgen_id ${leadgen_id} — skipped`);
    return;
  }

  // 5. Resolve project (read-only — no side effects).
  // NOTE: agent assignment is deferred until AFTER the duplicate check below, because
  // resolveProjectAgent() atomically advances the weighted round-robin cursor. Resolving
  // it here would let a duplicate lead consume a rotation slot and skip the next agent.
  // createdBy still requires a real user, so always resolve a system user for that.
  // Form/page MetaMapping wins; else fall back to the connected Page's default project.
  const routing = await resolveRouting(page_id, form_id);
  const projectId =
    routing.projectId ||
    (pageCtx?.defaultProject ? String(pageCtx.defaultProject) : null);

  const createdBy = await resolveSystemUser().catch((err) => {
    console.error('[META] Cannot resolve system user:', err.message);
    return null;
  });
  if (!createdBy) {
    await WebhookLog.create({
      ...logData,
      status: 'failed',
      error: 'Could not resolve a system user for createdBy',
    });
    return;
  }

  // 6. Source — Instagram or Ads
  const source =
    process.env.META_INSTAGRAM_PAGE_ID && page_id === process.env.META_INSTAGRAM_PAGE_ID
      ? 'Instagram'
      : 'Ads';

  // 7. Duplicate check by phone + project — same phone on different projects = separate leads
  const existingByPhone = await Lead.findOne({ phone: cleanedPhone, project: projectId || null });
  if (existingByPhone) {
    // Merge any new form answers into the existing lead's custom fields.
    const mergedCustomFields = { ...(existingByPhone.customFields || {}), ...fields.customFields };
    await Lead.findByIdAndUpdate(existingByPhone._id, {
      $set: {
        metaLeadId: leadgen_id,
        metaAdName: ad_name,
        metaFormId: form_id,
        email: fields.email || existingByPhone.email,
        source,
        customFields: mergedCustomFields,
        lastContactedAt: new Date(),
      },
    });

    await WebhookLog.create({
      ...logData,
      status: 'duplicate',
      isDuplicate: true,
      lead: existingByPhone._id,
    });

    console.log(`[META] Duplicate phone ${cleanedPhone} for same project — updated lead ${existingByPhone._id}`);
    return;
  }

  // 8. Genuinely new lead — NOW advance the rotation cursor and assign.
  // If the matched form/page mapping pins its own agent set, round-robin within
  // that set (scoped). Otherwise use the project's weighted round-robin.
  // assignedTo may be null (no eligible agent) — that's OK, the lead stays unassigned.
  const mappingPool = (routing.mapping?.assignedAgents || []).map(String);
  let assignedTo = null;
  let usedMappingPool = false;
  if (mappingPool.length) {
    assignedTo = await rotateAgentInPool(MetaMapping, routing.mapping);
    if (assignedTo) usedMappingPool = true;
  }
  if (!assignedTo && projectId) {
    assignedTo = await resolveProjectAgent(projectId);
  }

  // A single-agent mapping is a deliberate pin — skip the accept/reassign timer.
  // A multi-agent mapping keeps the timer, scoped to its own set via assignmentPool
  // so an ignored lead only bounces within that subset (never the whole project).
  const isFixedPin = usedMappingPool && mappingPool.length === 1;
  const assignmentPool = usedMappingPool && mappingPool.length > 1 ? mappingPool : undefined;

  // Auto-assigned leads require the agent to Accept within 15 min (business hours only).
  const acceptance = (!isFixedPin && shouldRequireAcceptance(assignedTo))
    ? initialAcceptanceFields(assignedTo)
    : {};

  // 9. Create new lead
  try {
    const lead = await Lead.create({
      name: fields.name,
      phone: cleanedPhone,
      email: fields.email,
      source,
      status: 'New',
      metaLeadId: leadgen_id,
      metaAdName: ad_name,
      metaFormId: form_id,
      customFields: Object.keys(fields.customFields).length ? fields.customFields : undefined,
      project: projectId || null,
      assignedTo: assignedTo || null,
      createdBy,
      assignmentPool,
      ...acceptance,
    });

    await WebhookLog.create({
      ...logData,
      status: 'success',
      lead: lead._id,
    });

    if (assignedTo) {
      notifyAssignment(assignedTo, lead);
    } else {
      const project = projectId ? await Project.findById(projectId).select('name').lean() : null;
      notifyUnassigned({ ...lead.toObject(), project });
    }

    // CAPI: fire the initial "Lead" funnel event (Meta recommends every stage,
    // starting from the raw lead). Fire-and-forget — never blocks lead creation.
    // No-op until the dataset id + token are configured.
    sendCapiEvent(lead, 'Lead').catch(() => {});

    console.log(`[META] ✅ New lead created: ${lead._id} (${fields.name} / ${cleanedPhone}) — ${assignedTo ? 'assigned' : 'UNASSIGNED'}`);
  } catch (err) {
    await WebhookLog.create({
      ...logData,
      status: 'failed',
      error: `Lead create failed: ${err.message}`,
    });
    console.error(`[META] Failed to create lead for ${leadgen_id}:`, err.message);
  }
};

/* ─── Exported Route Handlers ─────────────────────────────── */

/**
 * GET /api/webhook/meta
 * Meta verification handshake — must respond with hub.challenge
 */
exports.verifyWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log('[META] Webhook verification successful');
    return res.status(200).send(challenge);
  }

  console.warn('[META] Webhook verification failed — token mismatch');
  res.status(403).json({ message: 'Verification failed' });
};

/**
 * POST /api/webhook/meta
 * Receives lead events from Meta. Responds 200 immediately (Meta requires <5s),
 * then processes asynchronously.
 */
exports.handleLeadEvent = (req, res) => {
  // Respond immediately — Meta retries if we don't reply within 5 seconds
  res.sendStatus(200);

  const entries = req.body?.entry ?? [];

  for (const entry of entries) {
    for (const change of (entry.changes ?? [])) {
      if (change.field !== 'leadgen') continue;

      // Fire and forget — each event isolated in its own try/catch
      processLeadgenEvent(change.value).catch((err) => {
        console.error('[META] Unhandled error in processLeadgenEvent:', err.message);
      });
    }
  }
};

/* ─── Webhook Log API (for frontend dashboard) ─────────────── */

exports.getLogs = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const skip = (Number(page) - 1) * Number(limit);
    const [logs, total] = await Promise.all([
      WebhookLog.find(filter)
        .populate('lead', 'name phone status assignedTo')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      WebhookLog.countDocuments(filter),
    ]);

    res.json({ logs, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    next(err);
  }
};

exports.getLogStats = async (req, res, next) => {
  try {
    const [total, byStatus, last24h] = await Promise.all([
      WebhookLog.countDocuments(),
      WebhookLog.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      WebhookLog.countDocuments({
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      }),
    ]);

    const statusMap = Object.fromEntries(byStatus.map((s) => [s._id, s.count]));

    res.json({
      total,
      last24h,
      success: statusMap.success || 0,
      duplicate: statusMap.duplicate || 0,
      failed: statusMap.failed || 0,
      skipped: statusMap.skipped || 0,
    });
  } catch (err) {
    next(err);
  }
};

/* ─── Meta → Project Mappings (CRUD) ────────────────────────── */

/**
 * Validate a mapping's agent set: every id must be an agent assigned to the
 * project, duplicates removed. Returns { ids } on success or { error }.
 * Empty/undefined → [] (project round-robin).
 */
const validateMappingAgents = async (projectId, agentIds) => {
  if (!agentIds || !Array.isArray(agentIds) || agentIds.length === 0) return { ids: [] };
  const unique = [...new Set(agentIds.map(String))];
  const projectDoc = await Project.findById(projectId).select('assignedAgents').lean();
  if (!projectDoc) return { error: 'Project not found' };
  const members = new Set((projectDoc.assignedAgents || []).map(String));
  if (unique.some((id) => !members.has(id))) {
    return { error: 'Every selected agent must be assigned to this project first.' };
  }
  return { ids: unique };
};

exports.getMappings = async (req, res, next) => {
  try {
    const mappings = await MetaMapping.find()
      .populate('project', 'name developer')
      .populate('assignedAgents', 'name email')
      .sort({ createdAt: -1 })
      .lean();
    res.json(mappings);
  } catch (err) {
    next(err);
  }
};

exports.createMapping = async (req, res, next) => {
  try {
    const { metaId, type, project, label, assignedAgents } = req.body;

    if (!metaId || !type || !project) {
      return res.status(400).json({ message: 'metaId, type, and project are required' });
    }

    const existing = await MetaMapping.findOne({ metaId });
    if (existing) {
      return res.status(409).json({ message: `This ${type} ID is already mapped` });
    }

    const agents = await validateMappingAgents(project, assignedAgents);
    if (agents.error) return res.status(400).json({ message: agents.error });

    const mapping = await MetaMapping.create({
      metaId: metaId.trim(),
      type,
      project,
      assignedAgents: agents.ids,
      label: label?.trim(),
    });
    await mapping.populate('project', 'name developer');
    const populated = await mapping.populate('assignedAgents', 'name email');
    logActivity({ req, action: 'mapping.create', resource: 'mapping', resourceId: mapping._id, details: `Mapped Meta ${type} ${metaId} → project` });
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
};

exports.updateMapping = async (req, res, next) => {
  try {
    const { project, label, assignedAgents } = req.body;
    const mapping = await MetaMapping.findById(req.params.id);
    if (!mapping) return res.status(404).json({ message: 'Mapping not found' });

    if (project !== undefined) mapping.project = project;
    if (label !== undefined) mapping.label = label?.trim();

    if (assignedAgents !== undefined) {
      const effectiveProject = project || mapping.project;
      const agents = await validateMappingAgents(effectiveProject, assignedAgents);
      if (agents.error) return res.status(400).json({ message: agents.error });
      mapping.assignedAgents = agents.ids;
      mapping.nextAgentIndex = 0; // reset rotation when the set changes
    }

    await mapping.save();
    await mapping.populate('project', 'name developer');
    await mapping.populate('assignedAgents', 'name email');
    logActivity({ req, action: 'mapping.update', resource: 'mapping', resourceId: mapping._id, details: `Updated Meta ${mapping.type} mapping ${mapping.metaId}` });
    res.json(mapping);
  } catch (err) {
    next(err);
  }
};

exports.deleteMapping = async (req, res, next) => {
  try {
    const mapping = await MetaMapping.findByIdAndDelete(req.params.id);
    if (!mapping) return res.status(404).json({ message: 'Mapping not found' });
    logActivity({ req, action: 'mapping.delete', resource: 'mapping', resourceId: mapping._id, details: `Removed Meta ${mapping.type} mapping ${mapping.metaId}` });
    res.json({ message: 'Mapping deleted' });
  } catch (err) {
    next(err);
  }
};
