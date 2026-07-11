const https = require('https');

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v19.0';
const GRAPH_HOST = 'graph.facebook.com';

/**
 * Low-level Graph API request. Returns parsed JSON, throws on Meta errors.
 * @param {'GET'|'POST'} method
 * @param {string} path   e.g. "/me/accounts" (no host, no version prefix)
 * @param {object} params query/body params (access_token included here)
 */
const graphRequest = (method, path, params = {}, version = GRAPH_VERSION) =>
  new Promise((resolve, reject) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
    ).toString();

    const isGet = method === 'GET';
    const fullPath = `/${version}${path}${isGet && qs ? `?${qs}` : ''}`;
    const body = isGet ? null : qs;

    const options = {
      hostname: GRAPH_HOST,
      path: fullPath,
      method,
      timeout: 15000,
      headers: isGet
        ? {}
        : {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
          },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(data || '{}');
        } catch {
          return reject(new Error('Failed to parse Graph API response'));
        }
        if (parsed.error) {
          const e = parsed.error;
          return reject(new Error(`Meta API error ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''}: ${e.message}`));
        }
        resolve(parsed);
      });
    });

    req.on('timeout', () => req.destroy(new Error('Graph API timed out after 15s')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });

/* ─── OAuth token exchange ─────────────────────────────────── */

/** Exchange an OAuth authorization code for a short-lived user access token. */
const exchangeCodeForToken = async (code) => {
  const res = await graphRequest('GET', '/oauth/access_token', {
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    redirect_uri: process.env.META_OAUTH_REDIRECT_URI,
    code,
  });
  return res.access_token;
};

/** Upgrade a short-lived user token to a long-lived (~60-day) user token. */
const getLongLivedUserToken = async (shortToken) => {
  const res = await graphRequest('GET', '/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    fb_exchange_token: shortToken,
  });
  return res.access_token;
};

/**
 * List the Pages the user manages. Each page includes its own PAGE access token
 * (long-lived, non-expiring when derived from a long-lived user token).
 * Returns [{ id, name, access_token, tasks, instagram_business_account }].
 */
const getUserPages = async (userToken) => {
  const all = [];
  let after;
  do {
    const res = await graphRequest('GET', '/me/accounts', {
      access_token: userToken,
      fields: 'id,name,access_token,tasks,instagram_business_account',
      limit: 100,
      after,
    });
    all.push(...(res.data || []));
    after = res.paging?.cursors?.after && res.paging?.next ? res.paging.cursors.after : undefined;
  } while (after);
  return all;
};

/** Subscribe a Page to this app's webhook for the `leadgen` field. */
const subscribePageToLeadgen = (pageId, pageToken) =>
  graphRequest('POST', `/${pageId}/subscribed_apps`, {
    subscribed_fields: 'leadgen',
    access_token: pageToken,
  });

/** Remove this app's webhook subscription from a Page. */
const unsubscribePage = (pageId, pageToken) =>
  new Promise((resolve, reject) => {
    // DELETE via method override on the subscribed_apps edge
    graphRequest('POST', `/${pageId}/subscribed_apps`, {
      access_token: pageToken,
      method: 'delete',
    }).then(resolve).catch(reject);
  });

/** List ALL lead forms on a Page (paginated) — for the form→project mapping UI. */
const getPageLeadForms = async (pageId, pageToken) => {
  const all = [];
  let after;
  do {
    const res = await graphRequest('GET', `/${pageId}/leadgen_forms`, {
      access_token: pageToken,
      fields: 'id,name,status',
      limit: 100,
      after,
    });
    all.push(...(res.data || []));
    after = res.paging?.next ? res.paging?.cursors?.after : undefined;
  } while (after);
  return all;
};

/** Fetch a single lead's full field data by leadgen id. */
const getLead = (leadgenId, token) =>
  graphRequest('GET', `/${leadgenId}`, {
    access_token: token,
    fields: 'field_data,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id',
  });

module.exports = {
  GRAPH_VERSION,
  graphRequest,
  exchangeCodeForToken,
  getLongLivedUserToken,
  getUserPages,
  subscribePageToLeadgen,
  unsubscribePage,
  getPageLeadForms,
  getLead,
};
