// The capture hub and the bridge over it. Since mope's 2026-11-02 build the
// hub loads a copy of mope's game module that hands it a reader for the
// module's own variables; the fixture below is a game module in miniature,
// written the way mope's minifier writes it, because the hub finds several
// names at the one place in mope's code that uses them. Its text doubles as
// the module source the hub reads.
const {test} = require('node:test');
const {assert, fn, constant, run} = require('./helpers.cjs');

const pieces = ['mopeHasKeys', 'mopeIsGame', 'mopeIsAnimalStats'].map(fn);

const mope = [
  'var X=function(e){return e[e.mouse=0]=`mouse`,e[e.shrimp=1]=`shrimp`,e}({});',
  'class Table{items=new Map;get(e){return this.items.get(e)}set(e,t){return this.items.set(e,t),this}values(){return this.items.values()}}',
  'var Ts=new Table,Es={__proto__:null,animal:new Table,food:new Table};',
  'class Network{#e=[];readyState=`open`;protocol=1;latency=0;jb(e,t){return this.#e.push([e,t]),this.#e.length}sent(){return this.#e}}',
  'class Camera{zoom=1;interpolation={};target={position:{},angle:0,zoom:1}}',
  'class Animal{get outlineColor(){return this.arena?`cyan`:`grey`}Hj(e=this.outlineColor){return this.outline.tint=e,$.Ml?.Vj(this)?this.tail.tint=`green`:this.tail.tint=e,this}Vj(e){return this!==e&&this.tier===e.tier}update(){return this.angle+=1,this}}',
  'class Mouse extends Animal{type=`animal`}',
  'function bu(){}',
  'class Game{Ml;Ti;_l;Vy;colors;minimap;textureBuilder;audio;Ge;constructor(){this.Ti=new Network,this._l=new Camera,this.Vy={global:{animal:Animal},animals:{},foods:{}},this.colors={},this.minimap={},this.textureBuilder={},this.audio={},this.Ge={xp:4,oxygen:100,rank:1,resource:{value:90,max:100,type:0}}}Zc(e){return!0}key(e){this.Zc(`upgrade`,e)&&$.Ti.jb(201)}Tj(e){this.Ml=e,bu(`first_spawn`)}}',
  'function spawn(i){return Ts.get(i.id)?.destroy(!0),Ts.set(i.id,i),Es[i.type].set(i.id,i),i}',
  'var $=new Game;',
].join('\n');

// The hub, then mope's module with the line the copy adds at its end.
function hub(expr, globals) {
  const page = {Proxy};
  return run([
    constant('capture'),
    'capture.source = {url: "https://mope.io/c/game.js", text: ' + JSON.stringify(mope) + '};',
    mope,
    'capture.receive(function(__lumiName){return eval(__lumiName)});',
  ], Object.assign({PAGE: page, document: {readyState: 'loading'}}, globals), expr);
}

test('the game singleton is recognised, and plain objects are not', () => {
  const check = (expr) => run(pieces, {}, expr);
  assert.equal(check('mopeIsGame({classes: {}, settings: {}, network: {}, loop: {canvas: null}, camera: {}})'), true);
  assert.equal(check('mopeIsGame({camera: 1, network: 1, settings: 1})'), false, 'no loop');
  assert.equal(check('mopeIsGame({camera: 1, network: 1, settings: 1, loop: 5})'), false, 'loop not an object');
  assert.equal(check('mopeIsGame(null)'), false);
});

test('the per-animal counters are found by shape, whatever mope calls them', () => {
  const check = (expr) => run(pieces, {}, expr);
  assert.equal(check('mopeIsAnimalStats({xp: 1, oxygen: 100, rank: 2, resource: {value: 9, max: 10, type: 0}})'), true);
  assert.equal(check('mopeIsAnimalStats({xp: 1, oxygen: 100, resource: 9})'), false, 'the HUD store has a plain number');
  assert.equal(check('mopeIsAnimalStats(null)'), false);
});

test('the copy hands over the game, its tables, the animal class and the species names', () => {
  const out = hub(`({
    phase: capture.phase,
    adoptErrors: capture.errors.filter((e) => /^(adopt|animal)/.test(e)),
    camera: capture.game.camera === $._l,
    hasOld: ['camera', 'network', 'player'].every((k) => k in capture.game),
    stats: capture.game.Ge === $.Ge,
    names: Object.assign({}, capture.names),
    animal: capture.Animal === Animal,
    method: capture.outline.method,
    bite: capture.outline.canTailBite,
    registry: capture.registry === Es,
    species: capture.species[1],
  })`);
  assert.deepEqual(out, {
    phase: 'ready', adoptErrors: [], camera: true, hasOld: true, stats: true,
    names: {$: '$', classes: 'Vy', camera: '_l', network: 'Ti', player: 'Ml'},
    animal: true, method: 'Hj', bite: 'Vj', registry: true, species: 'shrimp',
  });
});

test('the old names reach mope\'s minified ones, private fields and all', () => {
  const out = hub(`(() => {
    const game = capture.game;
    const before = game.player;
    const mouse = spawn(Object.assign(new Mouse(), {id: 7}));
    $.Tj(mouse);
    const sent = game.network.send(5, {a: 1});
    // Moderator Extras wraps send this way to see mope's own packets.
    const seen = [];
    const original = game.network.send;
    Object.defineProperty(game.network, 'send', {configurable: true, writable: true,
      value: function (op) { seen.push(op); return original.apply(this, arguments); }});
    $.key();
    return {before: before === undefined, player: game.player === mouse, sent,
      ops: $.Ti.sent().map((p) => p[0]), seen, own: Object.prototype.hasOwnProperty.call($.Ti, 'jb'),
      ready: game.network.readyState};
  })()`);
  assert.deepEqual(out, {before: true, player: true, sent: 1, ops: [5, 201], seen: [201], own: true, ready: 'open'});
});

test('the Animal methods are hooked, and the entity tables read', () => {
  const out = hub(`(() => {
    const a = spawn(Object.assign(new Mouse(), {id: 1, tier: 15, angle: 0, outline: {}, tail: {}}));
    const b = spawn(Object.assign(new Mouse(), {id: 2, tier: 15, angle: 0, outline: {}, tail: {}}));
    $.Ml = a;
    const seen = [];
    capture.afterOutline(function (args) { seen.push([this === b, args[0]]); });
    capture.aroundUpdate({before() { return this.angle; }, after(before) { seen.push(['turned', this.angle - before]); }});
    b.Hj();
    b.Hj('red');
    b.update();
    return {seen, tint: [b.outline.tint, b.tail.tint], byId: capture.entity(2) === b,
      none: capture.entity(9), all: [...capture.entities()].length};
  })()`);
  assert.deepEqual(out.seen, [[true, undefined], [true, 'red'], ['turned', 1]]);
  assert.deepEqual(out.tint, ['red', 'green'], 'mope\'s own method still ran, biteable tail and all');
  assert.equal(out.byId, true);
  assert.equal(out.none, null);
  assert.equal(out.all, 2);
});

test('the HUD stores come from the Proxy of mope\'s hidden iframe', () => {
  class HTMLIFrameElement { get contentWindow() { return this.win; } }
  const original = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow').get;
  const html = {};
  const out = hub(`(() => {
    const frame = new HTMLIFrameElement();
    Object.assign(frame, {hidden: true, parentNode: document.documentElement, win: {Proxy, Reflect}});
    const je = frame.contentWindow.Proxy;
    const hud = new je({cooldowns: {}, hasAbility1: true, animalBiome: 'land', equippedItemId: ''}, {});
    return {hud: capture.state(['cooldowns', 'hasAbility1', 'animalBiome']) === hud,
      nobody: capture.state(['nothing', 'here']), frame: capture.frameProxy,
      restored: Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow').get === ORIGINAL};
  })()`, {HTMLIFrameElement, ORIGINAL: original, document: {readyState: 'loading', documentElement: html}});
  assert.equal(out.hud, true);
  assert.equal(out.nobody, null);
  assert.equal(out.frame, true);
  assert.equal(out.restored, true, 'contentWindow is mope\'s own again once the iframe is seen');
});

test('the copy points mope\'s relative imports home and adds one line', () => {
  const text = 'import{a as e}from"../packages/P.js";import"./Q.js";' +
    'const z=()=>import(`./Z.js`),u=new URL(`x.webp`,import.meta.url);export{e as A};';
  const out = hub(`capture.copy('https://mope.io/c/G.js', ${JSON.stringify(text)})`);
  assert.equal(out,
    'import{a as e}from"https://mope.io/packages/P.js";import"https://mope.io/c/Q.js";' +
    'const z=()=>import(`https://mope.io/c/Z.js`),u=new URL(`x.webp`,"https://mope.io/c/G.js");' +
    ';globalThis.__lumiCapture&&globalThis.__lumiCapture.receive(function(__lumiName){return eval(__lumiName)});\n' +
    'export{e as A};\n//# sourceURL=https://mope.io/c/G.js\n');
  assert.throws(() => hub('capture.copy("https://mope.io/c/G.js", "import.meta.resolve(`x`)")'),
    /import\.meta/, 'a module it cannot copy faithfully is left alone');
});

test('a copy that starts after mope did installs nothing and says so', () => {
  const out = run([constant('capture')], {PAGE: {Proxy}, document: {readyState: 'interactive'}},
    '({late: capture.late, phase: capture.phase, game: capture.game, registry: capture.registry})');
  assert.deepEqual(out, {late: true, phase: 'started after mope did', game: null, registry: null});
});

test('the bridge never pins one of mope\'s file names', () => {
  const {source} = require('./helpers.cjs');
  // A hash-named chunk written into the script is exactly how the modpacks
  // break on every mope deploy.
  assert.doesNotMatch(source, /mope\.io\/(?:c\/)?[A-Za-z0-9_-]{8}\.js/);
});

// The frame hook. Two copies of the script on one page, and the once-a-second
// watchdog, must never stack wrapper on wrapper.
test('mope\'s renderer is wrapped once, however often and by however many copies', () => {
  const page = {};
  let draws = 0;
  const renderer = {render() { draws++; }};
  const makeCopy = () => run([fn('frameRunners'), fn('wrapRenderer'),
    'const frame = {renderer: null, original: null, wrapper: null, frames: 0};',
    'let ran = 0; function runFrameHooks() { ran++; }'], {
    PAGE: page,
    dbg: () => {},
    bridge: {game: {loop: {renderer}}},
  }, '({wrap: wrapRenderer, ran: () => ran})');
  const a = makeCopy();
  const b = makeCopy();
  for (let i = 0; i < 5; i++) { a.wrap(); b.wrap(); }
  renderer.render();
  assert.equal(draws, 1, 'mope draws once');
  assert.equal(a.ran(), 1, 'copy A\'s features run once per frame');
  assert.equal(b.ran(), 1, 'copy B\'s features run once per frame');
});
