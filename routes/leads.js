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
  addSiteVisit,
  updateSiteVisit,
  deleteSiteVisit,
  getRelatedLeads,
  bulkUpload,
  bulkDelete,
  bulkSetLeadType,
  bulkAssign,
  getTodayFollowups,
  getOverdueLeads,
  getStats,
  exportLeads,
  acceptLead,
  rejectLead,
  logCall,
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
router.get('/export', authorize('admin'), exportLeads);

router.route('/').get(getLeads).post(createLead);
router.post('/bulk', authorize('admin', 'manager'), upload.single('file'), bulkUpload);
router.post('/bulk-delete', authorize('admin'), bulkDelete);
router.post('/bulk-type', authorize('admin'), bulkSetLeadType);
router.post('/bulk-assign', authorize('admin', 'manager'), bulkAssign);
router.route('/:id')
  .get(getLead)
  .put(updateLead)
  .delete(authorize('admin', 'manager'), deleteLead);

router.post('/:id/remarks', addRemark);
router.post('/:id/site-visits', addSiteVisit);
router.put('/:id/site-visits/:visitId', updateSiteVisit);
router.delete('/:id/site-visits/:visitId', deleteSiteVisit);
router.post('/:id/accept', acceptLead);
router.post('/:id/reject', rejectLead);
router.post('/:id/log-call', logCall);
router.post('/:id/log-contact', logCall);
router.get('/:id/related', getRelatedLeads);

module.exports = router;
