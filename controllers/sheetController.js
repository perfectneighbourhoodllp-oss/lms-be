const https = require('https');
const http = require('http');
const { parse } = require('csv-parse/sync');
const SheetConfig = require('../models/SheetConfig');
const SheetSyncLog = require('../models/SheetSyncLog');
const processSheetLead = require('../utils/processSheetLead');
const logActivity = require('../utils/logActivity');

/**
 * Persist a row outcome to the SheetSyncLog collection. Fire-and-forget —
 * logging failures must never block lead ingestion.
 *
 * Extracts name/phone/email from the raw row using the config's columnMap so
 * the log has scannable values even when the lead was skipped.
 */
const recordSyncLog = ({ config, source, row, rowNumber, result }) => {
  try {
    // Extract using the same column-map fallback the processor uses
    const cm = config?.columnMap || {};
    const getCol = (key) => {
      if (!key || !row) return '';
      if (row[key] !== undefined) return row[key];
      const lower = String(key).trim().toLowerCase();
      const match = Object.keys(row).find((k) => k.trim().toLowerCase() === lower);
      return match ? row[match] : '';
    };

    SheetSyncLog.create({
      sheetConfig: config?._id,
      sheetId: config?.sheetId,
      gid: config?.gid,
      source,
      rowNumber,
      rawRow: row,
      extractedName: String(getCol(cm.name || 'name') || '').toString().trim().slice(0, 200),
      extractedPhone: String(getCol(cm.phone || 'phone') || '').toString().trim().slice(0, 60),
      extractedEmail: String(getCol(cm.email || 'email') || '').toString().trim().slice(0, 200),
      status: result.status,
      reason: result.error || (result.status === 'success' ? 'Lead created' : result.status === 'duplicate' ? 'Existing lead updated' : undefined),
      lead: result.lead?._id,
    }).catch((err) => console.error('[SheetSyncLog] Failed to record:', err.message));
  } catch (err) {
    console.error('[SheetSyncLog] Synchronous error:', err.message);
  }
};

/* ─── Helpers ─────────────────────────────────────────────── */

/**
 * Extract Google Sheet ID from a full URL or plain ID.
 * e.g. "https://docs.google.com/spreadsheets/d/1aBcDeF.../edit" → "1aBcDeF..."
 */
const extractSheetId = (input = '') => {
  const match = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : input.trim();
};

/**
 * Extract gid (tab ID) from URL — e.g. "...#gid=1234567"
 * Defaults to "0" (first tab) if not specified.
 */
const extractGid = (input = '') => {
  const match = input.match(/[#&?]gid=(\d+)/);
  return match ? match[1] : '0';
};

/**
 * Fetch a Google Sheet as CSV.
 * Sheet must be shared as "Anyone with the link".
 */
const fetchSheetCSV = (sheetId, gid = '0') =>
  new Promise((resolve, reject) => {
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;

    const fetch = (targetUrl, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));

      const lib = targetUrl.startsWith('https') ? https : http;
      lib.get(targetUrl, { timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetch(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Sheet fetch failed with status ${res.statusCode}. Is the sheet shared as "Anyone with the link"?`));
        }
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data));
      }).on('error', reject)
        .on('timeout', function () { this.destroy(new Error('Sheet fetch timed out after 30s')); });
    };

    fetch(url);
  });

/**
 * Sync a single SheetConfig — fetch CSV, process new rows.
 * Records every row outcome in SheetSyncLog for admin debugging.
 *
 * @param {Object} config - SheetConfig document
 * @param {string} source - 'polling' | 'manual' — used for log attribution
 */
const syncSheet = async (config, source = 'polling') => {
  const csv = await fetchSheetCSV(config.sheetId, config.gid || '0');

  const records = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  // Skip already-synced rows
  const startIdx = config.lastSyncedRow;
  const newRows = records.slice(startIdx);
  if (!newRows.length) return { added: 0, updated: 0, skipped: 0, total: 0 };

  let added = 0, updated = 0, skipped = 0, failed = 0;

  for (let i = 0; i < newRows.length; i++) {
    const row = newRows[i];
    const rowNumber = startIdx + i + 2; // +2 because: +1 for 1-indexed, +1 for header row

    const result = await processSheetLead(row, config);
    recordSyncLog({ config, source, row, rowNumber, result });

    if (result.status === 'success') added++;
    else if (result.status === 'duplicate') updated++;
    else if (result.status === 'failed') failed++;
    else skipped++;
  }

  // Update sync cursor
  await SheetConfig.findByIdAndUpdate(config._id, {
    lastSyncedRow: config.lastSyncedRow + newRows.length,
  });

  return { added, updated, skipped, failed, total: newRows.length };
};

/* ─── CRUD ────────────────────────────────────────────────── */

exports.getConfigs = async (req, res, next) => {
  try {
    const configs = await SheetConfig.find()
      .populate('project', 'name developer')
      .sort({ createdAt: -1 })
      .lean();
    res.json(configs);
  } catch (err) {
    next(err);
  }
};

exports.createConfig = async (req, res, next) => {
  try {
    const { sheetUrl, sheetName, project, columnMap, customFieldMap, label } = req.body;

    if (!sheetUrl || !project) {
      return res.status(400).json({ message: 'Sheet URL and project are required' });
    }

    const sheetId = extractSheetId(sheetUrl);
    const gid = extractGid(sheetUrl);
    if (!sheetId) {
      return res.status(400).json({ message: 'Invalid Google Sheet URL' });
    }

    const existing = await SheetConfig.findOne({ sheetId, gid });
    if (existing) {
      return res.status(409).json({ message: 'This sheet tab is already configured' });
    }

    // Verify sheet is accessible
    try {
      await fetchSheetCSV(sheetId, gid);
    } catch {
      return res.status(400).json({ message: 'Cannot access this sheet tab. Make sure the sheet is shared as "Anyone with the link" and the tab exists.' });
    }

    const config = await SheetConfig.create({
      sheetId,
      gid,
      sheetName: sheetName || '',
      project,
      columnMap: columnMap || undefined,
      customFieldMap: customFieldMap || undefined,
      label: label?.trim(),
    });

    const populated = await config.populate('project', 'name developer');
    logActivity({ req, action: 'sheet.create', resource: 'sheet', resourceId: config._id, details: `Connected sheet ${config.label || config.sheetId}` });
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
};

exports.updateConfig = async (req, res, next) => {
  try {
    const { sheetName, project, columnMap, customFieldMap, label, isActive } = req.body;
    const update = {};
    if (sheetName !== undefined) update.sheetName = sheetName;
    if (project) update.project = project;
    if (columnMap) update.columnMap = columnMap;
    if (customFieldMap !== undefined) update.customFieldMap = customFieldMap;
    if (label !== undefined) update.label = label;
    if (isActive !== undefined) update.isActive = isActive;

    const config = await SheetConfig.findByIdAndUpdate(req.params.id, { $set: update }, { new: true })
      .populate('project', 'name developer');

    if (!config) return res.status(404).json({ message: 'Config not found' });

    // Audit: distinguish pause/resume from general edits so the activity log
    // tells the right story when something goes wrong later.
    const isPauseToggle =
      isActive !== undefined && Object.keys(req.body).length === 1;
    const label_ = config.label || config.sheetId;
    logActivity({
      req,
      action: isPauseToggle
        ? isActive ? 'sheet.resume' : 'sheet.pause'
        : 'sheet.update',
      resource: 'sheet',
      resourceId: config._id,
      details: isPauseToggle
        ? `${isActive ? 'Resumed' : 'Paused'} sheet ${label_}`
        : `Updated sheet ${label_}`,
    });

    res.json(config);
  } catch (err) {
    next(err);
  }
};

exports.deleteConfig = async (req, res, next) => {
  try {
    const config = await SheetConfig.findByIdAndDelete(req.params.id);
    if (!config) return res.status(404).json({ message: 'Config not found' });
    logActivity({ req, action: 'sheet.delete', resource: 'sheet', resourceId: config._id, details: `Disconnected sheet ${config.label || config.sheetId}` });
    res.json({ message: 'Sheet config removed' });
  } catch (err) {
    next(err);
  }
};

/* ─── Manual Sync ─────────────────────────────────────────── */

exports.manualSync = async (req, res, next) => {
  try {
    const config = await SheetConfig.findById(req.params.id);
    if (!config) return res.status(404).json({ message: 'Config not found' });

    const result = await syncSheet(config, 'manual');
    res.json({ message: 'Sync complete', ...result });
  } catch (err) {
    next(err);
  }
};

/* ─── Incoming Webhook (from Google Apps Script) ──────────── */

exports.incoming = async (req, res, next) => {
  try {
    const secret = req.headers['x-sheet-secret'] || req.body.secret;
    const expectedSecret = process.env.SHEET_WEBHOOK_SECRET;

    if (!expectedSecret || secret !== expectedSecret) {
      return res.status(403).json({ message: 'Invalid secret' });
    }

    const { sheetId, gid, row } = req.body;

    if (!sheetId || !row) {
      return res.status(400).json({ message: 'sheetId and row are required' });
    }

    // Match the config by sheetId + gid. If gid not provided, only allow when unambiguous.
    let config;
    if (gid !== undefined) {
      config = await SheetConfig.findOne({ sheetId, gid: String(gid), isActive: true });
    } else {
      const count = await SheetConfig.countDocuments({ sheetId, isActive: true });
      if (count > 1) {
        return res.status(400).json({ message: 'Multiple configs exist for this sheet — gid is required. Update your Apps Script to include gid.' });
      }
      config = await SheetConfig.findOne({ sheetId, isActive: true });
    }
    if (!config) {
      return res.status(404).json({ message: 'No active config for this sheet' });
    }

    const result = await processSheetLead(row, config);

    // BUG FIX (2026-05-24): we used to do `$inc: { lastSyncedRow: 1 }` here so
    // polling wouldn't re-process this row. But that assumed webhooks fire 1:1
    // with rows in order — and they don't. Whenever Apps Script dropped a
    // delivery (network blip, quota hit, script error), the cursor advanced
    // by 1 anyway, causing polling to permanently skip the missed row.
    //
    // Now: let polling own the cursor. The webhook only processes the row
    // immediately. Worst case: polling re-processes a row that came in via
    // webhook → `processSheetLead` dedup turns it into a no-op update.
    // Trade rare duplicates (handled cleanly) for zero missed leads.
    recordSyncLog({ config, source: 'webhook', row, result });

    if (result.status === 'skipped' || result.status === 'failed') {
      console.log(`[SHEET] Incoming lead from sheet ${sheetId}: ${result.status}`);
      console.log(`[SHEET] Reason: ${result.error || 'unknown'}`);
      console.log(`[SHEET] Row received:`, JSON.stringify(row));
      console.log(`[SHEET] Column map in config:`, JSON.stringify(config.columnMap));
    } else {
      console.log(`[SHEET] Incoming lead from sheet ${sheetId}: ${result.status}`);
    }
    res.json({ status: result.status });
  } catch (err) {
    next(err);
  }
};

/* ─── Sync Logs (admin viewer) ────────────────────────────── */

/**
 * GET /api/sheets/sync-logs
 * Query: sheetConfig, status, source, dateFrom, dateTo, search, page, limit
 *
 * Returns paginated SheetSyncLog entries with stats summary.
 */
exports.getSyncLogs = async (req, res, next) => {
  try {
    const {
      sheetConfig,
      status,
      source,
      dateFrom,
      dateTo,
      search,
      page = 1,
      limit = 50,
    } = req.query;

    const filter = {};
    if (sheetConfig) filter.sheetConfig = sheetConfig;
    if (status) filter.status = status;
    if (source) filter.source = source;
    if (dateFrom || dateTo) {
      filter.createdAt = {};
      if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }
    if (search) {
      filter.$or = [
        { extractedName: { $regex: search, $options: 'i' } },
        { extractedPhone: { $regex: search, $options: 'i' } },
        { extractedEmail: { $regex: search, $options: 'i' } },
        { reason: { $regex: search, $options: 'i' } },
      ];
    }

    const perPage = Math.min(Number(limit) || 50, 200);
    const currentPage = Math.max(Number(page) || 1, 1);
    const skip = (currentPage - 1) * perPage;

    const [logs, total, statsAgg] = await Promise.all([
      SheetSyncLog.find(filter)
        .populate('sheetConfig', 'sheetId gid label sheetName project')
        .populate({
          path: 'sheetConfig',
          populate: { path: 'project', select: 'name' },
        })
        .populate('lead', 'name phone status')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(perPage)
        .lean(),
      SheetSyncLog.countDocuments(filter),
      // Stats summary across the SAME filter (minus pagination)
      SheetSyncLog.aggregate([
        { $match: filter },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ]);

    const stats = { success: 0, duplicate: 0, skipped: 0, failed: 0 };
    statsAgg.forEach((s) => { stats[s._id] = s.count; });

    res.json({
      logs,
      total,
      page: currentPage,
      pages: Math.ceil(total / perPage),
      stats,
    });
  } catch (err) {
    next(err);
  }
};

// Export syncSheet for use by polling job
exports.syncSheet = syncSheet;
