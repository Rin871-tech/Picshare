// Run once before upgrading an existing communications deployment. No records are deleted.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const collections = new Set((await db.listCollections().toArray()).map(c => c.name));
  if (collections.has('messages')) {
    const indexes = await db.collection('messages').indexes();
    for (const index of indexes) {
      if (index.key.conversation && index.key.idempotencyKey && !index.key.sender) await db.collection('messages').dropIndex(index.name);
    }
  }
  if (collections.has('calls')) {
    const index = (await db.collection('calls').indexes()).find(i => i.key.expiresAt && i.expireAfterSeconds !== undefined);
    if (index) await db.collection('calls').dropIndex(index.name);
  }
  const models = ['Conversation', 'Message', 'Call', 'LocationSession', 'Block', 'Notification', 'Attachment', 'Post', 'Bookmark', 'Collection', 'Challenge', 'Entry', 'Vote', 'Story', 'StoryView', 'Space', 'SpaceItem', 'SpaceComment', 'Report', 'DeletionRequest'];
  for (const name of models) await require(`../models/${name}`).createIndexes();
  console.log('PicShare indexes updated; existing records preserved.');
})().catch(() => { console.error('Migration failed. Check database access and index compatibility.'); process.exitCode = 1; }).finally(() => mongoose.disconnect());
