const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const http = require('node:http');
test('production message images require private cloud configuration and remove staging files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'picshare-storage-test-'));
  const file = { path: path.join(directory, 'test.png'), filename:'test.png', mimetype:'image/png' };
  const original = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  const saved = {}; for (const key of ['MESSAGE_S3_BUCKET','MESSAGE_S3_ACCESS_KEY_ID','MESSAGE_S3_SECRET_ACCESS_KEY']) { saved[key] = process.env[key]; delete process.env[key]; }
  await fs.writeFile(file.path, 'synthetic-image');
  try { await assert.rejects(require('../utils/messageStorage').save(file), error => error.status === 503); await assert.rejects(fs.access(file.path)); }
  finally { for (const [key,value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original; await fs.rm(directory, {recursive:true,force:true}); }
});
test('S3-compatible adapter uploads privately and retrieves through backend streaming (local mock service)', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'picshare-s3-test-'));
  let uploaded = false, retrieved = false;
  const server = http.createServer((req,res) => { if (req.method === 'PUT') { assert.equal(req.headers['x-amz-acl'],undefined); assert.equal(req.headers['cache-control'],'private, no-store'); req.resume(); req.on('end',()=>{ uploaded=true; res.end(); }); } else { retrieved=true; res.setHeader('content-type','image/png'); res.end('synthetic-image'); } });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const saved={}; const env={ MESSAGE_S3_BUCKET:'private-test-bucket', MESSAGE_S3_ACCESS_KEY_ID:'synthetic-access-key', MESSAGE_S3_SECRET_ACCESS_KEY:'synthetic-secret-only', MESSAGE_S3_REGION:'us-east-1', MESSAGE_S3_ENDPOINT:`http://127.0.0.1:${server.address().port}` };
  for(const [key,value] of Object.entries(env)){saved[key]=process.env[key];process.env[key]=value;}
  const file={path:path.join(directory,'test.png'),filename:'test.png',mimetype:'image/png'}; await fs.writeFile(file.path,'synthetic-image');
  const adapter=require('../utils/messageStorage');
  try { const stored=await adapter.save(file); assert.equal(stored.storage,'s3'); assert.ok(uploaded); await assert.rejects(fs.access(file.path));
    const stream=require('node:stream'); const output=new stream.PassThrough(); output.set=()=>{}; const chunks=[]; output.on('data',chunk=>chunks.push(chunk)); await adapter.read(stored,output); assert.ok(retrieved); assert.equal(Buffer.concat(chunks).toString(),'synthetic-image');
  } finally { await new Promise(resolve=>server.close(resolve)); for(const [key,value]of Object.entries(saved)) if(value===undefined)delete process.env[key];else process.env[key]=value; await fs.rm(directory,{recursive:true,force:true}); }
});
