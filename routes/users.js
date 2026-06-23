const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getUsers,
  createUser,
  updateUser,
  resetPassword,
  getAgentPerformance,
  setMyAvailability,
  getAgentProfileStats,
  registerDeviceToken,
  removeDeviceToken,
} = require('../controllers/userController');

router.use(protect);

// Self-service availability toggle (any authenticated user)
router.put('/me/availability', setMyAvailability);

// Mobile push: register / unregister this device's FCM token
router.post('/me/device-token', registerDeviceToken);
router.delete('/me/device-token', removeDeviceToken);

// Both admin and manager can list and create users
router.get('/', getUsers);
router.get('/agent-performance', authorize('admin', 'manager'), getAgentPerformance);
router.post('/', authorize('admin', 'manager'), createUser);

// Per-agent profile stats — permission check inside controller
// (admin: any agent, manager: their team, sales: self only)
router.get('/:id/profile-stats', getAgentProfileStats);

// Admin can update any user; manager restricted inside controller
router.put('/:id', authorize('admin', 'manager'), updateUser);
router.put('/:id/reset-password', authorize('admin'), resetPassword);

module.exports = router;
