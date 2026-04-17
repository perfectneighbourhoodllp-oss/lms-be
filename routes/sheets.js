const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getConfigs,
  createConfig,
  updateConfig,
  deleteConfig,
  manualSync,
  incoming,
} = require('../controllers/sheetController');

// Public — Google Apps Script sends here (authenticated via secret header)
router.post('/incoming', incoming);

// Protected — admin/manager
router.get('/', protect, authorize('admin', 'manager'), getConfigs);
router.post('/', protect, authorize('admin'), createConfig);
router.put('/:id', protect, authorize('admin'), updateConfig);
router.delete('/:id', protect, authorize('admin'), deleteConfig);
router.post('/:id/sync', protect, authorize('admin', 'manager'), manualSync);

module.exports = router;
