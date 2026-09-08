const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const tests = fs.readdirSync(path.join(root, 'tests'))
  .filter(file => file.endsWith('.test.cjs')).sort().map(file => 'tests/' + file);
if (!tests.length) throw Error('No regression tests discovered');
for (const args of [['--check', 'lumis-extras.user.js'], ['--test', ...tests]]) {
  const result = spawnSync(process.execPath, args, {cwd: root, stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
