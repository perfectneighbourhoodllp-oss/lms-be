const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

/**
 * The light AI layer for the WhatsApp qualification agent. Handles FREE-TEXT
 * replies (the deterministic buttons are handled in the controller). Given the
 * conversation so far + the prospect's latest message, it extracts any slot
 * answers, writes a short on-brand reply, and flags a human handoff.
 *
 * Design notes:
 *  - Plain non-streaming messages.create — output is a small JSON object.
 *  - No assistant prefill (it 400s on newer models); we parse defensively.
 *  - Safe no-op if ANTHROPIC_API_KEY is unset (returns null → caller falls back).
 */

const MODEL = process.env.AGENT_MODEL || 'claude-haiku-4-5';

const SYSTEM_PROMPT = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'prompts', 'whatsapp_agent_system_prompt.md'), 'utf8');
  } catch {
    return 'You are a real-estate lead assistant. Reply briefly and return strict JSON {reply, slots, handoff}.';
  }
})();

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

/**
 * @param {object} args
 *   history: [{ role: 'user'|'assistant', text }]  prior conversation (chronological)
 *   lastMessage: string  the prospect's latest free-text message
 * @returns {Promise<null | { reply: string, slots: object, handoff: object|null }>}
 *   null when the AI layer isn't configured or the call fails — caller must fall back.
 */
async function runAgent({ history = [], lastMessage = '' } = {}) {
  const c = getClient();
  if (!c) return null;

  const messages = [
    ...history.slice(-12).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.text || ''),
    })),
    { role: 'user', content: String(lastMessage || '') },
  ];

  try {
    const res = await c.messages.create({
      model: MODEL,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages,
    });
    const textBlock = (res.content || []).find((b) => b.type === 'text');
    const parsed = safeParseJson(textBlock?.text);
    if (!parsed || typeof parsed.reply !== 'string') return null;
    return {
      reply: parsed.reply,
      slots: parsed.slots && typeof parsed.slots === 'object' ? parsed.slots : {},
      handoff: parsed.handoff && typeof parsed.handoff === 'object' ? parsed.handoff : null,
    };
  } catch (err) {
    console.error('[WA-AGENT] Anthropic call failed:', err.message);
    return null;
  }
}

module.exports = { runAgent, MODEL };
