const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const uploadWaMedia = require('../middleware/uploadWaMedia');
const {
  verifyWebhook,
  handleInbound,
  startForLead,
  repReply,
  sendMedia,
  takeOver,
  getInbox,
} = require('../controllers/waAgentController');

// Public — Meta calls these directly (own verify token; not HMAC-checked here)
router.get('/webhook', verifyWebhook);
router.post('/webhook', handleInbound);

// Protected — the inbox is scoped by role inside the controller (sales see their own).
router.get('/inbox', protect, getInbox);
router.post('/leads/:id/start', protect, authorize('admin', 'manager'), startForLead);
// Any authenticated user; the controller enforces that sales can only reply to their own lead.
router.post('/leads/:id/reply', protect, repReply);
router.post('/leads/:id/send-media', protect, uploadWaMedia.single('file'), sendMedia);
router.post('/leads/:id/takeover', protect, takeOver);

module.exports = router;
