const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
(async () => {
  const origin = process.env.PICSHARE_BACKEND_URL || 'https://picshare-5qf9.onrender.com';
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('PICSHARE_BACKEND_URL must be an HTTPS origin without credentials or a path.');
  const root = path.resolve(__dirname, '..');
  const out = path.join(root, 'mobile/www');
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(path.join(root, 'frontend'), out, { recursive: true });
  fs.appendFileSync(path.join(out, 'js/config.js'), `\nwindow.PICSHARE_API_URL=${JSON.stringify(url.origin + '/api')};\nwindow.PICSHARE_IOS_GOOGLE_CLIENT_ID=${JSON.stringify(process.env.PICSHARE_IOS_GOOGLE_CLIENT_ID || '')};\n`);
  await esbuild.build({ entryPoints: [path.join(root, 'mobile/native.js')], bundle: true, format: 'iife', outfile: path.join(out, 'js/native.js'), target: ['es2022'] });
  // Inject the native bridge before the API and application scripts.
  for (const name of fs.readdirSync(out).filter(n => n.endsWith('.html'))) {
    const file = path.join(out, name);
    let html = fs.readFileSync(file, 'utf8').replace('<script src="js/api.js"', '<script src="js/native.js" defer></script><script src="js/api.js"');
    fs.writeFileSync(file, html);
  }
  console.log('Bundled PicShare mobile assets for ' + url.origin);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
