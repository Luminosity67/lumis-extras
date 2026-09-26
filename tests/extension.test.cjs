const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(process.env.LUMI_TEST_SOURCE || path.join(root, 'lumis-extras.user.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

// The extension exists to run BEFORE mope's code, so these are not style
// preferences: each one, if it drifted, would bring the mis-hooks back.
test('manifest runs the userscript file itself, in the page, at document_start', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.content_scripts.length, 1);
  const cs = manifest.content_scripts[0];
  assert.deepEqual(cs.js, ['lumis-extras.user.js'], 'one file for both installs, no copy');
  assert.equal(cs.world, 'MAIN', 'the hooks must be on the page\'s own objects');
  assert.equal(cs.run_at, 'document_start', 'the hooks must be armed before mope builds its game');
  assert.equal(cs.all_frames, false, 'matches the userscript\'s @noframes');
  assert.deepEqual(cs.matches, ['*://mope.io/*', '*://*.mope.io/*']);
  // world: MAIN arrived in Chrome 111.
  assert.ok(Number(manifest.minimum_chrome_version) >= 111);
});

test('manifest version, userscript metadata and fallback literal all agree', () => {
  const meta = source.match(/\/\/ @version\s+(\S+)/)[1];
  assert.equal(manifest.version, meta);
  assert.match(source, new RegExp("return '" + meta.replaceAll('.', '\\.') + "';"));
});

test('the extension asks for no permissions at all', () => {
  // Everything it stores is page localStorage, and it talks to nothing the
  // page could not. Adding a permission is a store-review event and should be
  // a deliberate change to this test, not a side effect.
  assert.equal(manifest.permissions, undefined);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);
});

test('store-facing fields fit Chrome Web Store limits', () => {
  assert.ok(manifest.name.length <= 75);
  assert.ok(manifest.description.length <= 132, 'description is ' + manifest.description.length + ' chars');
});

test('every declared icon exists and is the size it claims', () => {
  for (const [size, file] of Object.entries(manifest.icons)) {
    const png = fs.readFileSync(path.join(root, file));
    assert.equal(png.toString('latin1', 1, 4), 'PNG', file + ' is a PNG');
    assert.equal(png.readUInt32BE(16), Number(size), file + ' width');
    assert.equal(png.readUInt32BE(20), Number(size), file + ' height');
  }
});

// The stand-down block, run on its own. Everything from the first line of the
// IIFE to the line that announces the script on the page, wrapped so that
// falling through returns 'continued' and standing down returns undefined.
function runPreamble(globals) {
  const start = source.indexOf("  const PAGE = (typeof unsafeWindow");
  const end = source.indexOf('  try { PAGE.__LUMI_EXTRAS_V1_RUNNING__ = true; }');
  assert.ok(start > 0 && end > start, 'preamble found before the page announcement');
  const warnings = [];
  const ctx = vm.createContext({console: {warn: (...a) => warnings.push(a.join(' '))}, ...globals});
  ctx.window = ctx;
  const result = vm.runInContext('(function () {\n' + source.slice(start, end) + "\nreturn 'continued'; })()", ctx);
  return {result, warnings};
}

test('a userscript copy stands down when the extension is already on the page', () => {
  const r = runPreamble({GM_info: {}, __lumiExtrasInstances: [{version: '1.0.24', via: 'extension'}]});
  assert.equal(r.result, undefined);
  assert.match(r.warnings[0], /standing down/);
});

test('positive controls: the userscript alone, and the extension, both carry on', () => {
  assert.equal(runPreamble({GM_info: {}}).result, 'continued');
  assert.equal(runPreamble({GM_info: {}, __lumiExtrasInstances: [{via: 'userscript'}]}).result, 'continued');
  // No GM_info is how the extension recognises itself; it never stands down.
  const ext = runPreamble({__lumiExtrasInstances: [{via: 'userscript'}]});
  assert.equal(ext.result, 'continued');
  assert.equal(ext.warnings.length, 0);
});

function fn(name) {
  const start = source.search(new RegExp('^  function ' + name + '\\(', 'm'));
  assert.notEqual(start, -1, name + ' exists');
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}

test('update check compares 1.x.y versions numerically', () => {
  const newer = vm.runInNewContext(fn('qolcVersionNewer') + '; qolcVersionNewer');
  assert.equal(newer('1.0.26', '1.0.25'), true);
  assert.equal(newer('1.0.10', '1.0.9'), true, 'numeric, not string, order');
  assert.equal(newer('1.1.0', '1.0.99'), true);
  assert.equal(newer('1.0.25', '1.0.25'), false);
  assert.equal(newer('1.0.24', '1.0.25'), false, 'an older release is never offered');
  assert.equal(newer('1.0', '1.0.0'), false);
});

test('hook record summary counts only this install\'s games and flags any guess', () => {
  const summary = vm.runInNewContext(fn('hookSummary') + '; hookSummary');
  const good = {via: 'extension', game: true, renderer: 'game loop', camera: 'syncZoom', lock: 'game'};
  assert.match(summary([], 'extension'), /Nothing recorded/);
  assert.match(summary([good, good], 'extension'), /^All clean\. Last 2 games: game 2\/2, renderer 2\/2, camera 2\/2, player guessed in 0\./);
  const missed = {...good, game: false, lock: 'guessed'};
  const s = summary([good, missed, {...missed, via: 'userscript'}], 'extension');
  assert.doesNotMatch(s, /All clean/);
  assert.match(s, /Last 2 games: game 1\/2, .*player guessed in 1\./, 'the userscript line is not counted');
});
