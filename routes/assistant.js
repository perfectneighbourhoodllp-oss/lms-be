const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const { ask, askStream, usage, nextAction, history } = require('../controllers/assistantController');

router.use(protect);

// Chat assistant — admin only.
router.post('/ask/stream', authorize('admin'), askStream); // streaming (SSE) — primary
router.post('/ask', authorize('admin'), ask); // non-streaming fallback
// Chat history (last 7 days) — admin only.
router.get('/history', authorize('admin'), history);
// AI usage & cost dashboard data — admin only.
router.get('/usage', authorize('admin'), usage);

// Per-lead Next Best Action — admin/manager/assigned-agent (checked in the controller).
router.post('/leads/:id/next-action', nextAction);

module.exports = router;
