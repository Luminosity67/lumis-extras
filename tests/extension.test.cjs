const {test} = require('node:test');
const {assert, fs, path, vm, root, source, fn} = require('./helpers.cjs');

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

// Since 1.1.0 the script no longer has to beat mope's code to anything — the
// game bridge reads mope's modules whenever it likes — but document_start is
// still where the wheel and key listeners belong, and MAIN is the only world
// whose `import()` shares the page's module map.
test('manifest runs the userscript file itself, in the page, at document_start', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.content_scripts.length, 1);
  const cs = manifest.content_scripts[0];
  assert.deepEqual(cs.js, ['lumis-extras.user.js'], 'one file for both installs, no copy');
  assert.equal(cs.world, 'MAIN', 'import() only reaches mope\'s modules from the page\'s own world');
  assert.equal(cs.run_at, 'document_start');
  assert.equal(cs.all_frames, false, 'matches the userscript\'s @noframes');
  assert.deepEqual(cs.matches, ['*://mope.io/*', '*://*.mope.io/*']);
  assert.ok(Number(manifest.minimum_chrome_version) >= 111, 'world: MAIN arrived in Chrome 111');
});

test('manifest version, userscript metadata and fallback literal all agree', () => {
  const meta = source.match(/\/\/ @version\s+(\S+)/)[1];
  assert.equal(manifest.version, meta);
  assert.match(source, new RegExp("return '" + meta.replaceAll('.', '\\.') + "';"));
});

test('the userscript runs in the page, where import() can reach mope', () => {
  // A sandboxed userscript has its own module map, so the bridge would
  // import a SECOND copy of mope's game rather than the running one.
  assert.match(source, /^\/\/ @grant\s+none$/m);
  assert.doesNotMatch(source, /^\/\/ @grant\s+(?!none)/m, 'no other grant may sandbox it');
});

test('the extension asks for no permissions at all', () => {
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

test('none of the 1.0.x traps survive the rebuild', () => {
  // The whole point of 1.1.0. If any of these come back, the timing races
  // come back with them.
  assert.doesNotMatch(source, /defineProperty\(\s*(?:prototype|Object\.prototype|PAGE\.Object\.prototype)\s*,\s*(?:key|PROBE_KEY|'syncZoom'|'syncPosition'|'entity'|'closestObjects')/);
  assert.doesNotMatch(source, /Map\.prototype\.set\s*=|prototype\.set\s*=\s*wrapper/);
  assert.doesNotMatch(source, /PAGE\.Proxy\s*=/);
  assert.doesNotMatch(source, /__PIXI_(?:RENDERER|APP)_INIT__/);
  assert.doesNotMatch(source, /fillText.*noteXpText|function hookCanvasXp/);
});

// The stand-down block, run on its own: from the IIFE's first line to the
// line that announces the script on the page. Falling through returns
// 'continued'; standing down returns undefined.
function runPreamble(globals) {
  const start = source.indexOf('  const PAGE = window;');
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
  const ext = runPreamble({__lumiExtrasInstances: [{via: 'userscript'}]});
  assert.equal(ext.result, 'continued');
  assert.equal(ext.warnings.length, 0);
});

test('update check compares 1.x.y versions numerically', () => {
  const newer = vm.runInNewContext(fn('qolcVersionNewer') + '; qolcVersionNewer');
  assert.equal(newer('1.0.26', '1.0.25'), true);
  assert.equal(newer('1.0.10', '1.0.9'), true, 'numeric, not string, order');
  assert.equal(newer('1.1.0', '1.0.99'), true);
  assert.equal(newer('1.0.25', '1.0.25'), false);
  assert.equal(newer('1.0.24', '1.0.25'), false, 'an older release is never offered');
  assert.equal(newer('1.0', '1.0.0'), false);
});

test('the embedded stylesheet is one template literal', () => {
  // A stray backtick inside the CSS would end the literal early and take the
  // whole script down with a syntax error far from the cause.
  const body = fn('injectExtrasStyles');
  assert.equal((body.match(/`/g) || []).length, 2);
});
