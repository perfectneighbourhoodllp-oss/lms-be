const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const { getAgentReport } = require('../controllers/reportController');

router.use(protect);

router.get('/agents', authorize('admin', 'manager'), getAgentReport);

module.exports = router;
