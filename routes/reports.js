const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getAgentReport,
  getReportSettings,
  updateReportSettings,
  sendTestReport,
} = require('../controllers/reportController');

router.use(protect);

router.get('/agents', authorize('admin', 'manager'), getAgentReport);

// Daily email config — admin only
router.get('/settings', authorize('admin'), getReportSettings);
router.put('/settings', authorize('admin'), updateReportSettings);
router.post('/send-test', authorize('admin'), sendTestReport);

module.exports = router;
