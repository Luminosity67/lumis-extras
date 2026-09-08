const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

// Execute the actual userscript capture and render paths in isolated realms.
// No network, game installation, or global changes in the test runner.
const source = fs.readFileSync(process.env.LUMI_TEST_SOURCE ||
  path.join(__dirname, '../lumis-extras.user.js'), 'utf8');
function fn(name) {
  const start = source.search(new RegExp('^  (?:async )?function ' + name + '\\(', 'm'));
  assert.notEqual(start, -1, name + ' exists');
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
function setup({separatePage = false} = {}) {
  const clock = {now: 1000};
  const timeouts = [], intervals = [], calls = [], failures = [];
  const c = vm.createContext({
    performance: {now: () => clock.now},
    setTimeout: (cb, delay) => timeouts.push({cb, delay}),
    setInterval: (cb, delay) => intervals.push({cb, delay}),
    renderers: [], overlays: new Map(),
    framePerfSince: 0, framePerfCalls: 0, framePerfRuns: 0,
    lastFrameWork: -Infinity, lastHpWork: -Infinity, lastPartyWork: -Infinity,
    lastArenaWork: -Infinity, lastOverlayWork: -Infinity, lastSweep: -Infinity,
    FRAME_WORK_MIN_MS: 12, HP_WORK_MIN_MS: 30, PARTY_WORK_MIN_MS: 30,
    SCENE_SWEEP_MIN_MS: 500, ARENA_SKY_WORK_MIN_MS: 60, OVERLAY_WORK_MIN_MS: 15,
    sceneSweepNeeded: () => false, hpWorkNeeded: () => true,
    partyWorkNeeded: () => true, arenaSkyWorkNeeded: () => false,
    boostPlace() {}, hpTick: () => calls.push('hp'), zorderApply() {}, nameReconcile() {},
    partyTick: stage => calls.push(['party', stage]), layoutPixiTick() {},
    arenaDuelTick() {}, boostTick() {}, frameFailed: (...args) => failures.push(args),
    record: (...args) => calls.push(args),
  });
  vm.runInContext('var PAGE = globalThis; const nativeBind = Function.prototype.bind;', c);
  if (separatePage) {
    const page = vm.createContext({});
    c.PAGE = vm.runInContext('globalThis', page);
  }
  // Old source has no local ownership map; supplying it does not alter its code.
  vm.runInContext('const rendererHooks = new WeakMap();', c);
  vm.runInContext(fn('hookRenderer'), c);
  const start = source.indexOf('  const gameCapture = {');
  const end = source.indexOf('  // What Pixi ACTUALLY built', start);
  vm.runInContext(source.slice(start, end), c);
  function run(code) { return vm.runInContext(code, c); }
  function expireStartup() {
    clock.now = 25000;
    for (const timer of timeouts) if (timer.delay === 20000) timer.cb();
    assert.equal(run('gameCapture.stoodDown'), true);
  }
  function loop(type = 4) {
    run(`var loop = {
      canvas: {tagName: 'CANVAS'}, stage: {children: []},
      world: {children: []}, HUD: {children: []},
      renderer: {type: ${type}, render(arg) { record('native', this === loop.renderer, arg); return 42; }},
      render() { return this.renderer.render(this.stage); }
    };`);
  }
  return {c, run, clock, calls, failures, intervals, expireStartup, loop};
}

for (const [name, type] of [['Canvas', 4], ['WebGL', 1], ['WebGPU', 2]]) {
  test(name + ': a running frame recovers after the 20-second startup trap expired', () => {
    const h = setup();
    h.expireStartup();
    h.loop(type);
    assert.equal(h.run('loop.render.bind(loop)()'), 42);
    assert.equal(h.run('renderers.length'), 1);
    assert.equal(h.run('gameCapture.loop === loop'), true);
    assert.equal(h.run('gameCapture.game'), null, 'late recovery does not invent a game model');
    assert.equal(h.calls.filter(x => Array.isArray(x) && x[0] === 'party').length, 1);
    assert.ok(h.calls.includes('hp'));
    assert.equal(h.failures.length, 0);
    assert.equal(h.run('Function.prototype.bind === nativeBind'), true, 'probe uninstalls');
  });
}

test('probe catches an already-created loop on its next bind', () => {
  const h = setup();
  h.run('gameStopLoopProbe()');
  h.loop();
  h.run('gameInstallLoopProbe(); loop.render.bind(loop)()');
  assert.equal(h.run('gameCapture.loopProbeHits'), 1);
  assert.equal(h.run('gameCapture.loopProbeInstalled'), false);
});

test('normal early game capture still hooks an asynchronously assigned renderer', () => {
  const h = setup();
  h.run(`var earlyLoop = {stage: {children: []}, canvas: {tagName: 'CANVAS'}};
    var game = {animalStats: {resource: {}}, loop: earlyLoop, settings: {}, camera: {}, classes: {}};
    game.closestObjects = {};
    earlyLoop.renderer = {render() { return 7; }};`);
  assert.equal(h.run('gameCapture.game === game'), true);
  assert.equal(h.run('gameCapture.loop === earlyLoop'), true);
  assert.equal(h.run('renderers.length'), 1);
  assert.equal(h.run('Function.prototype.bind === nativeBind'), true);
  assert.equal(h.run("Object.hasOwn(Object.prototype, 'closestObjects')"), false);
});

test('foreign renderer flags do not disable this userscript', () => {
  const h = setup();
  h.loop();
  h.run('loop.renderer.__mncHooked = true; hookRenderer(loop.renderer); loop.render()');
  assert.equal(h.run('renderers.length'), 1);
  assert.equal(h.calls.filter(x => Array.isArray(x) && x[0] === 'party').length, 1);
});

test('watchdog repairs replacement and chained wrappers without duplicate feature work', () => {
  const h = setup();
  h.loop();
  h.run('loop.render.bind(loop)()');
  h.clock.now += 100;
  h.run(`var firstWrapper = loop.renderer.render;
    loop.renderer.render = function(arg) { record('foreign'); return firstWrapper.call(this, arg); };`);
  const repair = h.intervals.find(t => t.delay === 2000);
  assert.ok(repair);
  repair.cb();
  h.run('loop.render()');
  assert.equal(h.run('renderers.length'), 1);
  assert.equal(h.run('framePerfCalls'), 2);
  assert.equal(h.calls.filter(x => Array.isArray(x) && x[0] === 'native').length, 2);
  assert.equal(h.calls.filter(x => Array.isArray(x) && x[0] === 'party').length, 2);
  assert.equal(h.run('gameCapture.repairs'), 1);
  repair.cb();
  assert.equal(h.run('gameCapture.repairs'), 1, 'unchanged hooks are not stacked');
  h.run('loop.renderer = {render() { return 99; }}');
  repair.cb();
  h.clock.now += 100;
  assert.equal(h.run('loop.render()'), 99);
  assert.equal(h.run('gameCapture.repairs'), 2);
});

test('probe preserves native bind arguments, constructors, errors, and unrelated bindings', () => {
  const h = setup();
  assert.equal(h.run('(function(a, b) { return this.x + a + b; }).bind({x: 1}, 2)(3)'), 6);
  assert.equal(h.run('function C(x) { this.x = x; } var Bound = C.bind(null, 8); new Bound().x'), 8);
  assert.equal(h.run('new Bound() instanceof C'), true);
  assert.equal(h.run('(() => { try { Function.prototype.bind.call({}); } catch(e) { return e.name; } })()'), 'TypeError');
  h.run('var unrelated = {render() {}, stage: {children: []}}; unrelated.render.bind(unrelated)');
  assert.equal(h.run('renderers.length'), 0);
  assert.equal(h.run('gameCapture.loopProbeHits'), 0);
});

test('page and userscript realms are restored after page-side recovery', () => {
  const h = setup({separatePage: true});
  h.loop();
  h.run('PAGE.Function.prototype.bind.call(loop.render, loop)()');
  assert.equal(h.run('gameCapture.loop === loop'), true);
  assert.equal(h.run('Function.prototype.bind === nativeBind'), true);
  assert.equal(h.run('gameLoopProbes.length'), 0);
});

test('cleanup leaves a later third-party bind wrapper in place', () => {
  const h = setup();
  h.loop();
  h.run(`var probe = Function.prototype.bind;
    var foreignBind = function() { return Reflect.apply(probe, this, arguments); };
    Function.prototype.bind = foreignBind;
    loop.render.bind(loop)();`);
  assert.equal(h.run('Function.prototype.bind === foreignBind'), true);
  assert.equal(h.run('gameCapture.loopProbeInstalled'), false);
  assert.equal(h.run('(function(x) {return x;}).bind(null, 9)()'), 9);
});

test('failed attachment cannot throw through native bind or claim a renderer', () => {
  const h = setup();
  h.loop();
  h.run("Object.defineProperty(loop.renderer, 'render', {writable: false}); loop.render.bind(loop)()");
  assert.equal(h.run('renderers.length'), 0);
  assert.equal(h.run('rendererHooks.has(loop.renderer)'), false);
  assert.equal(h.run('gameCapture.loopProbeInstalled'), true);
});

test('a feature error cannot prevent the party frame or native game draw', () => {
  const h = setup();
  h.loop();
  h.c.hpTick = () => { throw Error('HP fixture failure'); };
  assert.equal(h.run('loop.render.bind(loop)()'), 42);
  assert.equal(h.failures[0][0], 'HP');
  assert.equal(h.calls.filter(x => Array.isArray(x) && x[0] === 'party').length, 1);
});

test('render arguments, receiver, return value and native errors survive wrapping', () => {
  const h = setup();
  h.run(`var renderer = {render(a, b) { return this === renderer ? a + b : -1; }};
    hookRenderer(renderer);`);
  assert.equal(h.run('renderer.render(3, 4)'), 7);
  h.run('var broken = {render() { throw Error("native failure"); }}; hookRenderer(broken)');
  assert.throws(() => h.run('broken.render()'), /native failure/);
});

test('ownership and layer reconciliation run even between throttled feature frames', () => {
  const h = setup();
  let names = 0, layers = 0;
  h.c.nameReconcile = () => names++;
  h.c.zorderApply = () => layers++;
  h.loop();
  h.run('loop.render.bind(loop)()');
  h.clock.now += 1;
  h.run('loop.render()');
  assert.equal(names, 2);
  assert.equal(layers, 2);
  assert.equal(h.run('framePerfRuns'), 1, 'the second frame skipped paced discovery');
});

test('DOM timer draws received party members with zero renderers, then expires them', () => {
  const h = setup();
  const painted = [];
  const layer = {appendChild() {}};
  Object.assign(h.c, {
    document: {hidden: false}, settings: {}, nameColorState: {},
    prevMenuVisible: false, PARTY_LIST_MIN_MS: 250, PARTY_LIST_GAP_DVMIN: 1,
    PARTY_STALE_MS: 5000, PARTY_DROP_MS: 15000,
    party: {peers: new Map([['friend', {id: 'friend', name: 'Friend', hp: 100, at: 1000}]]),
      listAt: 0, listRows: new Map(), listOrder: ''},
    partyListOn: () => true, partyListHide: () => painted.push('hidden'),
    partyDestroyPeer() {}, partyListAnchor: () => ({width: 200, left: 0, top: 0}),
    partyListLayer: () => layer, layoutVmin: () => 1, layoutStyle() {},
    partyListApplyBox() {}, layoutPlace() {}, partyListRow: () => ({}),
    partyListPaint: (row, member) => painted.push(member),
  });
  for (const name of ['ensureExtrasUI', 'startDomObserver', 'startClutterLoop',
    'applyAbilityCooldown', 'applyHpNumbers', 'applyArenaSky', 'applyCluttersIfEnabled',
    'layoutSyncMope', 'registerMenu', 'dbg', 'trackTexts', 'positionExtrasBtn',
    'statsTick', 'layoutTick', 'waterTick']) h.c[name] = () => {};
  h.run(fn('partyListMembers'));
  h.run(fn('partyListTick'));
  h.run(fn('onReady'));
  h.run('onReady()');
  const timer = h.intervals.find(t => t.delay === 250);
  assert.ok(timer);
  timer.cb();
  assert.equal(h.run('renderers.length'), 0);
  assert.equal(painted[0].name, 'Friend');
  assert.equal(painted[0].hp, 100);
  h.clock.now = 17000;
  timer.cb();
  assert.equal(h.c.party.peers.size, 0);
  assert.equal(painted.at(-1), 'hidden');
});
