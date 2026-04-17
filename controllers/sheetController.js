const https = require('https');
const http = require('http');
const { parse } = require('csv-parse/sync');
const SheetConfig = require('../models/SheetConfig');
const processSheetLead = require('../utils/processSheetLead');
const logActivity = require('../utils/logActivity');

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
 */
const syncSheet = async (config) => {
  const csv = await fetchSheetCSV(config.sheetId, config.gid || '0');

  const records = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  // Skip already-synced rows
  const newRows = records.slice(config.lastSyncedRow);
  if (!newRows.length) return { added: 0, updated: 0, skipped: 0, total: 0 };

  let added = 0, updated = 0, skipped = 0;

  for (const row of newRows) {
    const result = await processSheetLead(row, config);
    if (result.status === 'success') added++;
    else if (result.status === 'duplicate') updated++;
    else skipped++;
  }

  // Update sync cursor
  await SheetConfig.findByIdAndUpdate(config._id, {
    lastSyncedRow: config.lastSyncedRow + newRows.length,
  });

  return { added, updated, skipped, total: newRows.length };
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

    const result = await syncSheet(config);
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

    // Increment lastSyncedRow so polling doesn't re-process this row
    await SheetConfig.findByIdAndUpdate(config._id, { $inc: { lastSyncedRow: 1 } });

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

// Export syncSheet for use by polling job
exports.syncSheet = syncSheet;
