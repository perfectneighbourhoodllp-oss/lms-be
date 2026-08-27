const Anthropic = require('@anthropic-ai/sdk');
const Lead = require('../models/Lead');
const User = require('../models/User');
const Project = require('../models/Project');
const { computeAgentReport, parseRange } = require('../controllers/reportController');
const { getManagerLeadFilter } = require('../utils/managerScope');

/**
 * In-app admin AI assistant + per-lead "Next Best Action".
 *
 * Two read-only surfaces, both on Claude Sonnet:
 *   • suggestNextAction(lead)     — one call, returns { action, reasoning, urgency }
 *   • askAssistant({ question })  — a tool-use loop over read-only CRM tools
 *
 * Everything is READ-ONLY: the tools only query the DB, nothing is mutated.
 * Reuses the existing ANTHROPIC_API_KEY (same as the WhatsApp agent). Safe no-op
 * if the key is unset — callers get a clear "not configured" error.
 */

const MODEL = process.env.ASSISTANT_MODEL || 'claude-sonnet-5';

let client = null;
const getClient = () => {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY
  return client;
};

// Pull the first {...} JSON object out of the model's text, tolerating stray prose.
const safeParseJson = (text) => {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
};

const daysAgo = (d) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null);
const fmtDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

// ───────────────────────── Next Best Action ─────────────────────────

/**
 * Compact, human-readable snapshot of one lead for the model.
 * `lead` should be a populated Mongoose doc (project + assignedTo names).
 */
function leadSnapshot(lead) {
  const wa = lead.wa || {};
  const slots = wa.slots || {};
  const calls = (lead.contactLog || []).filter((c) => c.type === 'call').length;
  const wapp = (lead.contactLog || []).filter((c) => c.type === 'whatsapp').length;
  const recentRemarks = (lead.remarks || [])
    .slice(-5)
    .map((r) => `• ${fmtDate(r.createdAt)}: ${r.text}`)
    .join('\n');
  const visits = (lead.siteVisits || [])
    .map((v) => `• ${fmtDate(v.at)}${v.feedback ? ` — ${v.feedback}` : ''}`)
    .join('\n');

  return [
    `Name: ${lead.name}`,
    `Status: ${lead.status}`,
    `Source: ${lead.source}`,
    `Lead type: ${lead.leadType}`,
    lead.project ? `Project: ${lead.project.name || lead.project}` : 'Project: (none assigned)',
    lead.assignedTo ? `Assigned to: ${lead.assignedTo.name || lead.assignedTo}` : 'Assigned to: (unassigned)',
    lead.qualification ? `Qualification: ${lead.qualification}` : null,
    (lead.tags || []).length ? `Tags: ${lead.tags.join(', ')}` : null,
    `Created: ${fmtDate(lead.createdAt)} (${daysAgo(lead.createdAt)}d ago)`,
    lead.lastContactedAt
      ? `Last contacted: ${fmtDate(lead.lastContactedAt)} (${daysAgo(lead.lastContactedAt)}d ago)`
      : 'Last contacted: never',
    `Contact attempts: ${calls} call(s), ${wapp} WhatsApp`,
    lead.followUpDate
      ? `Next follow-up: ${fmtDate(lead.followUpDate)}${new Date(lead.followUpDate) < new Date() ? ' (OVERDUE)' : ''}`
      : 'Next follow-up: none scheduled',
    (lead.siteVisits || []).length ? `Site visits:\n${visits}` : 'Site visits: none',
    slots.configuration ? `Wants config: ${slots.configuration}` : null,
    slots.budgetLakh ? `Budget: ₹${slots.budgetLakh} lakh` : null,
    slots.locationPref ? `Location pref: ${slots.locationPref}` : null,
    slots.timeline ? `Timeline: ${slots.timeline}` : null,
    slots.intent ? `Intent: ${slots.intent}` : null,
    lead.notes ? `Notes: ${lead.notes}` : null,
    recentRemarks ? `Recent remarks:\n${recentRemarks}` : 'Recent remarks: none',
  ]
    .filter(Boolean)
    .join('\n');
}

// Shared "sound like a real person" spec, injected into both drafting prompts.
// The default AI style (emoji on every line, em-dashes, quote-wrapped, clever
// hooks, marketing clichés) reads as fake and hurts response rates.
const HUMAN_VOICE = `HUMAN VOICE — every drafted message must read like a real person texting, not AI:
- Plain, casual, and short (usually 1-3 lines) — the way an actual Indian real-estate agent texts on WhatsApp.
- Use the lead's first name naturally. Light Hinglish is fine where it fits ("thoda", "ok na", "batayein").
- Do NOT sound AI-generated. Specifically avoid: emoji on every line (use at most ONE, and often none); em-dashes (—); wrapping the message in quotation marks; gimmicky "reverse-psychology" or clever hooks and labels; and marketing clichés like "no strings attached", "no pressure either way", "whatever it is I'll respect it", or "The One".
- Vary the wording, length, and opening across leads so the messages never look mass-produced or templated.
- Read like a busy human who just wants a quick reply — not a polished campaign. A little plainness is good; it's more believable.`;

const NBA_SYSTEM = `You are a sales coach for a real-estate CRM. Given one lead's full context, recommend the single best next action the assigned agent should take to move this lead forward.

Be specific and practical for Indian real-estate sales (calls, WhatsApp, site visits, follow-ups, requalifying budget/config, or marking dead when appropriate). Base your advice ONLY on the context given — do not invent facts.

NON-RESPONSIVE LEADS (RNR / DNP / going cold): If the lead is Ringing-No-Response or Did-Not-Pick — signalled by status RNR/Called, several call attempts with no reply, WhatsApp opted-out/dormant, or a long gap since last contact — do NOT just say "call again". Recommend a CREATIVE, low-pressure re-engagement move and vary it from what's already been tried. Draw from tactics like:
- A WhatsApp text (often read even when calls are ignored) with a short value hook — new price/offer, limited units, a fresh site photo or video, or a walkthrough link.
- A "pattern interrupt": call from a different time-of-day or day (evening/weekend), a missed-call + WhatsApp combo, or a brief voice note.
- A soft, curiosity-led message ("Should I close your file, or are you still exploring?" / "One quick update on <project>…") that invites a yes/no reply.
- A reason to re-engage: price revision, new inventory/config, EMI or offer, an upcoming site-visit slot or open-house.
- Route via a warmer channel if known (referrer, family member, alternate number in notes).
- After genuinely exhausted attempts with zero engagement, recommend spacing out (a scheduled nudge in a few days) or marking dead — with a clear last-touch message first.
Keep it respectful and non-spammy. Put the concrete move in "action".

The "message" field: whenever the next action is to send a WhatsApp/SMS to the lead (especially for RNR/DNP/cold leads), put a ready-to-send, personalised message there — just the text the agent would send, no quotes, no labels, no commentary. When a message is NOT the right move (e.g. schedule a site visit, requalify internally, log a call), set "message" to an empty string.

${HUMAN_VOICE}

Respond with ONLY a JSON object, no other text:
{"action": "<one clear next action, imperative, max ~20 words>", "reasoning": "<2-3 sentences why, referencing the lead's specifics>", "message": "<ready-to-send WhatsApp text for the lead, or empty string>", "urgency": "high" | "medium" | "low"}`;

/**
 * @param {object} lead  populated Lead doc
 * @returns {Promise<{action,reasoning,urgency}>}
 * @throws  Error('AI assistant is not configured') when no API key
 */
async function suggestNextAction(lead) {
  const c = getClient();
  if (!c) throw new Error('AI assistant is not configured (missing ANTHROPIC_API_KEY).');

  const res = await c.messages.create({
    model: MODEL,
    // On Sonnet, thinking shares the max_tokens budget. This is a light, scoped
    // task, so keep effort low (shallow thinking) and give generous headroom —
    // together that makes truncating the JSON (→ "unexpected response") very
    // unlikely, and it's cheaper/faster than deep thinking.
    max_tokens: 900,
    output_config: { effort: 'low' },
    system: NBA_SYSTEM,
    messages: [{ role: 'user', content: `Lead context:\n\n${leadSnapshot(lead)}` }],
  });
  const textBlock = (res.content || []).find((b) => b.type === 'text');
  const parsed = safeParseJson(textBlock?.text);
  if (!parsed || typeof parsed.action !== 'string') {
    // Distinguish a safety refusal (empty content) from a malformed reply.
    if (res.stop_reason === 'refusal') {
      throw new Error('The AI declined to answer for this lead. Please try again or review manually.');
    }
    throw new Error('AI returned an unexpected response. Please try again.');
  }
  const urgency = ['high', 'medium', 'low'].includes(parsed.urgency) ? parsed.urgency : 'medium';
  return {
    action: parsed.action,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    message: typeof parsed.message === 'string' ? parsed.message.trim() : '',
    urgency,
  };
}

// ───────────────────────── Chat assistant (tool use) ─────────────────────────

const leadBrief = (l) => ({
  id: String(l._id),
  name: l.name,
  phone: l.phone,
  status: l.status,
  source: l.source,
  leadType: l.leadType,
  project: l.project ? l.project.name || String(l.project) : null,
  assignedTo: l.assignedTo ? l.assignedTo.name || String(l.assignedTo) : null,
  followUpDate: fmtDate(l.followUpDate),
  lastContactedAt: fmtDate(l.lastContactedAt),
  createdAt: fmtDate(l.createdAt),
});

// Resolve a project/agent NAME (or id) to an _id, for filter tools.
async function resolveProjectId(nameOrId) {
  if (!nameOrId) return null;
  const p = await Project.findOne({
    $or: [{ name: new RegExp(`^${escapeRegex(nameOrId)}`, 'i') }, ...(isObjectId(nameOrId) ? [{ _id: nameOrId }] : [])],
  }).select('_id');
  return p?._id || null;
}
async function resolveAgentId(nameOrId) {
  if (!nameOrId) return null;
  const u = await User.findOne({
    $or: [{ name: new RegExp(escapeRegex(nameOrId), 'i') }, ...(isObjectId(nameOrId) ? [{ _id: nameOrId }] : [])],
  }).select('_id');
  return u?._id || null;
}
const isObjectId = (s) => /^[a-f\d]{24}$/i.test(String(s || ''));
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const TOOLS = [
  {
    name: 'list_leads',
    description:
      'List leads matching optional filters. Returns compact rows (max 40). Filter by status, source, project name, assigned agent name, or leadType (live/database).',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'e.g. "Follow Up", "Interested", "Site Visit"' },
        source: { type: 'string' },
        project: { type: 'string', description: 'project name (partial ok)' },
        assignedTo: { type: 'string', description: 'agent name (partial ok)' },
        leadType: { type: 'string', enum: ['live', 'database'] },
        unassigned: { type: 'boolean', description: 'true → only leads with no agent' },
        limit: { type: 'integer', description: 'max rows, default 25, cap 40' },
      },
    },
  },
  {
    name: 'search_leads',
    description: 'Free-text search leads by name, phone, email, or notes. Returns up to 25 compact rows.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'get_lead',
    description: 'Get full detail for one lead by id or phone: status, project, agent, remarks, contact history, site visits, WhatsApp answers.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' }, phone: { type: 'string' } },
    },
  },
  {
    name: 'lead_stats',
    description: 'Aggregate counts across all leads: total, by status, by source, unassigned count, overdue follow-ups.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'today_followups',
    description: 'Leads whose follow-up is scheduled for today.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'overdue_leads',
    description: 'Open leads whose follow-up date is in the past (overdue). Up to 40 rows.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cold_leads',
    description:
      'Open leads that have gone cold / non-responsive: status RNR, or not contacted in the last N days (default 7). Sorted stalest first. Use this to draft re-engagement messages. Optionally filter by assigned agent name. Returns up to 40 rows with days-since-contact.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'silence threshold in days, default 7' },
        assignedTo: { type: 'string', description: 'agent name (partial ok)' },
        limit: { type: 'integer', description: 'max rows, default 10, cap 40' },
      },
    },
  },
  {
    name: 'list_projects',
    description: 'All projects with their assigned agent count and lead count.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_agents',
    description: 'All sales agents & managers with role, active status, and current lead count.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'agent_report',
    description:
      'Per-agent performance report (calls made, follow-ups, site visits, etc.) for a period: today, yesterday, last7, or last30.',
    input_schema: {
      type: 'object',
      properties: { period: { type: 'string', enum: ['today', 'yesterday', 'last7', 'last30'] } },
    },
  },
];

const OPEN_STATUSES = ['New', 'Called', 'RNR', 'Follow Up', 'Interested', 'Webinar', 'Site Visit', 'Cross Selling', 'Future Prospects'];
// Cold-outreach sweep excludes intentionally-parked "Future Prospects".
const COLD_STATUSES = OPEN_STATUSES.filter((s) => s !== 'Future Prospects');

// Convert a period keyword to {start,end} using reportController.parseRange semantics.
function periodRange(period) {
  const now = new Date();
  const dayMs = 86400000;
  const iso = (d) => d.toISOString().slice(0, 10);
  if (period === 'yesterday') {
    const y = new Date(now.getTime() - dayMs);
    return parseRange(iso(y), iso(y));
  }
  if (period === 'last7') return parseRange(iso(new Date(now.getTime() - 6 * dayMs)), iso(now));
  if (period === 'last30') return parseRange(iso(new Date(now.getTime() - 29 * dayMs)), iso(now));
  return parseRange(iso(now), iso(now)); // today
}

// Combine a role-based lead-visibility filter with a per-tool filter, safely
// (avoids key collisions like two `assignedTo` clauses overwriting each other).
const withScope = (scope, filter) =>
  scope && Object.keys(scope).length ? { $and: [scope, filter] } : filter;

/**
 * Mongoose filter limiting Lead queries to what THIS user may see:
 *   admin   → {}                       (all leads)
 *   manager → their managed projects + team + own leads (getManagerLeadFilter)
 *   sales   → only leads assigned to them
 */
async function buildLeadScope(user) {
  if (!user || user.role === 'admin') return {};
  if (user.role === 'manager') return getManagerLeadFilter(user);
  return { assignedTo: user.id }; // sales
}

// Tools that reveal data across the whole org (every agent / project / report)
// are admin-only. Managers and sales get the lead tools, scoped to their leads.
const ADMIN_ONLY_TOOLS = new Set(['list_projects', 'list_agents', 'agent_report']);
const toolsForRole = (role) =>
  role === 'admin' ? TOOLS : TOOLS.filter((t) => !ADMIN_ONLY_TOOLS.has(t.name));

async function runTool(name, input, scope = {}) {
  switch (name) {
    case 'list_leads': {
      const q = {};
      if (input.status) q.status = input.status;
      if (input.source) q.source = input.source;
      if (input.leadType) q.leadType = input.leadType;
      if (input.unassigned) q.assignedTo = { $exists: false };
      if (input.project) {
        const pid = await resolveProjectId(input.project);
        if (!pid) return { note: `No project matching "${input.project}".`, leads: [] };
        q.project = pid;
      }
      if (input.assignedTo) {
        const aid = await resolveAgentId(input.assignedTo);
        if (!aid) return { note: `No agent matching "${input.assignedTo}".`, leads: [] };
        q.assignedTo = aid;
      }
      const limit = Math.min(input.limit || 25, 40);
      const leads = await Lead.find(withScope(scope, q))
        .sort({ updatedAt: -1 })
        .limit(limit)
        .populate('project', 'name')
        .populate('assignedTo', 'name')
        .lean();
      return { count: leads.length, leads: leads.map(leadBrief) };
    }
    case 'search_leads': {
      const rx = new RegExp(escapeRegex(input.query), 'i');
      const leads = await Lead.find(withScope(scope, { $or: [{ name: rx }, { phone: rx }, { email: rx }, { notes: rx }] }))
        .sort({ updatedAt: -1 })
        .limit(25)
        .populate('project', 'name')
        .populate('assignedTo', 'name')
        .lean();
      return { count: leads.length, leads: leads.map(leadBrief) };
    }
    case 'get_lead': {
      const filter = input.id && isObjectId(input.id) ? { _id: input.id } : input.phone ? { phone: new RegExp(escapeRegex(input.phone)) } : null;
      if (!filter) return { error: 'Provide a valid lead id or phone.' };
      const lead = await Lead.findOne(withScope(scope, filter))
        .populate('project', 'name')
        .populate('assignedTo', 'name');
      if (!lead) return { error: 'Lead not found (or not in your leads).' };
      return { detail: leadSnapshot(lead), id: String(lead._id), phone: lead.phone };
    }
    case 'lead_stats': {
      const [total, byStatus, bySource, unassigned, overdue] = await Promise.all([
        Lead.countDocuments(withScope(scope, {})),
        Lead.aggregate([{ $match: scope || {} }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
        Lead.aggregate([{ $match: scope || {} }, { $group: { _id: '$source', n: { $sum: 1 } } }]),
        Lead.countDocuments(withScope(scope, { assignedTo: { $exists: false } })),
        Lead.countDocuments(withScope(scope, { status: { $in: OPEN_STATUSES }, followUpDate: { $lt: new Date() } })),
      ]);
      const toMap = (arr) => Object.fromEntries(arr.map((x) => [x._id || '(none)', x.n]));
      return { total, byStatus: toMap(byStatus), bySource: toMap(bySource), unassigned, overdueFollowups: overdue };
    }
    case 'today_followups': {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      const leads = await Lead.find(withScope(scope, { followUpDate: { $gte: start, $lte: end } }))
        .sort({ followUpDate: 1 })
        .limit(40)
        .populate('project', 'name')
        .populate('assignedTo', 'name')
        .lean();
      return { count: leads.length, leads: leads.map(leadBrief) };
    }
    case 'overdue_leads': {
      const leads = await Lead.find(withScope(scope, { status: { $in: OPEN_STATUSES }, followUpDate: { $lt: new Date() } }))
        .sort({ followUpDate: 1 })
        .limit(40)
        .populate('project', 'name')
        .populate('assignedTo', 'name')
        .lean();
      return { count: leads.length, leads: leads.map(leadBrief) };
    }
    case 'cold_leads': {
      const days = Number.isFinite(input.days) && input.days > 0 ? input.days : 7;
      const cutoff = new Date(Date.now() - days * 86400000);
      const q = {
        status: { $in: COLD_STATUSES },
        // Cold = explicitly RNR, OR gone quiet for `days` (never contacted counts).
        $or: [{ status: 'RNR' }, { lastContactedAt: { $lt: cutoff } }, { lastContactedAt: { $exists: false } }],
      };
      if (input.assignedTo) {
        const aid = await resolveAgentId(input.assignedTo);
        if (!aid) return { note: `No agent matching "${input.assignedTo}".`, leads: [] };
        q.assignedTo = aid;
      }
      const limit = Math.min(input.limit || 10, 40);
      const leads = await Lead.find(withScope(scope, q))
        .sort({ lastContactedAt: 1, createdAt: 1 }) // stalest first (nulls sort first)
        .limit(limit)
        .populate('project', 'name')
        .populate('assignedTo', 'name')
        .lean();
      const rows = leads.map((l) => ({
        ...leadBrief(l),
        callAttempts: (l.contactLog || []).filter((c) => c.type === 'call').length,
        daysSinceContact: daysAgo(l.lastContactedAt),
        wantsConfig: l.wa?.slots?.configuration || null,
        budgetLakh: l.wa?.slots?.budgetLakh || null,
      }));
      return { count: rows.length, silenceThresholdDays: days, leads: rows };
    }
    case 'list_projects': {
      const projects = await Project.find({}).select('name assignedAgents isActive').lean();
      const withCounts = await Promise.all(
        projects.map(async (p) => ({
          name: p.name,
          active: p.isActive,
          agents: (p.assignedAgents || []).length,
          leads: await Lead.countDocuments({ project: p._id }),
        }))
      );
      return { count: withCounts.length, projects: withCounts };
    }
    case 'list_agents': {
      const users = await User.find({ role: { $in: ['sales', 'manager'] } }).select('name role isActive').lean();
      const withCounts = await Promise.all(
        users.map(async (u) => ({
          name: u.name,
          role: u.role,
          active: u.isActive,
          leads: await Lead.countDocuments({ assignedTo: u._id }),
        }))
      );
      return { count: withCounts.length, agents: withCounts };
    }
    case 'agent_report': {
      const { start, end } = periodRange(input.period || 'today');
      const report = await computeAgentReport(start, end);
      return report;
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

const ASSISTANT_SYSTEM = `You are the in-app AI assistant for "PNH Lead MS", a real-estate lead-management CRM. Answer the user's questions about their leads, pipeline, and follow-ups using the provided read-only tools.

Guidelines:
- Use tools to fetch real data before answering; never invent numbers or names.
- Answers render as GitHub-flavored markdown, so use it: **bold** for names/labels, bullet or numbered lists, blockquotes for message drafts, and tables ONLY for genuinely tabular numeric data with a few short columns. Answers are often read on a phone, so prefer vertical lists over wide multi-column tables (a 3-column "message" table is hard to read on mobile).
- Currency is Indian Rupees; budgets are often in lakhs/crores. All data is real production CRM data — be accurate.
- You are strictly read-only: you can look things up and advise, but you cannot change anything. If asked to modify data, explain that you can only read and suggest, and tell the user where in the app to make the change.
- The tools already return only the leads THIS user is allowed to see. Never claim to cover leads outside that scope, and don't speculate about other agents' or teams' data you can't fetch.
- Keep answers focused and brief; lead with the answer, then supporting detail.

Re-engaging cold / non-responsive leads: When asked to help win back cold, RNR, or non-responsive leads (e.g. "draft re-engagement messages for my top 10 cold leads"), use the cold_leads tool to pull them, then for each lead draft a short, ready-to-send WhatsApp message personalised with what you know (name, project, wanted config/budget, how long they've been quiet). Vary the angle across leads — a value hook (new price/offer, limited units, fresh photo/site-visit slot), a curiosity nudge ("Should I close your file, or are you still exploring?"), or a pattern interrupt (different time/day, voice note). Keep each message warm, respectful, and non-spammy (2-4 short lines). Format each lead as a vertical markdown entry (NOT a wide table), like:

**Lead name** _(agent)_ — one-line angle
> the ready-to-send message

For genuinely exhausted leads, suggest a final last-touch message before marking dead.

${HUMAN_VOICE}`;

// Per-request note telling the model exactly whose data it can see.
function scopeNote(user) {
  if (!user || user.role === 'admin') {
    return 'Access: ADMIN — you can see all leads, agents, projects, and reports across the whole company.';
  }
  if (user.role === 'manager') {
    return `Access: MANAGER (${user.name || 'manager'}) — you can see leads in your managed projects, your team's leads, and your own. You cannot see other teams' leads, and org-wide agent/project/report tools are not available to you.`;
  }
  return `Access: SALES AGENT (${user.name || 'agent'}) — you can ONLY see leads assigned to you. Every tool is limited to your own leads.`;
}

// Trim a stored answer before feeding it back as conversation memory, so a
// huge prior answer (e.g. "draft 10 messages") doesn't bloat later requests.
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Run the chat assistant to completion (manual tool-use loop), scoped to the
 * caller's role: admin sees everything; manager sees their scope; sales sees
 * only their own leads.
 *
 * Streams the model's text as it's generated: pass `onText(delta)` to receive
 * chunks live (the controller pipes these to the client over SSE). Without
 * `onText` it simply accumulates and returns the full answer.
 *
 * @param {object} args { question, user, history, onText? }
 * @returns {Promise<{ answer: string, usage: {input,output,cacheRead,cacheCreate} }>}
 * @throws Error('AI assistant is not configured') when no API key
 */
async function askAssistant({ question, user, history = [], onText } = {}) {
  const c = getClient();
  if (!c) throw new Error('AI assistant is not configured (missing ANTHROPIC_API_KEY).');
  if (!question || !String(question).trim()) throw new Error('Question is required.');

  const scope = await buildLeadScope(user);
  const tools = toolsForRole(user?.role);
  // Prompt caching: the tool definitions + base system prompt are identical on
  // every turn (and across users of the same role), so we cache that prefix and
  // pay ~0.1x for it on reuse. The cache_control breakpoint on the FIRST system
  // block covers everything before it in render order (tools → system), so the
  // ~2.4k-token prefix is cached. The per-user scope note sits AFTER the
  // breakpoint (a second, uncached block) so it never invalidates the cache.
  const system = [
    { type: 'text', text: ASSISTANT_SYSTEM, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: scopeNote(user) },
  ];

  // Conversation memory: replay the recent exchanges (question + answer text)
  // so follow-ups like "and their phone numbers?" resolve. Only completed
  // exchanges are passed in by the caller; prior answers are clipped.
  const priorTurns = [];
  for (const h of history) {
    if (h?.question) priorTurns.push({ role: 'user', content: String(h.question) });
    if (h?.answer) priorTurns.push({ role: 'assistant', content: clip(String(h.answer), 1500) });
  }

  const messages = [...priorTurns, { role: 'user', content: String(question).trim() }];
  const MAX_TURNS = 8;
  let answer = '';
  const usage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const stream = c.messages.stream({
      model: MODEL,
      // Room for both adaptive thinking AND a long answer (e.g. drafting 10
      // re-engagement messages) — on Sonnet the two share this budget.
      max_tokens: 4096,
      // Medium effort: shallower thinking than the default (high) — cheaper and
      // faster, with negligible quality loss for lookups/drafting.
      output_config: { effort: 'medium' },
      system,
      tools,
      messages,
    });

    // Stream text deltas live (thinking deltas are ignored — never shown).
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const t = event.delta.text || '';
        answer += t;
        if (onText) onText(t);
      }
    }

    const msg = await stream.finalMessage();
    const u = msg.usage || {};
    usage.input += u.input_tokens || 0;
    usage.output += u.output_tokens || 0;
    usage.cacheRead += u.cache_read_input_tokens || 0;
    usage.cacheCreate += u.cache_creation_input_tokens || 0;

    if (msg.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: msg.content });
      const toolResults = [];
      for (const block of msg.content) {
        if (block.type !== 'tool_use') continue;
        let result;
        try {
          // Guard: never run an admin-only tool for a non-admin, even if the
          // model somehow requests one.
          if (ADMIN_ONLY_TOOLS.has(block.name) && user?.role !== 'admin') {
            result = { error: 'Not available for your role.' };
          } else {
            result = await runTool(block.name, block.input || {}, scope);
          }
        } catch (err) {
          result = { error: err.message };
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Final answer (already streamed as it was generated).
    return { answer: answer.trim() || 'No answer produced.', usage };
  }

  return {
    answer: answer.trim() || 'I gathered a lot of data but ran out of steps — please narrow the question.',
    usage,
  };
}

module.exports = { suggestNextAction, askAssistant, MODEL };
