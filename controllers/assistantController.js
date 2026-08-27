const Lead = require('../models/Lead');
const User = require('../models/User');
const AssistantChat = require('../models/AssistantChat');
const AssistantUsage = require('../models/AssistantUsage');
const { suggestNextAction, askAssistant, MODEL } = require('../services/aiAssistant');
const { getManagerLeadFilter } = require('../utils/managerScope');

// How many recent exchanges to replay as conversation memory.
const MEMORY_TURNS = 20;

// Per-million-token USD rates (standard, not intro). cacheRead = 0.1x input,
// cacheWrite = 1.25x input. Used to compute a per-request cost for the admin view.
const PRICING = {
  'claude-sonnet-5': { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-opus-5': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};
const computeCost = (model, u) => {
  const p = PRICING[model] || PRICING['claude-sonnet-5'];
  return (
    (u.input * p.in + u.output * p.out + u.cacheRead * p.cacheRead + u.cacheCreate * p.cacheWrite) / 1e6
  );
};

// Pull this user's recent completed exchanges for conversation memory.
async function loadMemory(userId) {
  try {
    const recent = await AssistantChat.find({ user: userId, answer: { $ne: '' } })
      .sort({ createdAt: -1 })
      .limit(MEMORY_TURNS)
      .select('question answer')
      .lean();
    return recent.reverse();
  } catch (e) {
    console.error('[assistant] memory load failed:', e.message);
    return [];
  }
}

// Persist the exchange (7-day TTL) + the token usage/cost (180-day TTL).
// Best-effort — logging must never fail the request.
async function persist(userId, question, answer, usage) {
  try {
    await AssistantChat.create({ user: userId, question: String(question).trim(), answer });
  } catch (e) {
    console.error('[assistant] history save failed:', e.message);
  }
  if (usage) {
    try {
      await AssistantUsage.create({
        user: userId,
        model: MODEL,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheCreateTokens: usage.cacheCreate,
        costUsd: computeCost(MODEL, usage),
      });
    } catch (e) {
      console.error('[assistant] usage log failed:', e.message);
    }
  }
}

/**
 * POST /api/assistant/ask/stream   { question }
 * Streaming chat assistant (Server-Sent Events). Emits `{delta}` chunks as the
 * answer is generated, then `{done}` (or `{error}`). Scoped to the caller's role.
 */
exports.askStream = async (req, res) => {
  const { question } = req.body || {};

  // SSE headers — flush immediately and disable proxy buffering (Render/nginx).
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const history = await loadMemory(req.user.id);
    const out = await askAssistant({
      question,
      user: req.user,
      history,
      onText: (delta) => send({ delta }),
    });
    await persist(req.user.id, question, out.answer, out.usage);
    send({ done: true });
  } catch (err) {
    const msg = /not configured|required/i.test(err.message) ? err.message : 'Something went wrong. Please try again.';
    send({ error: msg });
  }
  res.end();
};

/**
 * POST /api/assistant/ask   { question }
 * Non-streaming fallback (used if SSE streaming isn't available on the client).
 * Same behaviour + logging; returns { answer } as JSON.
 */
exports.ask = async (req, res, next) => {
  try {
    const { question } = req.body || {};
    const history = await loadMemory(req.user.id);
    const out = await askAssistant({ question, user: req.user, history });
    await persist(req.user.id, question, out.answer, out.usage);
    res.json({ answer: out.answer });
  } catch (err) {
    if (/not configured|required/i.test(err.message)) {
      return res.status(400).json({ message: err.message });
    }
    next(err);
  }
};

/**
 * GET /api/assistant/usage?days=30   (admin only)
 * Aggregate AI-assistant token usage + cost across all users for the period.
 */
exports.usage = async (req, res, next) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 180);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await AssistantUsage.find({ createdAt: { $gte: since } })
      .select('user costUsd inputTokens outputTokens cacheReadTokens cacheCreateTokens')
      .lean();

    const totals = { cost: 0, requests: rows.length, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    const byUser = new Map();
    for (const r of rows) {
      totals.cost += r.costUsd || 0;
      totals.input += r.inputTokens || 0;
      totals.output += r.outputTokens || 0;
      totals.cacheRead += r.cacheReadTokens || 0;
      totals.cacheCreate += r.cacheCreateTokens || 0;
      const k = String(r.user);
      const cur = byUser.get(k) || { user: k, cost: 0, requests: 0 };
      cur.cost += r.costUsd || 0;
      cur.requests += 1;
      byUser.set(k, cur);
    }

    // Resolve user names.
    const ids = [...byUser.keys()];
    const users = await User.find({ _id: { $in: ids } }).select('name role').lean();
    const nameMap = Object.fromEntries(users.map((u) => [String(u._id), { name: u.name, role: u.role }]));
    const perUser = [...byUser.values()]
      .map((x) => ({ name: nameMap[x.user]?.name || '—', role: nameMap[x.user]?.role || '', cost: x.cost, requests: x.requests }))
      .sort((a, b) => b.cost - a.cost);

    res.json({ days, model: MODEL, totals, byUser: perUser });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/assistant/history
 * The caller's own assistant exchanges from the last 7 days (oldest first).
 */
exports.history = async (req, res, next) => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const rows = await AssistantChat.find({ user: req.user.id, createdAt: { $gte: since } })
      .sort({ createdAt: 1 })
      .lean();
    res.json(rows.map((r) => ({ question: r.question, answer: r.answer, at: r.createdAt })));
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/assistant/leads/:id/next-action
 * Per-lead "Next Best Action". Visible to admin, the lead's manager, and the
 * assigned agent — the same people who can see the lead.
 */
exports.nextAction = async (req, res, next) => {
  try {
    const uid = req.user.id;
    const role = req.user.role;

    // Base fetch (populated for the snapshot).
    const lead = await Lead.findById(req.params.id)
      .populate('project', 'name')
      .populate('assignedTo', 'name');
    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    // Authorization: admin sees all; sales only their own; manager per their scope.
    if (role !== 'admin') {
      const assignedId = lead.assignedTo && (lead.assignedTo._id || lead.assignedTo);
      const isAssigned = assignedId && String(assignedId) === String(uid);
      let allowed = isAssigned;
      if (!allowed && role === 'manager') {
        const scope = await getManagerLeadFilter(req.user);
        // A manager with no scope ({}) sees everything; otherwise check membership.
        const match = await Lead.exists({ _id: lead._id, ...scope });
        allowed = !!match;
      }
      if (!allowed) {
        return res.status(403).json({ message: 'You do not have access to this lead.' });
      }
    }

    const suggestion = await suggestNextAction(lead);
    res.json(suggestion);
  } catch (err) {
    if (/not configured|unexpected response|declined/i.test(err.message)) {
      return res.status(400).json({ message: err.message });
    }
    next(err);
  }
};
