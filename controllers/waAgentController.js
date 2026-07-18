const Lead = require('../models/Lead');
const User = require('../models/User');
const Project = require('../models/Project');
const createNotification = require('../utils/createNotification');
const { runAgent } = require('../services/anthropicAgent');
const {
  isConfigured,
  waPhone,
  sendTemplate,
  sendText,
  sendButtons,
  sendList,
} = require('../services/whatsapp');

/* ─── Qualification flow (deterministic core) ─────────────────────
 * Each question has: { slot, type: 'buttons'|'list', body, buttonText?,
 *   items: [{ id, title, value }] }.  Configuration and budget are built
 *   PER-PROJECT (from project.waConfig, falling back to the defaults below);
 *   timeline and intent are global.
 * ──────────────────────────────────────────────────────────────── */

// Fallbacks used when a project hasn't configured its own options.
const DEFAULT_CONFIGURATIONS = ['2 BHK', '3 BHK', '4 BHK / Plot'];
const DEFAULT_BUDGET_BANDS = [
  { label: 'Under ₹50L', valueLakh: 50 },
  { label: '₹50L – ₹1 Cr', valueLakh: 100 },
  { label: '₹1 – 2 Cr', valueLakh: 200 },
  { label: '₹2 Cr and above', valueLakh: 250 },
];

// Global (project-agnostic) questions.
const TIMELINE_QUESTION = {
  slot: 'timeline',
  type: 'buttons',
  body: 'When are you planning to buy?',
  items: [
    { id: 'tl_0_3', title: '0-3 months', value: '0-3 months' },
    { id: 'tl_3_6', title: '3-6 months', value: '3-6 months' },
    { id: 'tl_6p', title: '6+ months', value: '6+ months' },
  ],
};
const INTENT_QUESTION = {
  slot: 'intent',
  type: 'buttons',
  body: 'And is this primarily to live in, or an investment?',
  items: [
    { id: 'int_buy', title: 'To live in', value: 'buy' },
    { id: 'int_invest', title: 'Investment', value: 'invest' },
    { id: 'int_explore', title: 'Just exploring', value: 'exploring' },
  ],
};

// Build the ordered question list for a given project. WhatsApp allows max 3
// reply buttons, so a configuration with >3 options renders as a list instead.
function buildQuestions(project) {
  const wa = project?.waConfig || {};
  const configs = wa.configurations?.length ? wa.configurations : DEFAULT_CONFIGURATIONS;
  const bands = wa.budgetBands?.length ? wa.budgetBands : DEFAULT_BUDGET_BANDS;

  const configItems = configs.map((c, i) => ({ id: `cfg_${i}`, title: c, value: c }));
  const budgetItems = bands.map((b, i) => ({ id: `bud_${i}`, title: b.label, value: b.valueLakh }));

  return [
    {
      slot: 'configuration',
      type: configItems.length > 3 ? 'list' : 'buttons',
      body: 'Great! To share the best options — which configuration are you looking for?',
      buttonText: 'Configuration',
      items: configItems,
    },
    {
      slot: 'budgetLakh',
      type: 'list',
      body: 'What budget range are you considering?',
      buttonText: 'Budget',
      items: budgetItems,
    },
    TIMELINE_QUESTION,
    INTENT_QUESTION,
  ];
}

const nextQuestion = (slots, questions) => questions.find((q) => slots?.[q.slot] == null);
const questionBySlot = (slot, questions) => questions.find((q) => q.slot === slot);

// Decode a button/list reply against the question it answered → [slot, value].
const decodeAnswer = (q, interactiveId, title) => {
  if (!q) return null;
  const hit =
    q.items.find((o) => o.id === interactiveId) ||
    (title ? q.items.find((o) => o.title === title) : null);
  return hit ? [q.slot, hit.value] : null;
};

// Opt-out intent — the "Stop" template button or a typed stop/unsubscribe.
const isStopIntent = (text) =>
  /\b(stop|unsubscribe|opt\s*out|remove me|do ?n['’]?t message|do not message)\b/i.test(String(text || ''));

const sendQuestion = (to, q) =>
  q.type === 'list'
    ? sendList(to, { body: q.body, buttonText: q.buttonText || 'Select', rows: q.items })
    : sendButtons(to, { body: q.body, buttons: q.items });

// Human-readable transcript text for what the bot actually sent, so the
// WhatsApp Inbox reads like the real chat (body + the choices the lead saw).
const questionTranscript = (q) => {
  const titles = (q.items || []).map((o) => o.title).join(' · ');
  return titles ? `${q.body}\n[ ${titles} ]` : q.body;
};

// The first-touch template's rendered body (the copy lives in Meta, not here —
// this mirrors the approved template so the transcript shows real text).
const firstTouchTranscript = (name, project) =>
  `Hi ${name || 'there'}, thanks for your interest in ${project} with Perfect Neighbourhood! 🙏\n\n` +
  'I can quickly share the latest pricing, availability and floor plans. Shall I go ahead?\n' +
  '[ Yes, share details · Stop ]';

// Carry-forward merge — never overwrite a known slot with a later null/undefined.
const mergeSlots = (target, incoming) => {
  if (!incoming) return;
  for (const [k, v] of Object.entries(incoming)) {
    if (v !== null && v !== undefined && v !== '' && k in target) target[k] = v;
  }
};

// Mirror captured slots into the lead's customFields so agents see them in the CRM.
const mirrorToCustomFields = (lead) => {
  const s = lead.wa.slots || {};
  const cf = { ...(lead.customFields || {}) };
  if (s.configuration) cf['Configuration'] = s.configuration;
  if (s.budgetLakh) cf['Budget (₹L)'] = String(s.budgetLakh);
  if (s.locationPref) cf['Location'] = s.locationPref;
  if (s.timeline) cf['Timeline'] = s.timeline;
  if (s.intent) cf['Intent'] = s.intent;
  lead.customFields = cf;
};

/* ─── Notify a human rep on handoff ───────────────────────────── */
async function notifyRep(lead, summary) {
  const title = `WhatsApp lead ready: ${lead.name}`;
  const message = `${lead.phone} — ${summary || 'qualifying answers captured'}`;
  if (lead.assignedTo) {
    createNotification({ userId: lead.assignedTo, type: 'lead.waHandoff', title, message, relatedLead: lead._id });
    return;
  }
  const admins = await User.find({ role: 'admin', isActive: true }).select('_id').lean();
  admins.forEach((a) =>
    createNotification({ userId: a._id, type: 'lead.waHandoff', title, message, relatedLead: lead._id })
  );
}

async function doHandoff(lead, trigger, summary) {
  lead.wa.stage = 'handoff';
  lead.wa.handoff = { trigger: trigger || 'qualified', summary: summary || summarize(lead), notifiedAt: new Date() };
  await sendText(lead.phone, 'Thank you! A property advisor from Perfect Neighbourhood will reach out to you shortly with the details.').catch(() => {});
  lead.wa.messages.push({ role: 'assistant', text: '[handoff — advisor will follow up]', at: new Date() });
  lead.wa.lastOutboundAt = new Date();
  await notifyRep(lead, lead.wa.handoff.summary);
}

const summarize = (lead) => {
  const s = lead.wa.slots || {};
  const parts = [];
  if (s.configuration) parts.push(s.configuration);
  if (s.budgetLakh) parts.push(`~₹${s.budgetLakh}L`);
  if (s.timeline) parts.push(s.timeline);
  if (s.intent) parts.push(s.intent);
  return parts.join(' · ') || 'engaged on WhatsApp';
};

/* ─── Phone lookup (Lead.phone is E.164 with '+'; WhatsApp omits '+') ─── */
async function findLeadByWaPhone(from) {
  const candidates = [`+${from}`, from];
  // A person may have several project-leads on the same number — attach the reply
  // to the one the bot most recently engaged (deterministic, not arbitrary).
  const order = { 'wa.lastOutboundAt': -1, createdAt: -1 };
  let lead = await Lead.findOne({ phone: { $in: candidates } }).sort(order);
  if (!lead) {
    const last10 = String(from).slice(-10);
    if (last10.length === 10) lead = await Lead.findOne({ phone: new RegExp(`${last10}$`) }).sort(order);
  }
  return lead;
}

/* ─── startConversation — the instant first-touch on live-lead creation ─── */
async function startConversation(lead) {
  if (process.env.WA_AGENT_ENABLED !== 'true' || !isConfigured()) return;
  if (!lead?.phone) return;
  if (lead.leadType === 'database') return;                    // cold bulk data — no bot
  if (!['Ads', 'Instagram'].includes(lead.source)) return;      // ad-source leads only
  if (lead.wa?.stage === 'dormant') return;                     // opted out — respect it

  // Don't message the same person twice when they have multiple project-leads.
  // If any lead on this phone already got a first-touch recently, skip — that
  // lead owns the conversation.
  const recentlyEngaged = await Lead.findOne({
    phone: lead.phone,
    _id: { $ne: lead._id },
    'wa.lastOutboundAt': { $gte: new Date(Date.now() - 12 * 60 * 60 * 1000) },
  }).select('_id').lean();
  if (recentlyEngaged) {
    console.log(`[WA] Skipped duplicate first-touch for ${lead.phone} — already engaged on lead ${recentlyEngaged._id}`);
    return;
  }

  let projectName = 'our projects';
  if (lead.project) {
    if (typeof lead.project === 'object' && lead.project.name) projectName = lead.project.name;
    else {
      const p = await Project.findById(lead.project).select('name').lean();
      if (p?.name) projectName = p.name;
    }
  }

  try {
    await sendTemplate(lead.phone, {
      name: process.env.FIRST_TOUCH_TEMPLATE || 'lead_first_touch',
      lang: process.env.TEMPLATE_LANG || 'en',
      bodyParams: [lead.name || 'there', projectName],
    });
    await Lead.updateOne(
      { _id: lead._id },
      {
        $set: { 'wa.enabled': true, 'wa.stage': 'engaging', 'wa.lastOutboundAt': new Date() },
        $push: { 'wa.messages': { role: 'assistant', text: firstTouchTranscript(lead.name, projectName), at: new Date() } },
      }
    );
    console.log(`[WA] First-touch sent to lead ${lead._id} (${lead.phone})`);
  } catch (err) {
    console.error(`[WA] startConversation failed for lead ${lead._id}:`, err.message);
  }
}

/* ─── Inbound message processing (the hybrid engine) ──────────── */

const processedIds = new Set(); // simple in-memory dedupe of WA message ids

async function processMessage(m) {
  if (!m || !m.from) return;
  if (m.id && processedIds.has(m.id)) return;
  if (m.id) { processedIds.add(m.id); if (processedIds.size > 5000) processedIds.clear(); }

  const from = m.from;
  let text = null;
  let interactiveId = null;
  let isStart = false; // tapped the first-touch template's quick-reply button
  if (m.type === 'text') text = m.text?.body || '';
  else if (m.type === 'interactive') {
    const r = m.interactive?.button_reply || m.interactive?.list_reply;
    interactiveId = r?.id || null;
    if (!text && r?.title) text = r.title;
  } else if (m.type === 'button') {
    // Quick-reply button on the approved first-touch TEMPLATE.
    text = m.button?.text || 'Start';
    isStart = true;
  } else return; // ignore other types (image/audio/etc.) for now

  const lead = await findLeadByWaPhone(from);
  if (!lead) { console.log(`[WA] Inbound from unknown number ${from} — ignored`); return; }
  if (!lead.wa) lead.wa = {};

  const now = new Date();
  lead.wa.enabled = true;
  lead.wa.lastInboundAt = now;
  lead.wa.messages = lead.wa.messages || [];
  lead.wa.messages.push({ role: 'user', text: text || `[${interactiveId || 'reply'}]`, at: now });

  // Opt-out ("Stop" template button or typed stop) — halt the bot, don't message further.
  if (isStopIntent(text)) {
    lead.wa.stage = 'dormant';
    lead.wa.enabled = false;
    await sendText(lead.phone, "Understood — we won't message you further. Reply here anytime if you change your mind.").catch(() => {});
    lead.wa.messages.push({ role: 'assistant', text: '[opted out — dormant]', at: new Date() });
    lead.wa.lastOutboundAt = new Date();
    await lead.save();
    return;
  }

  // Already handed off — just record the message; a human owns the conversation now.
  if (lead.wa.stage === 'handoff') { await lead.save(); return; }

  // Build this project's question set (configuration + budget are per-project).
  const project = lead.project
    ? await Project.findById(lead.project).select('name waConfig').lean()
    : null;
  const questions = buildQuestions(project);

  const slots = lead.wa.slots || {};

  // 1) Structured button/list answer → decode it against the pending question.
  const ans = interactiveId
    ? decodeAnswer(questionBySlot(lead.wa.pendingQuestion, questions), interactiveId, text)
    : null;
  if (ans) {
    slots[ans[0]] = ans[1];
    lead.wa.slots = slots;
  } else if (isStart) {
    // First-touch template button — just open the flow; the next question sends below.
  } else if (text) {
    // 2) Free text → light AI layer: extract slots, reply, maybe flag handoff.
    const agent = await runAgent({ history: lead.wa.messages.slice(0, -1), lastMessage: text });
    if (agent) {
      mergeSlots(slots, agent.slots);
      lead.wa.slots = slots;
      if (agent.reply) {
        await sendText(lead.phone, agent.reply).catch(() => {});
        lead.wa.messages.push({ role: 'assistant', text: agent.reply, at: new Date() });
        lead.wa.lastOutboundAt = new Date();
      }
      if (agent.handoff) {
        mirrorToCustomFields(lead);
        await doHandoff(lead, agent.handoff.trigger, agent.handoff.summary);
        await lead.save();
        return;
      }
    }
  }

  mirrorToCustomFields(lead);

  // 3) Advance the deterministic flow — ask the next unanswered question, or hand off.
  const q = nextQuestion(lead.wa.slots || {}, questions);
  if (q) {
    lead.wa.stage = 'qualifying';
    lead.wa.pendingQuestion = q.slot;
    await sendQuestion(lead.phone, q).catch(() => {});
    lead.wa.messages.push({ role: 'assistant', text: questionTranscript(q), at: new Date() });
    lead.wa.lastOutboundAt = new Date();
  } else {
    await doHandoff(lead, 'qualified', summarize(lead));
  }

  await lead.save();
}

/* ─── Route handlers ──────────────────────────────────────────── */

// GET /api/whatsapp/webhook — Meta verification handshake
exports.verifyWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
    console.log('[WA] Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.status(403).json({ message: 'Verification failed' });
};

// POST /api/whatsapp/webhook — inbound; 200 immediately, then process async
exports.handleInbound = (req, res) => {
  res.sendStatus(200);
  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const messages = change.value?.messages || [];
        for (const m of messages) {
          processMessage(m).catch((err) => console.error('[WA] processMessage error:', err.message));
        }
      }
    }
  } catch (err) {
    console.error('[WA] handleInbound error:', err.message);
  }
};

// POST /api/whatsapp/leads/:id/start — manually (re)trigger the first touch (testing)
exports.startForLead = async (req, res, next) => {
  try {
    const lead = await Lead.findById(req.params.id).populate('project', 'name');
    if (!lead) return res.status(404).json({ message: 'Lead not found' });
    await startConversation(lead);
    res.json({ message: 'First-touch triggered (if WhatsApp is configured).' });
  } catch (err) {
    next(err);
  }
};

// POST /api/whatsapp/leads/:id/reply — rep replies from the CRM (within 24h window)
exports.repReply = async (req, res, next) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ message: 'text is required' });
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ message: 'Lead not found' });
    if (!lead.phone) return res.status(400).json({ message: 'Lead has no phone' });
    // Sales agents may only reply on leads assigned to them.
    if (req.user.role === 'sales' && String(lead.assignedTo) !== String(req.user.id)) {
      return res.status(403).json({ message: 'You can only reply to your own leads' });
    }

    // 24h window guard — free-form text only within 24h of the lead's last inbound.
    const last = lead.wa?.lastInboundAt ? new Date(lead.wa.lastInboundAt).getTime() : 0;
    if (Date.now() - last > 24 * 60 * 60 * 1000) {
      return res.status(409).json({ message: 'Outside the 24-hour window — the lead must message first (or use an approved template).' });
    }

    await sendText(lead.phone, text.trim());
    lead.wa = lead.wa || {};
    lead.wa.messages = lead.wa.messages || [];
    lead.wa.messages.push({ role: 'assistant', text: text.trim(), at: new Date() });
    lead.wa.lastOutboundAt = new Date();
    await lead.save();
    res.json({ message: 'Sent' });
  } catch (err) {
    res.status(502).json({ message: `WhatsApp send failed: ${err.message}` });
  }
};

// GET /api/whatsapp/handoffs — leads awaiting a human (Inbox feed)
exports.getHandoffs = async (req, res, next) => {
  try {
    const leads = await Lead.find({ 'wa.stage': 'handoff' })
      .select('name phone status qualification wa project assignedTo customFields')
      .populate('project', 'name')
      .populate('assignedTo', 'name')
      .sort({ 'wa.handoff.notifiedAt': -1 })
      .limit(200)
      .lean();
    res.json(leads);
  } catch (err) {
    next(err);
  }
};

// Exposed for the lead-creation hook
exports.startConversation = startConversation;
