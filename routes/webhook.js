const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const {
  verifyWebhook,
  handleLeadEvent,
  getLogs,
  getLogStats,
  getMappings,
  createMapping,
  updateMapping,
  deleteMapping,
} = require('../controllers/webhookController');

// Public — Meta calls these directly, no JWT.
// NOTE: signature verification + raw-body parsing already run at the app level
// in index.js (express.raw + verifyMetaSignature scoped to /api/webhook/meta),
// so req.body is already a verified, parsed object by the time it reaches here.
// Do NOT re-apply verifyMetaSignature — it would crash on the parsed body.
router.get('/meta', verifyWebhook);
router.post('/meta', handleLeadEvent);

// Protected — admin/manager log viewer
router.get('/logs', protect, authorize('admin', 'manager'), getLogs);
router.get('/logs/stats', protect, authorize('admin', 'manager'), getLogStats);

// Protected — admin-only project mappings
router.route('/mappings')
  .get(protect, authorize('admin', 'manager'), getMappings)
  .post(protect, authorize('admin'), createMapping);
router.patch('/mappings/:id', protect, authorize('admin'), updateMapping);
router.delete('/mappings/:id', protect, authorize('admin'), deleteMapping);

module.exports = router;
