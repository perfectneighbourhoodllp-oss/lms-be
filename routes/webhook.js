const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const {
  verifyWebhook,
  handleLeadEvent,
  getLogs,
  getLogStats,
  getMappings,
  createMapping,
  deleteMapping,
} = require('../controllers/webhookController');

// Public — Meta calls these directly, no JWT
router.get('/meta', verifyWebhook);
router.post('/meta', handleLeadEvent);

// Protected — admin/manager log viewer
router.get('/logs', protect, authorize('admin', 'manager'), getLogs);
router.get('/logs/stats', protect, authorize('admin', 'manager'), getLogStats);

// Protected — admin-only project mappings
router.route('/mappings')
  .get(protect, authorize('admin', 'manager'), getMappings)
  .post(protect, authorize('admin'), createMapping);
router.delete('/mappings/:id', protect, authorize('admin'), deleteMapping);

module.exports = router;
