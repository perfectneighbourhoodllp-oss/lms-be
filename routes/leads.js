const router = require('express').Router();
const multer = require('multer');
const { protect, authorize } = require('../middleware/auth');
const {
  getLeads,
  getLead,
  createLead,
  updateLead,
  deleteLead,
  addRemark,
  getRelatedLeads,
  bulkUpload,
  getTodayFollowups,
  getOverdueLeads,
  getStats,
} = require('../controllers/leadController');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only .csv files are allowed'));
    }
  },
});

router.use(protect);

router.get('/stats', getStats);
router.get('/today-followups', getTodayFollowups);
router.get('/overdue', getOverdueLeads);

router.route('/').get(getLeads).post(createLead);
router.post('/bulk', authorize('admin', 'manager'), upload.single('file'), bulkUpload);
router.route('/:id')
  .get(getLead)
  .put(updateLead)
  .delete(authorize('admin', 'manager'), deleteLead);

router.post('/:id/remarks', addRemark);
router.get('/:id/related', getRelatedLeads);

module.exports = router;
