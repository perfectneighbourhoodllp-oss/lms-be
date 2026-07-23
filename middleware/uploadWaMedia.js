const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');

// Media an agent sends to a lead from the WhatsApp Inbox — images or documents.
// resource_type 'auto' lets Cloudinary host PDFs/files (raw) as well as images.
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'pnh-whatsapp',
    resource_type: 'auto',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'pdf'],
  },
});

const uploadWaMedia = multer({
  storage,
  limits: { fileSize: 16 * 1024 * 1024 }, // 16 MB (WhatsApp document cap)
  fileFilter: (_, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.mimetype);
    if (ok) cb(null, true);
    else cb(new Error('Only JPG, PNG, WEBP images or PDF files are allowed'));
  },
});

module.exports = uploadWaMedia;
