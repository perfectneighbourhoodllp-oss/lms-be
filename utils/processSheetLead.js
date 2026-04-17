const Lead = require('../models/Lead');
const Project = require('../models/Project');
const User = require('../models/User');
const notifyAssignment = require('./notifyAssignment');
const cleanPhone = require('./cleanPhone');

/**
 * Round-robin agent assignment from a project (atomic).
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
 * Fallback assignee — first active admin.
 */
const resolveSystemUser = async () => {
  const admin = await User.findOne({ role: 'admin', isActive: true }).lean();
  if (!admin) throw new Error('No active admin user found');
  return admin._id;
};

/**
 * Process a single lead row from a Google Sheet.
 *
 * @param {Object} row - Key-value pairs from the sheet row (using original column headers)
 * @param {Object} sheetConfig - The SheetConfig document (with columnMap, project)
 * @returns {{ status: string, lead?: Object, error?: string }}
 */
const processSheetLead = async (row, sheetConfig) => {
  try {
    const { columnMap: cm, project: projectId } = sheetConfig;

    // Apply defaults if columnMap fields are missing
    const columnMap = {
      name: cm?.name || 'name',
      phone: cm?.phone || 'phone',
      email: cm?.email || 'email',
      source: cm?.source || 'source',
      notes: cm?.notes || 'notes',
    };

    // Map columns — try exact match first, then case-insensitive + trimmed fallback
    const getCol = (key) => {
      if (row[key] !== undefined) return row[key];
      const lower = key.trim().toLowerCase();
      const match = Object.keys(row).find((k) => k.trim().toLowerCase() === lower);
      return match ? row[match] : '';
    };

    const name = (getCol(columnMap.name) || '').toString().trim();
    const rawPhone = (getCol(columnMap.phone) || '').toString();
    const email = (getCol(columnMap.email) || '').toString().trim();
    const source = (getCol(columnMap.source) || 'Ads').toString().trim();
    const notes = (getCol(columnMap.notes) || '').toString().trim();

    // Extract custom fields defined in sheetConfig.customFieldMap
    const customFields = {};
    const cfm = sheetConfig.customFieldMap || {};
    for (const [leadKey, sheetColumn] of Object.entries(cfm)) {
      if (!sheetColumn) continue;
      const val = (getCol(sheetColumn) || '').toString().trim();
      if (val) customFields[leadKey] = val;
    }

    const phone = cleanPhone(rawPhone);

    if (!phone) {
      return { status: 'skipped', error: 'No phone number' };
    }

    if (!name) {
      return { status: 'skipped', error: 'No name' };
    }

    // Validate source — default to 'Ads' if invalid
    const validSources = ['Instagram', 'Ads', 'Referral', 'Walk-in', 'Website', 'Other'];
    const resolvedSource = validSources.includes(source) ? source : 'Ads';

    // Resolve agent
    let assignedTo = await resolveProjectAgent(projectId);
    if (!assignedTo) {
      assignedTo = await resolveSystemUser();
    }

    // Duplicate check by phone + project — each (phone, project) is its own lead
    const existing = await Lead.findOne({ phone, project: projectId });
    if (existing) {
      const mergedCustomFields = { ...(existing.customFields || {}), ...customFields };
      await Lead.findByIdAndUpdate(existing._id, {
        $set: {
          name: name || existing.name,
          email: email || existing.email,
          source: resolvedSource,
          notes: notes || existing.notes,
          customFields: mergedCustomFields,
          lastContactedAt: new Date(),
        },
      });
      return { status: 'duplicate', lead: existing };
    }

    // Create new lead
    const lead = await Lead.create({
      name,
      phone,
      email,
      source: resolvedSource,
      status: 'New',
      notes,
      project: projectId,
      assignedTo,
      createdBy: assignedTo,
      customFields: Object.keys(customFields).length ? customFields : undefined,
    });

    // Notify agent
    notifyAssignment(assignedTo, lead);

    return { status: 'success', lead };
  } catch (err) {
    return { status: 'failed', error: err.message };
  }
};

module.exports = processSheetLead;
