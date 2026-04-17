const https = require('https');
const Lead = require('../models/Lead');
const Project = require('../models/Project');
const User = require('../models/User');
const WebhookLog = require('../models/WebhookLog');
const MetaMapping = require('../models/MetaMapping');
const notifyAssignment = require('../utils/notifyAssignment');
const logActivity = require('../utils/logActivity');
const cleanPhone = require('../utils/cleanPhone');

/* ─── Helpers ─────────────────────────────────────────────── */

/**
 * Call Meta Graph API to get full lead details.
 * Returns the parsed JSON or throws.
 */
const fetchMetaLead = (leadgenId) =>
  new Promise((resolve, reject) => {
    const token = process.env.META_ACCESS_TOKEN;
    if (!token) return reject(new Error('META_ACCESS_TOKEN not configured'));

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

/**
 * Map Meta field_data array → { name, phone, email }.
 * Meta uses various field name conventions across forms.
 */
const extractFields = (fieldData = []) => {
  const map = {};
  for (const f of fieldData) {
    map[f.name] = (f.values ?? [])[0] ?? '';
  }

  const name =
    map['full_name'] ||
    map['name'] ||
    `${map['first_name'] || ''} ${map['last_name'] || ''}`.trim() ||
    'Unknown';

  const phone =
    map['phone_number'] ||
    map['phone'] ||
    map['mobile_number'] ||
    map['contact_number'] ||
    '';

  const email =
    map['email'] ||
    map['email_address'] ||
    '';

  return { name, phone, email };
};

/**
 * Round-robin agent assignment from a project.
 * Identical to leadController logic — atomic findOneAndUpdate.
 */
const resolveProjectAgent = async (projectId) => {
  const project = await Project.findOneAndUpdate(
    { _id: projectId, assignedAgents: { $exists: true, $not: { $size: 0 } } },
    { $inc: { nextAgentIndex: 1 } },
    { new: false }
  );
  if (!project || !project.assignedAgents.length) return null;
  const idx = project.nextAgentIndex % project.assignedAgents.length;
  return project.assignedAgents[idx];
};

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
 * Match incoming Meta page/form to a CRM project.
 * Checks DB mappings first (formId is more specific, then pageId).
 * Falls back to META_PROJECT_MAP env var for backwards compatibility.
 */
const resolveProject = async (pageId, formId) => {
  // 1. Check DB — formId first (more specific)
  if (formId) {
    const formMapping = await MetaMapping.findOne({ metaId: formId, type: 'form' }).lean();
    if (formMapping) return formMapping.project.toString();
  }
  if (pageId) {
    const pageMapping = await MetaMapping.findOne({ metaId: pageId, type: 'page' }).lean();
    if (pageMapping) return pageMapping.project.toString();
  }

  // 2. Fallback to .env
  try {
    const raw = process.env.META_PROJECT_MAP;
    if (!raw) return null;
    const map = JSON.parse(raw);
    return map[formId] || map[pageId] || null;
  } catch {
    return null;
  }
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

  // 2. Fetch full lead data from Graph API
  let metaData;
  try {
    metaData = await fetchMetaLead(leadgen_id);
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

  // 5. Resolve project + agent assignment
  const projectId = await resolveProject(page_id, form_id);
  let assignedTo = null;

  if (projectId) {
    assignedTo = await resolveProjectAgent(projectId);
  }

  if (!assignedTo) {
    assignedTo = await resolveSystemUser().catch((err) => {
      console.error('[META] Cannot resolve system user:', err.message);
      return null;
    });
  }

  if (!assignedTo) {
    await WebhookLog.create({
      ...logData,
      status: 'failed',
      error: 'Could not resolve assignedTo / createdBy user',
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
    await Lead.findByIdAndUpdate(existingByPhone._id, {
      $set: {
        metaLeadId: leadgen_id,
        metaAdName: ad_name,
        metaFormId: form_id,
        email: fields.email || existingByPhone.email,
        source,
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

  // 8. Create new lead
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
      project: projectId || null,
      assignedTo,
      createdBy: assignedTo,
    });

    await WebhookLog.create({
      ...logData,
      status: 'success',
      lead: lead._id,
    });

    notifyAssignment(assignedTo, lead);
    console.log(`[META] ✅ New lead created: ${lead._id} (${fields.name} / ${cleanedPhone})`);
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

exports.getMappings = async (req, res, next) => {
  try {
    const mappings = await MetaMapping.find()
      .populate('project', 'name developer')
      .sort({ createdAt: -1 })
      .lean();
    res.json(mappings);
  } catch (err) {
    next(err);
  }
};

exports.createMapping = async (req, res, next) => {
  try {
    const { metaId, type, project, label } = req.body;

    if (!metaId || !type || !project) {
      return res.status(400).json({ message: 'metaId, type, and project are required' });
    }

    const existing = await MetaMapping.findOne({ metaId });
    if (existing) {
      return res.status(409).json({ message: `This ${type} ID is already mapped` });
    }

    const mapping = await MetaMapping.create({ metaId: metaId.trim(), type, project, label: label?.trim() });
    const populated = await mapping.populate('project', 'name developer');
    logActivity({ req, action: 'mapping.create', resource: 'mapping', resourceId: mapping._id, details: `Mapped Meta ${type} ${metaId} → project` });
    res.status(201).json(populated);
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
