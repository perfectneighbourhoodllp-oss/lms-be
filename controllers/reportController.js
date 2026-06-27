const Lead = require('../models/Lead');
const ActivityLog = require('../models/ActivityLog');
const User = require('../models/User');

// from/to are 'YYYY-MM-DD' IST calendar days (as the client sends them). Build
// EXPLICIT IST boundaries so the report's today/week/month matches IST regardless
// of the server's timezone (Render runs UTC, which previously shifted the window).
function istToday() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function parseRange(from, to) {
  const startDay = (from || istToday()).slice(0, 10);
  const endDay = (to || startDay).slice(0, 10);
  const start = new Date(`${startDay}T00:00:00.000+05:30`);
  const end = new Date(`${endDay}T23:59:59.999+05:30`);
  return { start, end };
}

const toMap = (arr) => Object.fromEntries(arr.map((x) => [String(x._id), x.n]));

// Minutes elapsed between two instants counting ONLY the 10:00–18:30 IST working
// window (so overnight/weekend-style gaps don't inflate response time).
const OPEN_MIN = 10 * 60; // 10:00
const CLOSE_MIN = 18 * 60 + 30; // 18:30
const IST_OFFSET = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function businessMinutesBetween(startUtc, endUtc) {
  const s = startUtc.getTime() + IST_OFFSET; // shift to IST so UTC getters read local wall-clock
  const e = endUtc.getTime() + IST_OFFSET;
  if (e <= s) return 0;
  let total = 0;
  let dayMidnight = Math.floor(s / DAY_MS) * DAY_MS; // IST midnight of the start day
  while (dayMidnight < e) {
    const winStart = dayMidnight + OPEN_MIN * 60000;
    const winEnd = dayMidnight + CLOSE_MIN * 60000;
    const overlapStart = Math.max(s, winStart);
    const overlapEnd = Math.min(e, winEnd);
    if (overlapEnd > overlapStart) total += (overlapEnd - overlapStart) / 60000;
    dayMidnight += DAY_MS;
  }
  return Math.round(total);
}

/**
 * Core aggregation — per-agent activity between two Date instants.
 * Reused by the HTTP endpoint and the daily email job. Returns { from, to, agents, totals }.
 */
async function computeAgentReport(start, end) {
  const range = { $gte: start, $lte: end };

  const [assigned, calls, whatsapps, followups, closed, speedLeads, users] = await Promise.all([
      Lead.aggregate([
        { $match: { assignedTo: { $ne: null }, createdAt: range } },
        { $group: { _id: '$assignedTo', n: { $sum: 1 } } },
      ]),
      // Distinct LEADS called (repeated taps on the same lead count once).
      ActivityLog.aggregate([
        { $match: { action: 'lead.call', user: { $ne: null }, resourceId: { $ne: null }, createdAt: range } },
        { $group: { _id: { user: '$user', lead: '$resourceId' } } },
        { $group: { _id: '$_id.user', n: { $sum: 1 } } },
      ]),
      // Distinct LEADS WhatsApp'd.
      ActivityLog.aggregate([
        { $match: { action: 'lead.whatsapp', user: { $ne: null }, resourceId: { $ne: null }, createdAt: range } },
        { $group: { _id: { user: '$user', lead: '$resourceId' } } },
        { $group: { _id: '$_id.user', n: { $sum: 1 } } },
      ]),
      ActivityLog.aggregate([
        { $match: { action: 'lead.remark', user: { $ne: null }, createdAt: range } },
        { $group: { _id: '$user', n: { $sum: 1 } } },
      ]),
      Lead.aggregate([
        { $match: { assignedTo: { $ne: null }, status: 'Closed', updatedAt: range } },
        { $group: { _id: '$assignedTo', n: { $sum: 1 } } },
      ]),
      // Leads created in range that have been contacted — for speed-to-first-contact.
      Lead.find({ createdAt: range, assignedTo: { $ne: null }, 'contactLog.0': { $exists: true } })
        .select('assignedTo createdAt contactLog')
        .lean(),
      User.find({ isActive: true, role: { $in: ['sales', 'manager'] } })
        .select('name email role')
        .sort({ name: 1 })
        .lean(),
    ]);

    // Per-agent average first-contact response (business minutes).
    const speedAgg = {}; // agentId -> { sum, count }
    for (const l of speedLeads) {
      const firstAt = (l.contactLog || []).reduce(
        (min, c) => (!min || new Date(c.at) < new Date(min) ? c.at : min),
        null
      );
      if (!firstAt) continue;
      const mins = businessMinutesBetween(new Date(l.createdAt), new Date(firstAt));
      const id = String(l.assignedTo);
      (speedAgg[id] ||= { sum: 0, count: 0 });
      speedAgg[id].sum += mins;
      speedAgg[id].count += 1;
    }

    const aMap = toMap(assigned);
    const cMap = toMap(calls);
    const wMap = toMap(whatsapps);
    const fMap = toMap(followups);
    const clMap = toMap(closed);

    const agents = users.map((u) => {
      const id = String(u._id);
      const sp = speedAgg[id];
      return {
        agentId: id,
        name: u.name,
        email: u.email,
        role: u.role,
        leadsAssigned: aMap[id] || 0,
        leadsCalled: cMap[id] || 0,
        leadsWhatsapped: wMap[id] || 0,
        followUpsDone: fMap[id] || 0,
        closed: clMap[id] || 0,
        // Avg first-contact response in business minutes (null if no contacted leads).
        avgFirstContactMins: sp && sp.count ? Math.round(sp.sum / sp.count) : null,
        firstContactSample: sp ? sp.count : 0,
      };
    });

    const totals = agents.reduce(
      (t, r) => ({
        leadsAssigned: t.leadsAssigned + r.leadsAssigned,
        leadsCalled: t.leadsCalled + r.leadsCalled,
        leadsWhatsapped: t.leadsWhatsapped + r.leadsWhatsapped,
        followUpsDone: t.followUpsDone + r.followUpsDone,
        closed: t.closed + r.closed,
      }),
      { leadsAssigned: 0, leadsCalled: 0, leadsWhatsapped: 0, followUpsDone: 0, closed: 0 }
    );

    // Team-wide average first-contact response.
    const teamSpeed = Object.values(speedAgg).reduce(
      (t, s) => ({ sum: t.sum + s.sum, count: t.count + s.count }),
      { sum: 0, count: 0 }
    );
  totals.avgFirstContactMins = teamSpeed.count ? Math.round(teamSpeed.sum / teamSpeed.count) : null;

  return { from: start, to: end, agents, totals };
}

/**
 * GET /api/reports/agents?from=YYYY-MM-DD&to=YYYY-MM-DD  (admin/manager)
 */
exports.getAgentReport = async (req, res, next) => {
  try {
    const { start, end } = parseRange(req.query.from, req.query.to);
    const report = await computeAgentReport(start, end);
    res.json(report);
  } catch (err) {
    next(err);
  }
};

module.exports.computeAgentReport = computeAgentReport;
module.exports.parseRange = parseRange;

const ReportSetting = require('../models/ReportSetting');
const sendReportEmail = require('../utils/sendReportEmail');

// Basic email shape check + dedupe + normalise.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cleanEmails = (list = []) =>
  [...new Set(list.map((e) => String(e).trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)))];

/** GET /api/reports/settings  (admin) — the daily-email config. */
exports.getReportSettings = async (req, res, next) => {
  try {
    const s = await ReportSetting.getSingleton();
    res.json({ recipients: s.recipients, dailyEmailEnabled: s.dailyEmailEnabled });
  } catch (err) {
    next(err);
  }
};

/** PUT /api/reports/settings  (admin) — body: { recipients: string[], dailyEmailEnabled: bool } */
exports.updateReportSettings = async (req, res, next) => {
  try {
    const s = await ReportSetting.getSingleton();
    if (Array.isArray(req.body.recipients)) s.recipients = cleanEmails(req.body.recipients);
    if (typeof req.body.dailyEmailEnabled === 'boolean') s.dailyEmailEnabled = req.body.dailyEmailEnabled;
    await s.save();
    res.json({ recipients: s.recipients, dailyEmailEnabled: s.dailyEmailEnabled });
  } catch (err) {
    next(err);
  }
};

/** POST /api/reports/send-test  (admin) — email today's report to the configured recipients now. */
exports.sendTestReport = async (req, res, next) => {
  try {
    const s = await ReportSetting.getSingleton();
    if (!s.recipients.length) {
      return res.status(400).json({ message: 'Add at least one recipient email first' });
    }
    const { start, end } = parseRange(); // today (IST)
    const report = await computeAgentReport(start, end);
    await sendReportEmail(report, s.recipients, 'Daily (test)');
    res.json({ success: true, sentTo: s.recipients });
  } catch (err) {
    next(err);
  }
};
