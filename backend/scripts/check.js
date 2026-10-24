const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
let count = 0;
function walk(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (['node_modules', 'uploads', 'uploads-private', '.git'].includes(entry.name)) continue;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (file.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
      if (result.status) process.exit(result.status);
      count++;
    }
  }
}
walk(path.join(__dirname, '..'));
walk(path.join(__dirname, '..', '..', 'frontend', 'js'));
console.log(`Syntax checked ${count} JavaScript files.`);
