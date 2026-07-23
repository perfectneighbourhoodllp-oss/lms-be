const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'pnh-projects',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    // Cap large photos so WhatsApp delivery + page loads stay fast.
    transformation: [{ width: 1600, height: 1600, crop: 'limit' }],
  },
});

const uploadProjectImage = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (_, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    if (ok) cb(null, true);
    else cb(new Error('Only JPG, PNG or WEBP images are allowed'));
  },
});

module.exports = uploadProjectImage;
