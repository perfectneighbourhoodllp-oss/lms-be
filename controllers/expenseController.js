const Expense = require('../models/Expense');
const cloudinary = require('../config/cloudinary');
const logActivity = require('../utils/logActivity');

// Only admin has cross-user visibility and approval rights.
// Managers behave like sales users for expenses — they see and act on their own only.
const isAdmin = (role) => role === 'admin';

/**
 * GET /api/expenses
 * Query: status, category, project, dateFrom, dateTo, addedBy, search, page, limit
 * Sales users see only their own. Manager/admin see all.
 */
exports.getExpenses = async (req, res, next) => {
  try {
    const {
      status,
      category,
      project,
      dateFrom,
      dateTo,
      addedBy,
      search,
      page = 1,
      limit = 50,
    } = req.query;

    const filter = {};

    // Role scoping:
    //   - sales + manager: own only
    //   - admin: all, may filter by addedBy
    if (!isAdmin(req.user.role)) {
      filter.addedBy = req.user.id;
    } else if (addedBy) {
      filter.addedBy = addedBy;
    }

    if (status) filter.status = status;
    if (category) filter.category = category;
    if (project) filter.project = project;

    if (dateFrom || dateTo) {
      filter.date = {};
      if (dateFrom) filter.date.$gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        filter.date.$lte = end;
      }
    }

    if (search) {
      filter.$or = [
        { description: { $regex: search, $options: 'i' } },
        { vendor: { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (Math.max(1, Number(page)) - 1) * Number(limit);

    const [items, total] = await Promise.all([
      Expense.find(filter)
        .populate('addedBy', 'name email role')
        .populate('approvedBy', 'name email')
        .populate('paidBy', 'name email')
        .populate('project', 'name')
        .sort({ date: -1, createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Expense.countDocuments(filter),
    ]);

    res.json({ items, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/expenses/stats
 * Returns totals for the current month, pending count, and category breakdown.
 * Sales users see only their own totals.
 */
exports.getStats = async (req, res, next) => {
  try {
    // All stats scoped to self unless admin (admin sees company-wide).
    const scope = isAdmin(req.user.role) ? {} : { addedBy: req.user.id };
    const financialScope = scope;
    const pendingScope = scope;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    // Approved AND Paid both count as "spent" — once admin approves it's committed money
    const spentStatuses = { $in: ['Approved', 'Paid'] };

    const [
      monthAggregate,
      pendingCount,
      awaitingPayment,
      categoryBreakdown,
      totalAllTime,
    ] = await Promise.all([
      Expense.aggregate([
        { $match: { ...financialScope, status: spentStatuses, date: { $gte: monthStart, $lte: monthEnd } } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Expense.countDocuments({ ...pendingScope, status: 'Pending' }),
      Expense.aggregate([
        { $match: { ...financialScope, status: 'Approved' } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Expense.aggregate([
        { $match: { ...financialScope, status: spentStatuses, date: { $gte: monthStart, $lte: monthEnd } } },
        { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
      Expense.aggregate([
        { $match: { ...financialScope, status: spentStatuses } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);

    res.json({
      thisMonth: monthAggregate[0]?.total || 0,
      thisMonthCount: monthAggregate[0]?.count || 0,
      pendingCount,
      awaitingPaymentCount: awaitingPayment[0]?.count || 0,
      awaitingPaymentTotal: awaitingPayment[0]?.total || 0,
      allTimeTotal: totalAllTime[0]?.total || 0,
      byCategory: categoryBreakdown.map((c) => ({
        category: c._id,
        total: c.total,
        count: c.count,
      })),
      // Tells the frontend whose totals these represent
      scope: isAdmin(req.user.role) ? 'company' : 'self',
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/expenses/:id
 */
exports.getExpense = async (req, res, next) => {
  try {
    const expense = await Expense.findById(req.params.id)
      .populate('addedBy', 'name email role')
      .populate('approvedBy', 'name email')
      .populate('paidBy', 'name email')
      .populate('project', 'name');

    if (!expense) return res.status(404).json({ message: 'Expense not found' });

    // Only admin can view other users' expenses
    if (!isAdmin(req.user.role) && String(expense.addedBy._id) !== req.user.id) {
      return res.status(403).json({ message: 'Not allowed' });
    }

    res.json(expense);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/expenses
 * Any authenticated user can submit. Always starts as Pending.
 * Receipt upload (image or PDF) is mandatory.
 */
exports.createExpense = async (req, res, next) => {
  try {
    const {
      amount,
      category,
      description,
      date,
      paymentMode,
      vendor,
      project,
      receiptUrl,
      receiptPublicId,
      receiptMimeType,
    } = req.body;

    if (!description?.trim()) {
      return res.status(400).json({ message: 'Description is required' });
    }
    if (amount === undefined || amount === null || isNaN(Number(amount)) || Number(amount) < 0) {
      return res.status(400).json({ message: 'Valid amount is required' });
    }
    if (!receiptUrl?.trim()) {
      return res.status(400).json({ message: 'Payment receipt is required — please upload a photo or screenshot' });
    }

    const expense = await Expense.create({
      amount: Number(amount),
      category,
      description: description.trim(),
      date: date ? new Date(date) : new Date(),
      paymentMode,
      vendor: vendor?.trim(),
      project: project || undefined,
      receiptUrl: receiptUrl.trim(),
      receiptPublicId: receiptPublicId?.trim(),
      receiptMimeType: receiptMimeType?.trim(),
      addedBy: req.user.id,
      status: 'Pending',
    });

    const populated = await Expense.findById(expense._id)
      .populate('addedBy', 'name email role')
      .populate('project', 'name');

    logActivity({
      req,
      action: 'expense.create',
      resource: 'expense',
      resourceId: expense._id,
      details: `Submitted ₹${expense.amount} expense — ${expense.description}`,
    });

    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/expenses/:id
 * Only the creator (and only while Pending) can edit.
 * Manager/admin can edit any non-Approved expense.
 */
exports.updateExpense = async (req, res, next) => {
  try {
    const expense = await Expense.findById(req.params.id);
    if (!expense) return res.status(404).json({ message: 'Expense not found' });

    const isOwner = String(expense.addedBy) === req.user.id;
    const admin = isAdmin(req.user.role);

    if (!isOwner && !admin) {
      return res.status(403).json({ message: 'Not allowed' });
    }

    if (expense.status === 'Approved' && !admin) {
      return res.status(400).json({ message: 'Approved expenses cannot be edited' });
    }

    const {
      amount,
      category,
      description,
      date,
      paymentMode,
      vendor,
      project,
      receiptUrl,
      receiptPublicId,
      receiptMimeType,
    } = req.body;

    if (amount !== undefined) {
      if (isNaN(Number(amount)) || Number(amount) < 0) {
        return res.status(400).json({ message: 'Valid amount is required' });
      }
      expense.amount = Number(amount);
    }
    if (category !== undefined) expense.category = category;
    if (description !== undefined) expense.description = description.trim();
    if (date !== undefined) expense.date = new Date(date);
    if (paymentMode !== undefined) expense.paymentMode = paymentMode;
    if (vendor !== undefined) expense.vendor = vendor?.trim();
    if (project !== undefined) expense.project = project || undefined;

    // If receipt is being replaced, delete the old asset from Cloudinary
    if (receiptUrl !== undefined && receiptUrl.trim() && receiptUrl !== expense.receiptUrl) {
      if (expense.receiptPublicId) {
        cloudinary.uploader.destroy(expense.receiptPublicId).catch((err) =>
          console.warn('[Expense] failed to delete old receipt:', err.message)
        );
      }
      expense.receiptUrl = receiptUrl.trim();
      expense.receiptPublicId = receiptPublicId?.trim();
      expense.receiptMimeType = receiptMimeType?.trim();
    }

    await expense.save();

    const populated = await Expense.findById(expense._id)
      .populate('addedBy', 'name email role')
      .populate('approvedBy', 'name email')
      .populate('paidBy', 'name email')
      .populate('project', 'name');

    logActivity({
      req,
      action: 'expense.update',
      resource: 'expense',
      resourceId: expense._id,
      details: `Updated ₹${expense.amount} expense — ${expense.description}`,
    });

    res.json(populated);
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/expenses/:id
 * Owner can delete only while Pending. Admin can delete anything.
 */
exports.deleteExpense = async (req, res, next) => {
  try {
    const expense = await Expense.findById(req.params.id);
    if (!expense) return res.status(404).json({ message: 'Expense not found' });

    const isOwner = String(expense.addedBy) === req.user.id;
    const isAdmin = req.user.role === 'admin';

    if (!isAdmin && !(isOwner && expense.status === 'Pending')) {
      return res.status(403).json({ message: 'Only admin can delete non-pending expenses' });
    }

    // Clean up the receipt from Cloudinary
    if (expense.receiptPublicId) {
      cloudinary.uploader.destroy(expense.receiptPublicId).catch((err) =>
        console.warn('[Expense] failed to delete receipt:', err.message)
      );
    }

    await expense.deleteOne();

    logActivity({
      req,
      action: 'expense.delete',
      resource: 'expense',
      resourceId: expense._id,
      details: `Deleted ₹${expense.amount} expense — ${expense.description}`,
    });

    res.json({ message: 'Expense deleted' });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/expenses/upload-receipt
 * Multipart upload — multer-storage-cloudinary streams the file to Cloudinary
 * and attaches the result to req.file. We just hand back the URL + public_id.
 */
exports.uploadReceipt = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }
    res.json({
      url: req.file.path,
      publicId: req.file.filename,
      mimeType: req.file.mimetype,
      size: req.file.size,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/expenses/:id/approve
 * Admin only. Admin can approve their own expense — self-approvals are clearly
 * marked in the activity log for audit purposes.
 */
exports.approveExpense = async (req, res, next) => {
  try {
    const expense = await Expense.findById(req.params.id);
    if (!expense) return res.status(404).json({ message: 'Expense not found' });

    if (expense.status === 'Approved') {
      return res.status(400).json({ message: 'Already approved' });
    }

    const isSelfApproval = String(expense.addedBy) === req.user.id;

    expense.status = 'Approved';
    expense.approvedBy = req.user.id;
    expense.approvedAt = new Date();
    expense.rejectionReason = undefined;
    await expense.save();

    const populated = await Expense.findById(expense._id)
      .populate('addedBy', 'name email role')
      .populate('approvedBy', 'name email')
      .populate('paidBy', 'name email')
      .populate('project', 'name');

    logActivity({
      req,
      action: isSelfApproval ? 'expense.selfApprove' : 'expense.approve',
      resource: 'expense',
      resourceId: expense._id,
      details: `${isSelfApproval ? 'Self-approved' : 'Approved'} ₹${expense.amount} expense${isSelfApproval ? '' : ` by ${populated.addedBy?.name}`}`,
    });

    res.json(populated);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/expenses/:id/mark-paid
 * Admin only. The expense must be in Approved state.
 * Body: { paymentReference?: string } — optional UTR / txn ID
 */
exports.markAsPaid = async (req, res, next) => {
  try {
    const { paymentReference } = req.body;
    const expense = await Expense.findById(req.params.id);
    if (!expense) return res.status(404).json({ message: 'Expense not found' });

    if (expense.status !== 'Approved') {
      return res.status(400).json({
        message: `Only approved expenses can be marked as paid (current status: ${expense.status})`,
      });
    }

    expense.status = 'Paid';
    expense.paidBy = req.user.id;
    expense.paidAt = new Date();
    if (paymentReference?.trim()) expense.paymentReference = paymentReference.trim();
    await expense.save();

    const populated = await Expense.findById(expense._id)
      .populate('addedBy', 'name email role')
      .populate('approvedBy', 'name email')
      .populate('paidBy', 'name email')
      .populate('project', 'name');

    logActivity({
      req,
      action: 'expense.markPaid',
      resource: 'expense',
      resourceId: expense._id,
      details: `Marked ₹${expense.amount} expense as paid to ${populated.addedBy?.name}${paymentReference ? ` (ref: ${paymentReference})` : ''}`,
    });

    res.json(populated);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/expenses/:id/reject
 * Admin only. Optional reason in body.
 */
exports.rejectExpense = async (req, res, next) => {
  try {
    const { reason } = req.body;
    const expense = await Expense.findById(req.params.id);
    if (!expense) return res.status(404).json({ message: 'Expense not found' });

    expense.status = 'Rejected';
    expense.approvedBy = req.user.id;
    expense.approvedAt = new Date();
    expense.rejectionReason = reason?.trim();
    await expense.save();

    const populated = await Expense.findById(expense._id)
      .populate('addedBy', 'name email role')
      .populate('approvedBy', 'name email')
      .populate('paidBy', 'name email')
      .populate('project', 'name');

    logActivity({
      req,
      action: 'expense.reject',
      resource: 'expense',
      resourceId: expense._id,
      details: `Rejected ₹${expense.amount} expense by ${populated.addedBy?.name}${reason ? ` — ${reason}` : ''}`,
    });

    res.json(populated);
  } catch (err) {
    next(err);
  }
};
