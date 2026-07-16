const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const {
  verifyWebhook,
  handleInbound,
  startForLead,
  repReply,
  getHandoffs,
} = require('../controllers/waAgentController');

// Public — Meta calls these directly (own verify token; not HMAC-checked here)
router.get('/webhook', verifyWebhook);
router.post('/webhook', handleInbound);

// Protected — rep/admin actions
router.get('/handoffs', protect, authorize('admin', 'manager'), getHandoffs);
router.post('/leads/:id/start', protect, authorize('admin', 'manager'), startForLead);
// Any authenticated user; the controller enforces that sales can only reply to their own lead.
router.post('/leads/:id/reply', protect, repReply);

module.exports = router;
