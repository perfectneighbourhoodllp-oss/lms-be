const Attendance = require('../models/Attendance');
const { OFFICE, evaluateAgainstOffice } = require('../config/office');

const WORK_MODES = Attendance.WORK_MODES;

// Admin & manager have cross-user visibility (matches the /team area).
const canSeeAll = (role) => role === 'admin' || role === 'manager';

// Local-day key 'YYYY-MM-DD' in IST (UTC+5:30) so a punch near midnight lands on the
// expected business day regardless of where the server runs. The client can also pass
// its own `date`, but we recompute to avoid trusting it for the one-per-day key.
const istDayKey = (d = new Date()) => {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
};

// Build a punch sub-document from the request body, stamping the office distance.
const buildPunch = (body) => {
  const { distance, within } = evaluateAgainstOffice(body.lat, body.lng);
  return {
    at: new Date(),
    lat: body.lat,
    lng: body.lng,
    accuracy: body.accuracy,
    distanceFromOffice: distance,
    withinGeofence: within,
    selfieUrl: body.selfieUrl,
    selfiePublicId: body.selfiePublicId,
  };
};

// For 'office' work mode the punch must fall inside the geofence. WFH / on-site
// visits record location but are not radius-restricted. Returns an error message
// string when the punch should be rejected, or null when it's allowed.
const geofenceError = (workMode, punch) => {
  if (workMode !== 'office') return null;
  if (punch.lat == null || punch.lng == null) {
    return 'Location is required to mark office attendance';
  }
  if (!punch.withinGeofence) {
    const d = punch.distanceFromOffice;
    return `You are ${d != null ? `${d}m` : 'too far'} from the office (must be within ${OFFICE.radiusMeters}m). Choose Work From Home or On Site Visit if you're elsewhere.`;
  }
  return null;
};

const normalizeWorkMode = (mode) => (WORK_MODES.includes(mode) ? mode : 'office');

/**
 * GET /api/attendance/office
 * Public office geofence config so the client can show live distance feedback.
 */
exports.getOfficeConfig = (req, res) => {
  res.json(OFFICE);
};

/**
 * POST /api/attendance/check-in
 * Body: { lat, lng, accuracy?, selfieUrl?, selfiePublicId? }
 * Creates today's record. Rejects if already checked in today.
 */
exports.checkIn = async (req, res, next) => {
  try {
    const date = istDayKey();
    let record = await Attendance.findOne({ user: req.user.id, date });

    if (record?.checkIn?.at) {
      return res.status(409).json({ message: 'Already checked in today' });
    }

    const workMode = normalizeWorkMode(req.body.workMode);
    const punch = buildPunch(req.body);

    const err = geofenceError(workMode, punch);
    if (err) return res.status(422).json({ message: err });

    if (!record) {
      record = new Attendance({ user: req.user.id, date });
    }
    record.workMode = workMode;
    record.checkIn = punch;
    await record.save();

    res.status(201).json(record);
  } catch (err) {
    // Duplicate-key from the unique index → someone double-tapped; treat as already checked in.
    if (err.code === 11000) {
      return res.status(409).json({ message: 'Already checked in today' });
    }
    next(err);
  }
};

/**
 * POST /api/attendance/check-out
 * Body: { lat, lng, accuracy?, selfieUrl?, selfiePublicId? }
 * Requires an existing check-in today; rejects if already checked out.
 */
exports.checkOut = async (req, res, next) => {
  try {
    const date = istDayKey();
    const record = await Attendance.findOne({ user: req.user.id, date });

    if (!record?.checkIn?.at) {
      return res.status(400).json({ message: 'You must check in before checking out' });
    }
    if (record.checkOut?.at) {
      return res.status(409).json({ message: 'Already checked out today' });
    }

    const punch = buildPunch(req.body);

    // Check-out follows the same geofence rule as the day's work mode.
    const err = geofenceError(record.workMode, punch);
    if (err) return res.status(422).json({ message: err });

    record.checkOut = punch;
    await record.save();

    res.json(record);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/attendance/today
 * The current user's record for today (or null) — drives the check-in/out button state.
 */
exports.getToday = async (req, res, next) => {
  try {
    const record = await Attendance.findOne({
      user: req.user.id,
      date: istDayKey(),
    }).lean();
    res.json(record || null);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/attendance/me
 * Query: from, to (YYYY-MM-DD), page, limit
 * The current user's records, newest first.
 */
exports.getMyAttendance = async (req, res, next) => {
  try {
    const { from, to, page = 1, limit = 50 } = req.query;
    const filter = { user: req.user.id };
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = from;
      if (to) filter.date.$lte = to;
    }

    const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
    const [items, total] = await Promise.all([
      Attendance.find(filter).sort({ date: -1 }).skip(skip).limit(Number(limit)).lean(),
      Attendance.countDocuments(filter),
    ]);

    res.json({ items, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/attendance
 * Query: from, to (YYYY-MM-DD), userId, page, limit
 * Admin/manager only — all users' records.
 */
exports.getAllAttendance = async (req, res, next) => {
  try {
    if (!canSeeAll(req.user.role)) {
      return res.status(403).json({ message: 'Not permitted' });
    }

    const { from, to, userId, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (userId) filter.user = userId;
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = from;
      if (to) filter.date.$lte = to;
    }

    const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
    const [items, total] = await Promise.all([
      Attendance.find(filter)
        .populate('user', 'name email role')
        .sort({ date: -1, createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Attendance.countDocuments(filter),
    ]);

    res.json({ items, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    next(err);
  }
};

/* ─── CSV export ─────────────────────────────────────────── */

const csvEscape = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsvRow = (arr) => arr.map(csvEscape).join(',');
const fmtIstDT = (d) =>
  d
    ? new Date(d).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
      })
    : '';
const yesNo = (v) => (v === true ? 'Yes' : v === false ? 'No' : '');

// "Late" = checked in after 10:30 AM IST (matches the Attendance page's Late tag).
const LATE_CUTOFF_MIN = 10 * 60 + 30;
const isLateCheckIn = (at) => {
  if (!at) return null;
  const ist = new Date(new Date(at).getTime() + 5.5 * 3_600_000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes() > LATE_CUTOFF_MIN;
};

/**
 * GET /api/attendance/export
 * Query: from, to (YYYY-MM-DD), userId — same filters as the list view.
 * Admin only. Returns all matching attendance records as a CSV download.
 */
exports.exportAttendance = async (req, res, next) => {
  try {
    const { from, to, userId } = req.query;
    const filter = {};
    if (userId) filter.user = userId;
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = from;
      if (to) filter.date.$lte = to;
    }

    const records = await Attendance.find(filter)
      .populate('user', 'name email role')
      .sort({ date: -1, createdAt: -1 })
      .lean();

    const header = [
      'Name', 'Email', 'Role', 'Date', 'Work Mode',
      'Check-in (IST)', 'Late (after 10:30)', 'Check-in Within Geofence', 'Check-in Distance (m)',
      'Check-out (IST)', 'Check-out Within Geofence', 'Check-out Distance (m)',
      'Hours Worked', 'Notes',
    ];
    const rows = [toCsvRow(header)];
    for (const r of records) {
      const ci = r.checkIn || {};
      const co = r.checkOut || {};
      let hours = '';
      if (ci.at && co.at) {
        const ms = new Date(co.at) - new Date(ci.at);
        if (ms > 0) hours = (ms / 3_600_000).toFixed(2);
      }
      rows.push(toCsvRow([
        r.user?.name,
        r.user?.email,
        r.user?.role,
        r.date,
        r.workMode,
        fmtIstDT(ci.at),
        yesNo(isLateCheckIn(ci.at)),
        yesNo(ci.withinGeofence),
        ci.distanceFromOffice != null ? Math.round(ci.distanceFromOffice) : '',
        fmtIstDT(co.at),
        yesNo(co.withinGeofence),
        co.distanceFromOffice != null ? Math.round(co.distanceFromOffice) : '',
        hours,
        r.notes,
      ]));
    }

    const csv = rows.join('\r\n');
    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="attendance-${today}.csv"`);
    res.send('﻿' + csv); // BOM so Excel opens UTF-8 correctly
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/attendance/upload-selfie
 * Multipart upload — multer-storage-cloudinary streams the file to Cloudinary
 * and attaches the result to req.file. Hand back the URL + public_id.
 */
exports.uploadSelfie = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }
    res.json({
      url: req.file.path,
      publicId: req.file.filename,
      mimeType: req.file.mimetype,
      size: req.file.size,
    });
  } catch (err) {
    next(err);
  }
};
