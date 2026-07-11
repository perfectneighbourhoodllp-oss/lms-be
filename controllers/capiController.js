const CapiEvent = require('../models/CapiEvent');
const Lead = require('../models/Lead');
const sendCapiEvent = require('../utils/sendCapiEvent');

/** GET /api/capi/status — is CAPI configured, and recent send stats. */
exports.getStatus = async (req, res, next) => {
  try {
    const configured = Boolean(process.env.META_PIXEL_ID && process.env.META_CAPI_TOKEN);
    const [total, byStatus] = await Promise.all([
      CapiEvent.countDocuments(),
      CapiEvent.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    ]);
    const stats = { success: 0, skipped: 0, failed: 0 };
    byStatus.forEach((s) => { stats[s._id] = s.count; });
    res.json({
      configured,
      datasetId: process.env.META_PIXEL_ID || null,
      total,
      stats,
    });
  } catch (err) {
    next(err);
  }
};

/** GET /api/capi/events — paginated log of CAPI sends. */
exports.getEvents = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    const perPage = Math.min(Number(limit) || 50, 200);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * perPage;

    const [events, total] = await Promise.all([
      CapiEvent.find(filter)
        .populate('lead', 'name phone')
        .populate('triggeredBy', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(perPage)
        .lean(),
      CapiEvent.countDocuments(filter),
    ]);
    res.json({ events, total, page: Number(page), pages: Math.ceil(total / perPage) });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/capi/test — send a test event to Meta's Test Events tab.
 * Body: { leadId?, eventName?, testEventCode }
 * Uses a real lead if leadId given (best match check), else a synthetic one.
 */
exports.sendTest = async (req, res, next) => {
  try {
    const { leadId, eventName = 'Lead', testEventCode } = req.body;
    if (!process.env.META_PIXEL_ID || !process.env.META_CAPI_TOKEN) {
      return res.status(400).json({ message: 'CAPI not configured — set META_PIXEL_ID and META_CAPI_TOKEN first.' });
    }
    if (!testEventCode) {
      return res.status(400).json({ message: 'testEventCode is required (find it in Events Manager → Test events).' });
    }

    let lead;
    if (leadId) {
      lead = await Lead.findById(leadId).select('name email phone metaLeadId').lean();
      if (!lead) return res.status(404).json({ message: 'Lead not found' });
    } else {
      // Synthetic lead — verifies the connection without touching real data.
      lead = { _id: 'test', email: 'test@example.com', phone: '+919999999999', metaLeadId: null };
    }

    const result = await sendCapiEvent(lead, eventName, {
      test: true,
      testCode: testEventCode,
      triggeredBy: req.user.id,
    });
    res.json({ message: 'Test event sent — check Events Manager → Test events.', ...result });
  } catch (err) {
    next(err);
  }
};
