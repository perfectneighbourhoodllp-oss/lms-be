const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getConnectUrl,
  oauthCallback,
  getStatus,
  activatePage,
  disconnectPage,
  removePage,
  updatePage,
  getPageForms,
} = require('../controllers/metaOAuthController');

// Public — Meta redirects the browser here after login (secured by signed `state`)
router.get('/oauth/callback', oauthCallback);

// Start the OAuth flow — returns the Facebook dialog URL (admin only)
router.get('/oauth/connect', protect, authorize('admin'), getConnectUrl);

// Connection status + page list (admin/manager)
router.get('/status', protect, authorize('admin', 'manager'), getStatus);
router.get('/pages/:pageId/forms', protect, authorize('admin', 'manager'), getPageForms);

// Page management (admin only)
router.post('/pages/:pageId/activate', protect, authorize('admin'), activatePage);
router.post('/pages/:pageId/disconnect', protect, authorize('admin'), disconnectPage);
router.patch('/pages/:pageId', protect, authorize('admin'), updatePage);
router.delete('/pages/:pageId', protect, authorize('admin'), removePage);

module.exports = router;
