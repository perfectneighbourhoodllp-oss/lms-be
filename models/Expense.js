const mongoose = require('mongoose');

const CATEGORIES = [
  'Marketing',
  'Travel',
  'Office',
  'Hospitality',
  'Software',
  'Utilities',
  'Food',
  'Salary',
  'Other',
];

const PAYMENT_MODES = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Cheque', 'Other'];

const STATUSES = ['Pending', 'Approved', 'Rejected'];

const expenseSchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true, min: 0 },
    category: { type: String, enum: CATEGORIES, default: 'Other' },
    description: { type: String, required: true, trim: true },
    date: { type: Date, required: true, default: Date.now },
    paymentMode: { type: String, enum: PAYMENT_MODES, default: 'Cash' },
    vendor: { type: String, trim: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: STATUSES, default: 'Pending' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    rejectionReason: { type: String, trim: true },
    receiptUrl: { type: String, trim: true, required: true },
    receiptPublicId: { type: String, trim: true }, // Cloudinary public_id for cleanup
    receiptMimeType: { type: String, trim: true }, // image/* or application/pdf
  },
  { timestamps: true }
);

expenseSchema.index({ addedBy: 1, date: -1 });
expenseSchema.index({ status: 1, date: -1 });
expenseSchema.index({ project: 1 });
expenseSchema.index({ date: -1 });

const Expense = mongoose.model('Expense', expenseSchema);

module.exports = Expense;
module.exports.CATEGORIES = CATEGORIES;
module.exports.PAYMENT_MODES = PAYMENT_MODES;
module.exports.STATUSES = STATUSES;
