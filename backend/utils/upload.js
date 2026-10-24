const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const allowed = new Map([['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'], ['image/gif', '.gif']]);
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const directory = req.privateAttachment ? path.join(uploadDir, '..', path.basename(uploadDir) + '-private') : uploadDir;
    fs.mkdirSync(directory, { recursive: true }); cb(null, directory);
  },
  filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${allowed.get(file.mimetype) || '.bin'}`)
});
const upload = multer({
  storage,
  limits: { fileSize: (Number(process.env.MAX_UPLOAD_MB) || 5) * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => allowed.has(file.mimetype) ? cb(null, true) : cb(new Error('Only JPEG, PNG, WEBP, and GIF images are allowed.'))
});
const originalSingle = upload.single.bind(upload);
upload.single = field => {
  const parse = originalSingle(field);
  return (req, res, next) => parse(req, res, async err => {
    if (err || !req.file) return next(err);
    try {
      const handle = await fs.promises.open(req.file.path, 'r');
      const bytes = Buffer.alloc(16);
      try { await handle.read(bytes, 0, 16, 0); } finally { await handle.close(); }
      const mime = req.file.mimetype;
      const valid = mime === 'image/jpeg' && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
        mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        mime === 'image/gif' && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) ||
        mime === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (!valid) {
        await fs.promises.unlink(req.file.path);
        return next(Object.assign(new Error('Image contents do not match the file type.'), { status: 400 }));
      }
      next();
    } catch (error) { next(error); }
  });
};
module.exports = upload;
