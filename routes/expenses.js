const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const uploadReceipt = require('../middleware/uploadReceipt');
const {
  getExpenses,
  getStats,
  getExpense,
  createExpense,
  updateExpense,
  deleteExpense,
  approveExpense,
  rejectExpense,
  markAsPaid,
  uploadReceipt: uploadReceiptHandler,
} = require('../controllers/expenseController');

router.use(protect);

router.get('/', getExpenses);
router.get('/stats', getStats);
router.post('/upload-receipt', uploadReceipt.single('file'), uploadReceiptHandler);
router.get('/:id', getExpense);

router.post('/', createExpense);
router.put('/:id', updateExpense);
router.delete('/:id', deleteExpense);

router.post('/:id/approve', authorize('admin'), approveExpense);
router.post('/:id/reject', authorize('admin'), rejectExpense);
router.post('/:id/mark-paid', authorize('admin'), markAsPaid);

module.exports = router;
