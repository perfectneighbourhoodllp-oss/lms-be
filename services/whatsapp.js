const https = require('https');

/**
 * The ONLY module that talks to Meta's WhatsApp Cloud API.
 * POSTs JSON to graph.facebook.com/{version}/{PHONE_NUMBER_ID}/messages with a
 * Bearer token — a different shape from the Lead-Ads Graph helper (utils/metaGraph),
 * which is form-encoded, so WhatsApp gets its own sender here.
 */

const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v21.0';

/** WhatsApp addresses use no leading '+' — our Lead.phone is E.164 with '+'. */
const waPhone = (p) => String(p || '').replace(/\D/g, '');

/** True when the number id + access token are set (for graceful no-ops). */
const isConfigured = () =>
  Boolean(process.env.WA_PHONE_NUMBER_ID && process.env.WA_ACCESS_TOKEN);

function postMessage(payload) {
  return new Promise((resolve, reject) => {
    const token = process.env.WA_ACCESS_TOKEN;
    const phoneId = process.env.WA_PHONE_NUMBER_ID;
    if (!token || !phoneId) {
      return reject(new Error('WhatsApp not configured (WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN)'));
    }
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: 'graph.facebook.com',
        path: `/${GRAPH_VERSION}/${phoneId}/messages`,
        method: 'POST',
        timeout: 15000,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data || '{}'); } catch { return reject(new Error('WhatsApp: unparseable response')); }
          if (parsed.error) {
            return reject(new Error(`WhatsApp API ${parsed.error.code}: ${parsed.error.message}`));
          }
          resolve(parsed); // { messages: [{ id }] , contacts: [...] }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('WhatsApp API timed out after 15s')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Send an approved TEMPLATE (business-initiated — required for the first touch
 * before a 24h window exists). `bodyParams` fill the template's {{1}}, {{2}}…
 */
function sendTemplate(to, { name, lang, bodyParams = [] } = {}) {
  const components = [];
  if (bodyParams.length) {
    components.push({
      type: 'body',
      parameters: bodyParams.map((t) => ({ type: 'text', text: String(t) })),
    });
  }
  return postMessage({
    messaging_product: 'whatsapp',
    to: waPhone(to),
    type: 'template',
    template: {
      name: name || process.env.FIRST_TOUCH_TEMPLATE || 'lead_first_touch',
      language: { code: lang || process.env.TEMPLATE_LANG || 'en' },
      components,
    },
  });
}

/** Free-form text — valid ONLY inside the 24h customer-service window. */
function sendText(to, body) {
  return postMessage({
    messaging_product: 'whatsapp',
    to: waPhone(to),
    type: 'text',
    text: { body: String(body).slice(0, 4096), preview_url: false },
  });
}

/** Interactive reply buttons (max 3). buttons: [{ id, title }]. */
function sendButtons(to, { body, buttons }) {
  return postMessage({
    messaging_product: 'whatsapp',
    to: waPhone(to),
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: String(body).slice(0, 1024) },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: String(b.title).slice(0, 20) },
        })),
      },
    },
  });
}

/** Interactive single-select list. rows: [{ id, title, description? }]. */
function sendList(to, { body, buttonText = 'Choose', rows }) {
  return postMessage({
    messaging_product: 'whatsapp',
    to: waPhone(to),
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: String(body).slice(0, 1024) },
      action: {
        button: String(buttonText).slice(0, 20),
        sections: [{
          rows: rows.slice(0, 10).map((r) => ({
            id: r.id,
            title: String(r.title).slice(0, 24),
            description: r.description ? String(r.description).slice(0, 72) : undefined,
          })),
        }],
      },
    },
  });
}

module.exports = { GRAPH_VERSION, waPhone, isConfigured, sendTemplate, sendText, sendButtons, sendList };
