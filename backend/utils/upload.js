const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const uploadDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const allowed = new Map([['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'], ['image/gif', '.gif']]);
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${allowed.get(file.mimetype) || '.bin'}`)
});
const upload = multer({
  storage,
  limits: { fileSize: (Number(process.env.MAX_UPLOAD_MB) || 5) * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => allowed.has(file.mimetype) ? cb(null, true) : cb(new Error('Only JPEG, PNG, WEBP, and GIF images are allowed.'))
});
module.exports = upload;
