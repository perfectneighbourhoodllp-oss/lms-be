const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const { getLogs, getActions } = require('../controllers/activityLogController');

router.use(protect, authorize('admin'));

router.get('/', getLogs);
router.get('/actions', getActions);

module.exports = router;
