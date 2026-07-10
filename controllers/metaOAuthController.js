const jwt = require('jsonwebtoken');
const MetaPage = require('../models/MetaPage');
const Project = require('../models/Project');
const { encrypt, decrypt, isConfigured } = require('../utils/tokenCrypto');
const {
  exchangeCodeForToken,
  getLongLivedUserToken,
  getUserPages,
  subscribePageToLeadgen,
  unsubscribePage,
  getPageLeadForms,
} = require('../utils/metaGraph');
const logActivity = require('../utils/logActivity');

// Requested OAuth permissions. Override with META_OAUTH_SCOPES (comma-separated)
// to trim the set while testing — e.g. before your app has advanced access to
// pages_manage_metadata / business_management.
const DEFAULT_SCOPES = [
  'pages_show_list',
  'pages_manage_metadata',
  'pages_read_engagement',
  'leads_retrieval',
  'business_management',
];
const OAUTH_SCOPES = (process.env.META_OAUTH_SCOPES
  ? process.env.META_OAUTH_SCOPES.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_SCOPES
).join(',');

const clientUrl = () => (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '');

/** Redirect the browser back to the CRM's Meta settings page with a status flag. */
const backToApp = (res, params) => {
  const qs = new URLSearchParams(params).toString();
  return res.redirect(`${clientUrl()}/meta-webhook?${qs}`);
};

/* ─── Step 1: start the OAuth flow ────────────────────────────── */

/**
 * GET /api/meta/oauth/connect  (admin, JWT-protected)
 * Returns the Facebook OAuth dialog URL. The frontend then does
 * window.location = url. `state` is a signed, short-lived token so the public
 * callback can verify the request originated from us (CSRF protection).
 */
exports.getConnectUrl = (req, res) => {
  if (!process.env.META_APP_ID || !process.env.META_OAUTH_REDIRECT_URI) {
    return res.status(500).json({ message: 'Meta OAuth is not configured (META_APP_ID / META_OAUTH_REDIRECT_URI missing).' });
  }
  if (!isConfigured()) {
    return res.status(500).json({ message: 'TOKEN_ENC_KEY is not configured — cannot store Page tokens securely.' });
  }

  const state = jwt.sign({ uid: req.user.id, purpose: 'meta_oauth' }, process.env.JWT_SECRET, { expiresIn: '10m' });

  const url =
    `https://www.facebook.com/${process.env.META_GRAPH_VERSION || 'v19.0'}/dialog/oauth?` +
    new URLSearchParams({
      client_id: process.env.META_APP_ID,
      redirect_uri: process.env.META_OAUTH_REDIRECT_URI,
      scope: OAUTH_SCOPES,
      response_type: 'code',
      state,
    }).toString();

  res.json({ url });
};

/* ─── Step 2: OAuth callback ──────────────────────────────────── */

/**
 * GET /api/meta/oauth/callback  (public — Meta redirects the browser here)
 * Verifies `state`, exchanges the code for a long-lived user token, fetches the
 * user's Pages (each with its own Page token), and upserts them as 'pending'.
 * Redirects back to the CRM UI.
 */
exports.oauthCallback = async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return backToApp(res, { meta_error: error_description || error });
  }
  if (!code || !state) {
    return backToApp(res, { meta_error: 'Missing authorization code' });
  }

  let decoded;
  try {
    decoded = jwt.verify(state, process.env.JWT_SECRET);
    if (decoded.purpose !== 'meta_oauth') throw new Error('bad purpose');
  } catch {
    return backToApp(res, { meta_error: 'Invalid or expired session. Please try connecting again.' });
  }

  try {
    const shortToken = await exchangeCodeForToken(code);
    const longToken = await getLongLivedUserToken(shortToken);
    const pages = await getUserPages(longToken);

    if (!pages.length) {
      return backToApp(res, { meta_error: 'No Pages found. Make sure you manage a Page and (before App Review) are an app Admin/Developer/Tester.' });
    }

    let connected = 0;
    for (const p of pages) {
      if (!p.access_token) continue; // need MANAGE task; skip pages without a token
      await MetaPage.findOneAndUpdate(
        { pageId: p.id },
        {
          $set: {
            name: p.name || '',
            encToken: encrypt(p.access_token),
            igBusinessId: p.instagram_business_account?.id || '',
            connectedBy: decoded.uid,
            lastError: '',
          },
          // Don't clobber an already-active subscription/default project on reconnect
          $setOnInsert: { status: 'pending' },
        },
        { upsert: true, new: true }
      );
      connected += 1;
    }

    return backToApp(res, { meta_connected: String(connected) });
  } catch (err) {
    console.error('[META OAUTH] Callback failed:', err.message);
    return backToApp(res, { meta_error: err.message });
  }
};

/* ─── Status + page management (JWT-protected) ────────────────── */

/** GET /api/meta/status — connection summary for the settings screen. */
exports.getStatus = async (req, res, next) => {
  try {
    const pages = await MetaPage.find()
      .select('pageId name status lastError subscribedAt defaultProject igBusinessId updatedAt')
      .populate('defaultProject', 'name developer')
      .sort({ updatedAt: -1 })
      .lean();

    res.json({
      configured: Boolean(process.env.META_APP_ID && process.env.META_OAUTH_REDIRECT_URI && isConfigured()),
      appId: process.env.META_APP_ID || null,
      activeCount: pages.filter((p) => p.status === 'active').length,
      pages,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/meta/pages/:pageId/activate — subscribe the Page to `leadgen`.
 * Idempotent: safe to call again on an already-active page.
 */
exports.activatePage = async (req, res, next) => {
  try {
    const page = await MetaPage.findOne({ pageId: req.params.pageId });
    if (!page) return res.status(404).json({ message: 'Page not found — reconnect Facebook.' });

    try {
      await subscribePageToLeadgen(page.pageId, decrypt(page.encToken));
    } catch (err) {
      page.status = 'error';
      page.lastError = err.message;
      await page.save();
      return res.status(502).json({ message: `Could not subscribe Page: ${err.message}` });
    }

    page.status = 'active';
    page.lastError = '';
    page.subscribedAt = new Date();
    await page.save();

    logActivity({ req, action: 'meta.activate', resource: 'meta', resourceId: page._id, details: `Activated Meta Page ${page.name || page.pageId}` });
    res.json({ message: 'Page activated — leads will now flow in.', page });
  } catch (err) {
    next(err);
  }
};

/** POST /api/meta/pages/:pageId/disconnect — unsubscribe from `leadgen`. */
exports.disconnectPage = async (req, res, next) => {
  try {
    const page = await MetaPage.findOne({ pageId: req.params.pageId });
    if (!page) return res.status(404).json({ message: 'Page not found' });

    // Best-effort unsubscribe; proceed to mark pending even if Meta call fails
    // (e.g. token already revoked on Facebook's side).
    try {
      await unsubscribePage(page.pageId, decrypt(page.encToken));
    } catch (err) {
      console.warn(`[META] Unsubscribe warning for ${page.pageId}:`, err.message);
    }

    page.status = 'pending';
    page.subscribedAt = undefined;
    await page.save();

    logActivity({ req, action: 'meta.disconnect', resource: 'meta', resourceId: page._id, details: `Disconnected Meta Page ${page.name || page.pageId}` });
    res.json({ message: 'Page disconnected — leads stopped.', page });
  } catch (err) {
    next(err);
  }
};

/** DELETE /api/meta/pages/:pageId — unsubscribe and remove the stored Page. */
exports.removePage = async (req, res, next) => {
  try {
    const page = await MetaPage.findOne({ pageId: req.params.pageId });
    if (!page) return res.status(404).json({ message: 'Page not found' });
    try {
      await unsubscribePage(page.pageId, decrypt(page.encToken));
    } catch (err) {
      console.warn(`[META] Unsubscribe warning on remove for ${page.pageId}:`, err.message);
    }
    await MetaPage.deleteOne({ _id: page._id });
    logActivity({ req, action: 'meta.remove', resource: 'meta', resourceId: page._id, details: `Removed Meta Page ${page.name || page.pageId}` });
    res.json({ message: 'Page removed.' });
  } catch (err) {
    next(err);
  }
};

/** PATCH /api/meta/pages/:pageId — set the Page's default routing project. */
exports.updatePage = async (req, res, next) => {
  try {
    const { defaultProject } = req.body;
    const update = {};
    if (defaultProject !== undefined) update.defaultProject = defaultProject || null;

    const page = await MetaPage.findOneAndUpdate({ pageId: req.params.pageId }, { $set: update }, { new: true })
      .populate('defaultProject', 'name developer');
    if (!page) return res.status(404).json({ message: 'Page not found' });
    res.json(page);
  } catch (err) {
    next(err);
  }
};

/** GET /api/meta/pages/:pageId/forms — list the Page's lead forms. */
exports.getPageForms = async (req, res, next) => {
  try {
    const page = await MetaPage.findOne({ pageId: req.params.pageId });
    if (!page) return res.status(404).json({ message: 'Page not found' });
    const forms = await getPageLeadForms(page.pageId, decrypt(page.encToken));
    res.json(forms);
  } catch (err) {
    res.status(502).json({ message: `Could not fetch forms: ${err.message}` });
  }
};

// Internal helper for the webhook: return the decrypted Page token + default
// project for a given pageId, or null if the Page isn't connected here.
exports.resolvePageContext = async (pageId) => {
  if (!pageId) return null;
  const page = await MetaPage.findOne({ pageId }).lean();
  if (!page) return null;
  let token = null;
  try {
    token = decrypt(page.encToken);
  } catch {
    token = null;
  }
  return { token, defaultProject: page.defaultProject || null, _id: page._id };
};
