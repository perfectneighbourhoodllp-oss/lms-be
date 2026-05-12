const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'pnh-expenses',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'pdf'],
    // Resize huge images before storing to save bandwidth + speed up loads.
    // PDFs and small images pass through untouched.
    transformation: [{ width: 1600, height: 1600, crop: 'limit' }],
  },
});

const uploadReceipt = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (_, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.mimetype);
    if (ok) cb(null, true);
    else cb(new Error('Only JPG, PNG, WEBP or PDF files are allowed'));
  },
});

module.exports = uploadReceipt;
