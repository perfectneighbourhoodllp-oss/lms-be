const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const uploadSelfie = require('../middleware/uploadSelfie');
const {
  checkIn,
  checkOut,
  getToday,
  getMyAttendance,
  getAllAttendance,
  getOfficeConfig,
  uploadSelfie: uploadSelfieHandler,
} = require('../controllers/attendanceController');

router.use(protect);

router.post('/upload-selfie', uploadSelfie.single('file'), uploadSelfieHandler);
router.get('/office', getOfficeConfig);
router.get('/today', getToday);
router.get('/me', getMyAttendance);
router.post('/check-in', checkIn);
router.post('/check-out', checkOut);
router.get('/', authorize('admin', 'manager'), getAllAttendance);

module.exports = router;
