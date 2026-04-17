const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const { getUsers, createUser, updateUser, resetPassword, getAgentPerformance } = require('../controllers/userController');

router.use(protect);

// Both admin and manager can list and create users
router.get('/', getUsers);
router.get('/agent-performance', authorize('admin', 'manager'), getAgentPerformance);
router.post('/', authorize('admin', 'manager'), createUser);

// Admin can update any user; manager restricted inside controller
router.put('/:id', authorize('admin', 'manager'), updateUser);
router.put('/:id/reset-password', authorize('admin'), resetPassword);

module.exports = router;
