const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getAgentReport,
  getReportSettings,
  updateReportSettings,
  sendTestReport,
  setAgentEmailInclusion,
} = require('../controllers/reportController');

router.use(protect);

router.get('/agents', authorize('admin', 'manager'), getAgentReport);

// Daily email config — admin only
router.get('/settings', authorize('admin'), getReportSettings);
router.put('/settings', authorize('admin'), updateReportSettings);
router.post('/send-test', authorize('admin'), sendTestReport);
// Per-agent mail toggle: include/exclude an agent's row from the emailed report
router.patch('/agent-email/:agentId', authorize('admin'), setAgentEmailInclusion);

module.exports = router;
