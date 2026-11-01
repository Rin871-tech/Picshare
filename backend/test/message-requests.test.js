const test = require('node:test'); const assert = require('node:assert/strict');
if (!process.env.TEST_MONGODB_URI) test('Message requests require disposable MongoDB', { skip: true }, () => {});
else {
const express = require('express'), http = require('http'), mongoose = require('mongoose'), jwt = require('jsonwebtoken');
const { Server } = require('socket.io'), { io: client } = require('socket.io-client');
const User = require('../models/User'), Conversation = require('../models/Conversation'), Message = require('../models/Message'), Block = require('../models/Block');
process.env.JWT_SECRET = 'isolated-request-test-secret-at-least-32-characters';
let server, io, base, people, tokens, id, first, application;
const sockets = [];
async function req(who, path, method='GET', body) { const response = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(who !== null ? { Authorization: 'Bearer ' + tokens[who] } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, ...await response.json().catch(() => ({})) }; }
const send = (who, conv, key, text='Hello 👋') => req(who, `/conversations/${conv}/messages`, 'POST', { type:'text', text, idempotencyKey:key });
const ack = (socket, event, body) => new Promise((resolve, reject) => socket.timeout(2000).emit(event, body, (err, result) => err ? reject(err) : resolve(result)));
async function connect(who) { const socket = client(base, { auth: { token:tokens[who], messenger:true }, transports:['websocket'], reconnection:false }); sockets.push(socket); await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); }); return socket; }
test.before(async () => {
 await mongoose.connect(process.env.TEST_MONGODB_URI); await Promise.all([User.init(),Conversation.init(),Message.init(),Block.init()]);
 const stamp=Date.now(); people=await User.create(['a','b','c','d','e'].map(letter=>({username:`req_${letter}_${stamp}`,name:letter,email:`${letter}_${stamp}@requests.test`,passwordHash:'test'}))); tokens=people.map(u=>jwt.sign({sub:u.id},process.env.JWT_SECRET,{expiresIn:'1h'}));
 const app=express(); application=app; server=http.createServer(app); io=new Server(server); app.set('io',io); require('../socketHandler')(io); app.use(express.json()); app.use('/api/conversations', require('../routes/conversations')); app.use('/api/locations', require('../routes/locations')); app.use('/api/push', require('../routes/push')); app.use((err,req,res,next)=>res.status(err.status||500).json({error:err.message})); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); base=`http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { sockets.forEach(s=>s.disconnect()); await new Promise(resolve=>io.close(resolve)); const ids=people.map(p=>p._id); const conversations=await Conversation.find({participants:{$in:ids}}); await Message.deleteMany({conversation:{$in:conversations.map(c=>c._id)}}); await Conversation.deleteMany({participants:{$in:ids}}); await Block.deleteMany({owner:{$in:ids}}); await require('../models/Notification').deleteMany({recipient:{$in:ids}}); await require('../models/PushSubscription').deleteMany({user:{$in:ids}}); await User.deleteMany({_id:{$in:ids}}); await mongoose.disconnect(); });
test('stranger request is unique, limited to one atomic introduction and separate from inbox', async()=>{
 const created=await Promise.all([req(0,'/conversations','POST',{recipientId:people[1].id}),req(0,'/conversations','POST',{recipientId:people[1].id})]); id=created[0].conversation._id; assert.equal(id,created[1].conversation._id); assert.equal(created[0].conversation.requestStatus,'pending');
 const messages=await Promise.all([send(0,id,'request-intro-001'),send(0,id,'request-intro-002')]); assert.deepEqual(messages.map(m=>m.status).sort(),[201,409]); first=messages.find(m=>m.status===201).message;
 assert.equal((await req(1,'/conversations')).conversations.length,0); assert.equal((await req(1,'/conversations?section=requests')).conversations[0]._id,id);
 assert.equal((await send(0,id,first.idempotencyKey)).duplicate,true); assert.equal((await send(1,id,'pending-reply-001')).status,409);
 assert.equal((await req(0,`/conversations/${id}/attachments`,'POST',{})).status,409);
 assert.equal((await req(0,'/locations/live','POST',{conversationId:id,durationMinutes:15})).status,409);
});
test('pending request previews never emit delivery, read, typing, calls or presence receipts',async()=>{
 const sender=await connect(0), recipient=await connect(1); const leakedPresence=[]; sender.on('presence:offline', data=>leakedPresence.push(data));
 await req(1,'/conversations/settings','PATCH',{presence:false,lastSeen:false}); await new Promise(resolve=>setTimeout(resolve,30)); assert.equal(leakedPresence.length,0); await req(1,'/conversations/settings','PATCH',{presence:true});
 assert.equal((await ack(recipient,'conversation:join',{conversationId:id})).ok,true);
 assert.ok((await ack(recipient,'typing:start',{conversationId:id})).error); assert.ok((await ack(recipient,'message:received',{conversationId:id,messageId:first._id})).error);
 assert.ok((await ack(sender,'call:invite',{conversationId:id,recipientId:people[1].id,callType:'audio'})).error);
 assert.equal((await req(1,`/conversations/${id}/messages`)).status,200); assert.equal((await req(1,`/conversations/${id}/read`,'PATCH',{through:first._id})).status,409);
 assert.equal((await Message.findById(first._id)).deliveryState,'sent'); assert.equal((await req(2,`/conversations/${id}/messages`)).status,403); assert.equal((await req(0,`/conversations/${id}/request/accept`,'POST',{})).status,403);
});
test('acceptance enables offline fetch delivery, accurate read timestamps, missed synchronization and replies',async()=>{
 assert.equal((await req(1,`/conversations/${id}/request/accept`,'POST',{})).status,200); assert.equal((await req(1,'/conversations?section=requests')).conversations.length,0); assert.equal((await req(1,'/conversations')).conversations[0]._id,id);
 sockets.forEach(s=>s.disconnect());
 const offline=await send(0,id,'offline-after-accept'); assert.equal(offline.status,201); assert.equal((await Message.findById(offline.message._id)).deliveryState,'sent');
 const fetched=await req(1,`/conversations/${id}/messages?after=${first._id}`); assert.equal(fetched.messages[0]._id,offline.message._id); assert.equal(fetched.messages[0].deliveryState,'delivered'); const delivered=(await Message.findById(offline.message._id)).deliveredAt;
 assert.equal((await req(1,`/conversations/${id}/read`,'PATCH',{through:offline.message._id})).status,200); const read=await Message.findById(offline.message._id); assert.equal(read.deliveryState,'read'); assert.equal(+read.deliveredAt,+delivered); assert.ok(read.readAt);
 assert.equal((await send(1,id,'offline-recipient-reply','Reply after returning')).status,201);
 assert.equal((await req(0,`/conversations/${id}/messages`)).messages.at(-1).text,'Reply after returning');
 assert.equal((await send(0,id,'offline-after-accept')).duplicate,true);
});
test('saved conversations and messages survive a server restart', async()=>{
  sockets.forEach(socket=>socket.disconnect()); await new Promise(resolve=>io.close(resolve));
  server=http.createServer(application); io=new Server(server); application.set('io',io); require('../socketHandler')(io);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); base=`http://127.0.0.1:${server.address().port}`;
  const history=await req(1,`/conversations/${id}/messages`); assert.equal(history.status,200); assert.ok(history.messages.some(m=>m.text==='Reply after returning'));
  assert.equal((await send(1,id,'reply-after-restart','Still here after server restart')).status,201);
});
test('archive is personal and reversible; legacy documents remain accepted',async()=>{
 assert.equal((await req(0,`/conversations/${id}/preferences`,'PATCH',{archived:true})).status,200); assert.equal((await req(0,'/conversations')).conversations.length,0); assert.equal((await req(0,'/conversations?section=archived')).conversations[0]._id,id); assert.equal((await req(1,'/conversations')).conversations.length,1);
 await req(0,`/conversations/${id}/preferences`,'PATCH',{archived:false});
 const legacy=await Conversation.create({participants:[people[2]._id,people[3]._id],participantKey:[people[2].id,people[3].id].sort().join('_')}); await Conversation.collection.updateOne({_id:legacy._id},{$unset:{requestStatus:''}});
 assert.equal((await send(2,legacy.id,'legacy-still-accepted')).status,201);
});
test('decline and block stop new messages; request policies and authorization are enforced',async()=>{
 const {conversation}=await req(0,'/conversations','POST',{recipientId:people[4].id}); await send(0,conversation._id,'decline-introduction');
 assert.equal((await req(4,`/conversations/${conversation._id}/request/decline`,'POST',{})).status,200); assert.equal((await send(0,conversation._id,'declined-send-again')).status,409); assert.equal((await req(4,`/conversations/${conversation._id}/request/accept`,'POST',{})).status,409);
 await req(4,`/conversations/${conversation._id}/request/block`,'POST',{}); assert.equal((await send(0,conversation._id,'blocked-send-again')).status,403); assert.equal((await req(0,`/conversations/${conversation._id}/messages`)).status,403);
 await req(4,'/conversations/settings','PATCH',{messages:'nobody'}); assert.equal((await req(2,'/conversations','POST',{recipientId:people[4].id})).status,403);
 assert.equal((await req(null,'/conversations')).status,401); assert.equal((await req(2,`/conversations/${id}/request/decline`,'POST',{})).status,403);
});
test('push preparation encrypts subscriptions, validates endpoints, and supports revocation',async()=>{
 assert.equal((await req(0,'/push/subscriptions','POST',{endpoint:'http://127.0.0.1/private',keys:{}})).status,400);
 const sub=await req(0,'/push/subscriptions','POST',{endpoint:'https://fcm.googleapis.com/fcm/send/synthetic-test-only',keys:{auth:'a'.repeat(22),p256dh:'b'.repeat(87)}}); assert.equal(sub.status,201); assert.equal(sub.deliveryEnabled,false);
 const stored=await require('../models/PushSubscription').findOne({user:people[0]._id}).select('+encrypted'); assert.ok(stored.encrypted); assert.ok(!stored.encrypted.includes('fcm.googleapis.com'));
 assert.equal((await req(0,'/push/subscriptions','DELETE')).status,200); assert.equal(await require('../models/PushSubscription').countDocuments({user:people[0]._id}),0);
});
test('presence and last-seen respect accepted-conversation privacy', async()=>{
  const peer=await connect(1);
  assert.equal((await req(0,'/conversations')).conversations.find(c=>c._id===id).online,true);
  await req(1,'/conversations/settings','PATCH',{presence:false,lastSeen:false});
  const hidden=(await req(0,'/conversations')).conversations.find(c=>c._id===id); assert.equal(hidden.online,false); assert.equal(hidden.lastSeenAt,undefined);
  peer.disconnect();
});

}
