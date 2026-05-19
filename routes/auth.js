const router = require('express').Router();
const {
  register,
  login,
  getMe,
  verifyLoginOtp,
  resendLoginOtp,
} = require('../controllers/authController');
const { protect } = require('../middleware/auth');

router.post('/register', register);
router.post('/login', login);
router.post('/verify-otp', verifyLoginOtp);
router.post('/resend-otp', resendLoginOtp);
router.get('/me', protect, getMe);

module.exports = router;
