const test = require('node:test');
const assert = require('node:assert/strict');
if (!process.env.TEST_MONGODB_URI) test('PicShare 3.0 integration (set TEST_MONGODB_URI)', { skip:true }, () => {});
else {
  const mongoose = require('mongoose'); const jwt = require('jsonwebtoken'); const fs = require('fs/promises'); const path = require('path');
  const User = require('../models/User'), Post = require('../models/Post'), Story = require('../models/Story'), Space = require('../models/Space');
  process.env.JWT_SECRET = 'isolated-v3-test-secret-at-least-32-characters';
  process.env.GOOGLE_CLIENT_ID = 'test-client';
  const { app, server, io } = require('../server');
  let base, people, tokens, post, challenge, circle, album, story, item, bookmark;
  const files = [];
  async function req(who, route, method = 'GET', body) {
    const headers = who === null ? {} : { Authorization:`Bearer ${tokens[who]}` };
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + route, { method, headers, ...(body ? { body:body instanceof FormData ? body : JSON.stringify(body) } : {}) });
    return { status:response.status, ...await response.json().catch(() => ({})) };
  }
  function image(extra = {}) {
    const form = new FormData(); form.append('image', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1cAAAAASUVORK5CYII=', 'base64')], { type:'image/png' }), 'test.png');
    for (const [key,value] of Object.entries(extra)) form.append(key,value); return form;
  }
  test.before(async () => {
    await mongoose.connect(process.env.TEST_MONGODB_URI,{ serverSelectionTimeoutMS:3000 });
    for (const name of ['User','Post','Bookmark','Challenge','Entry','Vote','Collection','Report','Story','StoryView','Space','SpaceItem','SpaceComment','DeletionRequest']) await require(`../models/${name}`).init();
    const stamp = Date.now(); people = await User.create(['a','b','c'].map(c => ({ username:`v3_${c}_${stamp}`, name:c, email:`${c}_${stamp}@v3.test.local`, passwordHash:'test' })));
    tokens = people.map(p => jwt.sign({ sub:p.id },process.env.JWT_SECRET,{ expiresIn:'1h' }));
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); base = `http://127.0.0.1:${server.address().port}`;
  });
  test.after(async () => {
    await new Promise(resolve => io.close(resolve));
    if (people) {
      const ids = people.map(p => p._id); const conversations = await require('../models/Conversation').find({ participants: { $in: ids } }); await require('../models/Message').deleteMany({ conversation: { $in: conversations.map(c => c._id) } }); await require('../models/Conversation').deleteMany({ participants: { $in: ids } }); await require('../models/Notification').deleteMany({ recipient: { $in: ids } }); const spaces = await Space.find({ owner:{ $in:ids } }); const spaceIds = spaces.map(s => s._id);
      const storyRows = await Story.find({ owner:{ $in:ids } }); const items = await require('../models/SpaceItem').find({ space:{ $in:spaceIds } });
      for (const row of [...storyRows,...items]) files.push(require('../utils/media').privatePath(row.filename));
      for (const file of files) await fs.unlink(file).catch(() => {});
      for (const [name,filter] of [['Bookmark',{ user:{ $in:ids } }],['Vote',{ user:{ $in:ids } }],['Entry',{ user:{ $in:ids } }],['Collection',{ owner:{ $in:ids } }],['Report',{ reporter:{ $in:ids } }],['DeletionRequest',{ user:{ $in:ids } }],['SpaceItem',{ space:{ $in:spaceIds } }],['SpaceComment',{ space:{ $in:spaceIds } }],['Space',{ owner:{ $in:ids } }],['StoryView',{ viewer:{ $in:ids } }],['Story',{ owner:{ $in:ids } }],['Post',{ author:{ $in:ids } }],['Follow',{ follower:{ $in:ids } }],['User',{ _id:{ $in:ids } }]]) await require(`../models/${name}`).deleteMany(filter);
    }
    await mongoose.disconnect();
  });
  test('post uploads, tag/category discovery and safe search', async () => {
    const response = await req(0,'/api/posts','POST',image({ caption:'Quiet lake #nature', category:'nature', mood:'peaceful' })); assert.equal(response.status,201); post = response.post;
    files.push(path.join(__dirname,'..','uploads',post.imageUrl.split('?')[0].split('/').at(-1)));
    const search = await req(1,'/api/discover?q=%23nature&category=nature'); assert.ok(search.posts.some(p => p._id === post._id));
    assert.equal((await req(1,'/api/discover?q=%5B')).status,200);
    assert.equal((await req(null,'/api/discover')).status,401);
    assert.equal((await req(1,`/api/posts/${post._id}`,'PATCH',{ caption:'forged' })).status,403);
    assert.equal((await req(0,`/api/posts/${post._id}`,'PATCH',{ caption:'Quiet mountain lake #nature' })).status,200);
  });
  test('private profiles filter discovery, post and media reads; signed URL cannot override privacy', async () => {
    const viewer = await req(1,`/api/posts/${post._id}`); const viewerLink = viewer.post.imageUrl;
    assert.equal((await fetch(base+viewerLink)).status,200);
    assert.equal((await req(0,'/api/settings','PATCH',{ account:'private' })).status,200);
    assert.equal((await req(1,`/api/posts/${post._id}`)).status,403);
    assert.equal((await fetch(base+viewerLink)).status,403);
    assert.equal((await fetch(base+post.imageUrl.split('?')[0])).status,403);
    assert.ok(!(await req(1,'/api/discover?q=%23nature')).posts.some(p => p._id === post._id));
    const owner = await req(0,`/api/posts/${post._id}`); assert.equal((await fetch(base+owner.post.imageUrl)).status,200);
    // Media-purpose tokens must never authenticate API or socket sessions.
    const token = new URL(base+owner.post.imageUrl).searchParams.get('media');
    assert.equal((await fetch(base+'/api/users/me',{ headers:{ Authorization:`Bearer ${token}` } })).status,401);
    await req(0,'/api/settings','PATCH',{ account:'public' });
  });
  test('bookmarks deduplicate and collection visibility/ownership are enforced', async () => {
    await Promise.all([req(1,`/api/posts/${post._id}/bookmark`,'POST',{ saved:true }),req(1,`/api/posts/${post._id}/bookmark`,'POST',{ saved:true })]);
    assert.equal(await require('../models/Bookmark').countDocuments({ user:people[1]._id,post:post._id }),1);
    assert.ok((await req(1,'/api/bookmarks')).posts.some(p => p._id === post._id));
    const created = await req(1,'/api/collections','POST',{ name:'Lakes',visibility:'private' }); bookmark = created.collection;
    assert.equal((await req(1,`/api/collections/${bookmark._id}/posts`,'POST',{ postId:post._id })).status,200);
    assert.equal((await req(0,`/api/collections/${bookmark._id}`)).status,403);
    assert.equal((await req(0,`/api/collections/${bookmark._id}/posts`,'POST',{ postId:post._id })).status,403);
    assert.equal((await req(1,`/api/collections/${bookmark._id}`)).posts.length,1);
  });
  test('daily challenges enforce own submissions, one vote per challenge and deadlines', async () => {
    challenge = (await req(0,'/api/challenges')).current;
    assert.equal((await req(1,`/api/challenges/${challenge._id}/entries`,'POST',{ postId:post._id })).status,403);
    const response = await req(0,`/api/challenges/${challenge._id}/entries`,'POST',{ postId:post._id }); assert.equal(response.status,201);
    await Promise.all([req(1,`/api/challenges/${challenge._id}/vote`,'POST',{ entryId:response.entry._id }),req(1,`/api/challenges/${challenge._id}/vote`,'POST',{ entryId:response.entry._id })]);
    assert.equal(await require('../models/Vote').countDocuments({ challenge:challenge._id,user:people[1]._id }),1);
    assert.equal((await req(0,`/api/challenges/${challenge._id}/vote`,'POST',{ entryId:response.entry._id })).status,400);
    const closed = await require('../models/Challenge').create({ key:`closed-${Date.now()}`,title:'Closed',startsAt:new Date(Date.now()-2000),closesAt:new Date(Date.now()-1000) });
    assert.equal((await req(0,`/api/challenges/${closed._id}/entries`,'POST',{ postId:post._id })).status,410);
    await closed.deleteOne();
  });
  test('stories require consent action, enforce audience, unique views, expiry and protected media', async () => {
    const response = await req(0,'/api/stories','POST',image({ text:'Today',audience:'followers' })); assert.equal(response.status,201); story = response.story;
    assert.ok(!(await req(1,'/api/stories')).stories.some(s => s._id === story._id));
    assert.equal((await req(1,`/api/stories/${story._id}/view`,'POST',{})).status,403);
    await require('../models/Follow').create({ follower:people[1]._id,following:people[0]._id });
    const visible = (await req(1,'/api/stories')).stories.find(s => s._id === story._id); assert.ok(visible);
    assert.equal((await fetch(base+visible.imageUrl)).status,200);
    await Promise.all([req(1,`/api/stories/${story._id}/view`,'POST',{}),req(1,`/api/stories/${story._id}/view`,'POST',{ reaction:'❤️' })]);
    assert.equal((await req(0,`/api/stories/${story._id}/viewers`)).count,1);
    assert.equal((await req(2,`/api/stories/${story._id}/viewers`)).status,403);
    await Story.updateOne({ _id:story._id },{ $set:{ expiresAt:new Date(Date.now()-1) } });
    assert.equal((await fetch(base+visible.imageUrl)).status,410);
    assert.equal((await req(1,`/api/stories/${story._id}/view`,'POST',{})).status,410);
  });
  test('Circles and albums protect membership, upload roles, media and revocation', async () => {
    circle = (await req(0,'/api/spaces','POST',{ kind:'circle',name:'Friends' })).space;
    album = (await req(0,'/api/spaces','POST',{ kind:'album',name:'Trip' })).space;
    assert.equal((await req(1,`/api/spaces/${circle._id}`)).status,403);
    await req(0,`/api/spaces/${album._id}/members`,'POST',{ username:people[1].username,role:'viewer' });
    assert.equal((await req(1,`/api/spaces/${album._id}/items`,'POST',image())).status,403);
    assert.equal((await req(1,`/api/spaces/${album._id}/members`,'POST',{ username:people[2].username })).status,403);
    item = (await req(0,`/api/spaces/${album._id}/items`,'POST',image({ caption:'Private memory' }))).item;
    const shared = await req(1,`/api/spaces/${album._id}`); const link = shared.items[0].imageUrl;
    assert.equal((await fetch(base+link)).status,200);
    assert.equal((await req(2,`/api/spaces/${album._id}/items/${item._id}/media`)).status,403);
    await req(0,`/api/spaces/${album._id}/members/${people[1].id}`,'DELETE');
    assert.equal((await fetch(base+link)).status,403);
    await req(0,`/api/spaces/${circle._id}/members`,'POST',{ username:people[1].username,role:'contributor' });
    const photo = await req(1,`/api/spaces/${circle._id}/items`,'POST',image()); assert.equal(photo.status,201);
    assert.equal((await req(1,`/api/spaces/${circle._id}/items/${photo.item._id}/comments`,'POST',{ text:'Hello friends' })).status,201);
    assert.equal((await req(2,`/api/spaces/${circle._id}/items/${photo.item._id}/comments`)).status,403);
  });
  test('privacy contact policies reject messages, calls policy is persisted', async () => {
    await req(0,'/api/settings','PATCH',{ messages:'nobody',calls:'nobody' });
    assert.equal((await req(1,'/api/conversations','POST',{ recipientId:people[0].id })).status,403);
    assert.equal((await req(0,'/api/settings')).privacy.calls,'nobody');
    await req(0,'/api/settings','PATCH',{ messages:'everyone',calls:'everyone' });
  });
  test('reports, deletion requests and analytics enforce own/admin access', async () => {
    const report = await req(1,'/api/reports','POST',{ targetType:'post',target:post._id,reason:'Review this content' }); assert.equal(report.status,201);
    assert.equal((await req(2,'/api/admin/reports')).status,403);
    assert.equal((await req(2,`/api/admin/reports/${report.report._id}`,'PATCH',{ status:'resolved' })).status,403);
    const metrics = await req(0,'/api/analytics/me'); assert.ok(metrics.posts.some(p => p._id === post._id));
    assert.ok(!(await req(1,'/api/analytics/me')).posts.some(p => p._id === post._id));
    const request = await req(0,'/api/account/deletion-request','POST',{}); assert.equal(request.request.status,'requested');
    assert.equal((await User.findById(people[0]._id)).id,people[0].id);
    assert.equal((await req(0,'/api/account/deletion-request','POST',{ cancel:true })).request.status,'cancelled');
  });
  test('public photo-map locations are opt-in, coarse and separate from live sharing', async () => {
    const response = await req(0,'/api/posts','POST',image({ caption:'Approximate public place',sharePlace:'true',placeLat:'18.5234',placeLng:'73.8567',placeLabel:'An approximate place' }));
    assert.equal(response.status,201); files.push(path.join(__dirname,'..','uploads',response.post.imageUrl.split('?')[0].split('/').at(-1)));
    const map = await req(1,'/api/photo-map'); const marker = map.posts.find(p => p._id === response.post._id);
    assert.equal(marker.publicPlace.lat,18.5); assert.equal(marker.publicPlace.lng,73.9);
    assert.ok(!map.posts.some(p => p._id === post._id));
    await req(0,`/api/posts/${response.post._id}`,'DELETE');
  });
  test('conversation pin/mute and message state recovery enforce participant access', async () => {
    const created = await req(0,'/api/conversations','POST',{ recipientId:people[1].id }); const conversationId = created.conversation._id;
    assert.equal((await req(0,`/api/conversations/${conversationId}/preferences`,'PATCH',{ pinned:true,muted:true })).status,200);
    assert.equal((await req(0,'/api/conversations')).conversations.find(c => c._id === conversationId).preferences.pinned,true);
    assert.equal((await req(2,`/api/conversations/${conversationId}/preferences`,'PATCH',{ pinned:true })).status,403);
    const sent = await req(0,`/api/conversations/${conversationId}/messages`,'POST',{ type:'text',text:'Before reconnect',idempotencyKey:'state-test-001' });
    await req(0,`/api/conversations/messages/${sent.message._id}`,'PATCH',{ text:'Edited while offline' });
    const recovered = await req(1,`/api/conversations/${conversationId}/messages/state`,'POST',{ ids:[sent.message._id] }); assert.equal(recovered.messages[0].text,'Edited while offline');
    assert.equal((await req(2,`/api/conversations/${conversationId}/messages/state`,'POST',{ ids:[sent.message._id] })).status,403);
    assert.equal((await req(2,`/api/conversations/${conversationId}/calls`)).status,403);
    await req(0,`/api/conversations/messages/${sent.message._id}`,'DELETE');
    assert.equal((await req(1,`/api/conversations/${conversationId}/messages/state`,'POST',{ ids:[sent.message._id] })).messages[0].deleted,true);
  });
  test('media-purpose tokens cannot authenticate sockets; call policy rejects valid online callers', async () => {
    const { io: client } = require('socket.io-client');
    const signed = (await req(0,`/api/posts/${post._id}`)).post.imageUrl;
    const media = new URL(base+signed).searchParams.get('media');
    const rejected = client(base,{ auth:{ token:media },transports:['websocket'],reconnection:false });
    try { const error = await new Promise((resolve,reject) => { const timer=setTimeout(() => reject(new Error('No auth rejection')),2000); rejected.once('connect_error',error => {clearTimeout(timer);resolve(error);}); }); assert.match(error.message,/Authentication/); } finally {rejected.disconnect();}
    const a = client(base,{ auth:{ token:tokens[0],messenger:true },transports:['websocket'],reconnection:false }); const b = client(base,{ auth:{ token:tokens[1],messenger:true },transports:['websocket'],reconnection:false });
    try {
      await Promise.all([new Promise(resolve => a.once('connect',resolve)),new Promise(resolve => b.once('connect',resolve))]);
      const conv = (await req(0,'/api/conversations','POST',{recipientId:people[1].id})).conversation;
      await req(1,'/api/settings','PATCH',{calls:'nobody'});
      const result = await new Promise((resolve,reject) => a.timeout(2000).emit('call:invite',{ conversationId:conv._id,recipientId:people[1].id,callType:'audio' },(error,data) => error ? reject(error):resolve(data)));
      assert.ok(result.error);
      await req(1,'/api/settings','PATCH',{calls:'everyone'});
    } finally {a.disconnect();b.disconnect();}
  });
  test('administrator review is explicit and expired story cleanup removes files', async () => {
    process.env.ADMIN_USER_IDS=people[0].id;
    assert.equal((await req(0,'/api/settings')).isAdmin,true);
    const reports = await req(0,'/api/admin/reports'); assert.ok(reports.reports.length);
    assert.equal((await req(0,`/api/admin/reports/${reports.reports[0]._id}`,'PATCH',{status:'reviewing'})).report.status,'reviewing');
    assert.equal((await req(0,'/api/admin/deletion-requests')).status,200);
    const expired = await Story.findById(story._id); const filename = require('../utils/media').privatePath(expired.filename);
    await require('../routes/community').cleanupStories();
    assert.equal(await Story.findById(story._id),null);
    await assert.rejects(fs.access(filename));
    delete process.env.ADMIN_USER_IDS;
  });

  test('Circle text conversations persist, deduplicate and reject outsiders after removal', async () => {
    const key = 'circle-message-0001';
    const sent = await Promise.all([req(1,`/api/spaces/${circle._id}/discussion`,'POST',{ text:'Hello Circle',idempotencyKey:key }),req(1,`/api/spaces/${circle._id}/discussion`,'POST',{ text:'Hello Circle',idempotencyKey:key })]);
    assert.deepEqual(sent.map(r => r.status).sort(),[200,201]);
    const messages = await req(0,`/api/spaces/${circle._id}/discussion`); assert.equal(messages.messages.filter(m => m.idempotencyKey === key).length,1);
    assert.equal((await req(2,`/api/spaces/${circle._id}/discussion`)).status,403);
    await req(0,`/api/spaces/${circle._id}/members/${people[1].id}`,'DELETE');
    assert.equal((await req(1,`/api/spaces/${circle._id}/discussion`)).status,403);
    assert.equal((await req(1,`/api/spaces/${circle._id}/discussion`,'POST',{text:'removed',idempotencyKey:'removed-msg-001'})).status,403);
  });
  test('expired tokens, malformed IDs, pin ownership and role validation fail safely', async () => {
    const token = jwt.sign({ sub:people[0].id },process.env.JWT_SECRET,{ expiresIn:-1 });
    assert.equal((await fetch(base+'/api/users/me',{ headers:{ Authorization:`Bearer ${token}` } })).status,401);
    assert.equal((await req(1,'/api/collections/not-an-id')).status,400);
    assert.equal((await req(1,'/api/profile/pins','POST',{postId:post._id})).status,403);
    assert.equal((await req(0,'/api/profile/pins','POST',{postId:post._id})).status,200);
    assert.equal((await req(0,`/api/spaces/${circle._id}/members`,'POST',{username:people[1].username,role:'owner'})).status,400);
    assert.equal((await req(1,'/api/users/search?q=' + encodeURIComponent('['.repeat(40)))).status,200);
  });

  test('blocking also filters shared-space photos and protects their media links', async () => {
    const row = await require('../models/SpaceItem').findOne({ space:circle._id,author:people[1]._id });
    const link = require('../utils/media').signedUrl(`/api/spaces/${circle._id}/items/${row._id}/media`,people[0]._id);
    await require('../models/Block').create({owner:people[0]._id,target:people[1]._id});
    assert.ok(!(await req(0,`/api/spaces/${circle._id}`)).items.some(i => i._id === row.id));
    assert.equal((await fetch(base+link)).status,403);
    await require('../models/Block').deleteOne({owner:people[0]._id,target:people[1]._id});
  });

  test('AI provider contract returns bounded suggestions without publishing (mock provider)', async () => {
    const original = global.fetch; const before = await Post.countDocuments({ author:people[0]._id });
    process.env.AI_PROVIDER_URL='https://picshare-test-provider.invalid/suggest'; process.env.AI_PROVIDER_KEY='synthetic-test-only';
    global.fetch = async (url,options) => {
      if (String(url) !== process.env.AI_PROVIDER_URL) return original(url,options);
      const payload = JSON.parse(options.body); assert.equal(payload.task,'photo_suggestions'); assert.equal(payload.image.mimeType,'image/png');
      return new Response(JSON.stringify({ caption:'A quiet place',hashtags:['#nature','invalid tag'],altText:'A test photo',categories:['nature'],mood:'peaceful' }),{ status:200,headers:{'Content-Type':'application/json'} });
    };
    try { const result = await req(0,'/api/ai/suggest','POST',image({ context:'Nature photo' })); assert.equal(result.status,200); assert.deepEqual(result.hashtags,['#nature']); assert.equal(result.caption,'A quiet place'); assert.equal(result.categories[0],'nature'); assert.equal(await Post.countDocuments({ author:people[0]._id }),before); }
    finally { global.fetch=original; delete process.env.AI_PROVIDER_URL; delete process.env.AI_PROVIDER_KEY; }
  });
  test('AI oversized output and provider rate-limit failures return useful fallback (mock provider)', async () => {
    const original=global.fetch; process.env.AI_PROVIDER_URL='https://picshare-test-provider.invalid/suggest'; process.env.AI_PROVIDER_KEY='synthetic-test-only'; let large=true;
    global.fetch=async (url,options) => String(url) !== process.env.AI_PROVIDER_URL ? original(url,options) : large ? new Response('x'.repeat(20000),{status:200}) : new Response('{}',{status:429});
    try { assert.equal((await req(0,'/api/ai/suggest','POST',image())).status,503); large=false; assert.equal((await req(0,'/api/ai/suggest','POST',image())).status,503); }
    finally {global.fetch=original;delete process.env.AI_PROVIDER_URL;delete process.env.AI_PROVIDER_KEY;}
  });

}
