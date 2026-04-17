const router = require('express').Router();
const { getActivities, createActivity, updateActivity, deleteActivity } = require('../controllers/activityController');
const { protect } = require('../middleware/auth');

router.use(protect);

router.route('/').get(getActivities).post(createActivity);
router.route('/:id').put(updateActivity).delete(deleteActivity);

module.exports = router;
