const fs = require('node:fs/promises');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
let client;
function configured() { return Boolean(process.env.MESSAGE_S3_BUCKET && process.env.MESSAGE_S3_ACCESS_KEY_ID && process.env.MESSAGE_S3_SECRET_ACCESS_KEY); }
function s3() {
  if (!client) client = new S3Client({ region: process.env.MESSAGE_S3_REGION || 'auto', ...(process.env.MESSAGE_S3_ENDPOINT ? { endpoint: process.env.MESSAGE_S3_ENDPOINT } : {}), credentials: { accessKeyId: process.env.MESSAGE_S3_ACCESS_KEY_ID, secretAccessKey: process.env.MESSAGE_S3_SECRET_ACCESS_KEY } });
  return client;
}
async function save(file) {
  if (!configured()) {
    if (process.env.NODE_ENV === 'production') { await fs.unlink(file.path).catch(() => {}); throw Object.assign(new Error('Private image storage is not configured yet. Text messages are available.'), { status: 503 }); }
    return { storage: 'local' };
  }
  const objectKey = `messages/${file.filename}`;
  try {
    await s3().send(new PutObjectCommand({ Bucket: process.env.MESSAGE_S3_BUCKET, Key: objectKey, Body: await fs.readFile(file.path), ContentType: file.mimetype, CacheControl: 'private, no-store' }));
    return { storage: 's3', objectKey };
  } finally { await fs.unlink(file.path).catch(() => {}); }
}
async function read(attachment, res) {
  const object = await s3().send(new GetObjectCommand({ Bucket: process.env.MESSAGE_S3_BUCKET, Key: attachment.objectKey }));
  res.set('Content-Type', object.ContentType || 'application/octet-stream'); res.set('X-Content-Type-Options', 'nosniff');
  const { pipeline } = require('node:stream/promises'); await pipeline(object.Body, res);
}
module.exports = { configured, save, read };
