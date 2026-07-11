const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const { getStatus, getEvents, sendTest } = require('../controllers/capiController');

router.get('/status', protect, authorize('admin', 'manager'), getStatus);
router.get('/events', protect, authorize('admin', 'manager'), getEvents);
router.post('/test', protect, authorize('admin'), sendTest);

module.exports = router;
