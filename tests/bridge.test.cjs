// The capture hub and the bridge over it. Since mope's 2026-10-31 build the
// game is reachable only while the page starts: mope detaches each class
// prototype from Object.prototype and freezes it, builds its entity registry
// with Object.fromEntries and its HUD stores with `new Proxy`. The fixtures
// below do exactly that, in that order (see aA() and the `$ = new OA` line of
// mope's game chunk), with the hub installed first as the extension is.
const {test} = require('node:test');
const {assert, fn, constant, run} = require('./helpers.cjs');

const pieces = ['mopeHasKeys', 'mopeIsGame', 'mopeIsAnimalStats'].map(fn);

// mope's start-up, in miniature. Names are minified in the real thing; the
// hub must not care what they are.
const mope = `
  class Game {
    constructor() {
      this.Br = {xp: 4, oxygen: 100, rank: 1, resource: {value: 90, max: 100, type: 0}};
      this.settings = {};
      this.network = {send() {}};
      this.loop = {canvas: null};
      this.camera = {zoom: 1, target: {zoom: 1}};
    }
  }
  class Entity {
    static create() {}
    static get(id) { return registry.animal.get(id) || null; }
    static has() {}
    get outlineColor() { return 'grey'; }
  }
  class Animal extends Entity {
    get outlineColor() { return this.arena ? 'cyan' : 'grey'; }
    nv(e = this.outlineColor) {
      return this.outline.tint = e, me?.Zb(this) ? this.tail.tint = 'green' : this.tail.tint = e, this;
    }
    Zb(other) { return this !== other && this.tier === other.tier; }
    update() { this.angle += 1; return this; }
  }
  class Mouse extends Animal {}
  function aA(e) {
    let t = e.prototype;
    for (; t && t !== Object.prototype;) {
      let e = Object.getPrototypeOf(t);
      e === Object.prototype && Object.setPrototypeOf(t, null), Object.freeze(t), t = e;
    }
  }
  for (const e of [Game, Mouse, Animal]) aA(e);
  const game = new Game();
  const registry = Object.fromEntries([['animal', new Map()], ['food', new Map()],
    ['tree', new Map()], ['hole', new Map()]]);
  const hud = new PAGE.Proxy({cooldowns: {}, hasAbility1: true, animalBiome: 'land', equippedItemId: ''}, {});
  const nested = new PAGE.Proxy({cooldowns: 1, hasAbility1: 2}, {});
  let me = null;
`;

function hub(readyState, expr) {
  const page = {Proxy};
  return run([constant('capture'), mope], {PAGE: page, document: {readyState}}, expr);
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

test('the hub catches the game, the classes, the registry and the stores as mope builds them', () => {
  const out = hub('loading', `({
    game: capture.game === game,
    entity: capture.Entity === Entity,
    animal: capture.Animal === Animal,
    method: capture.outline.method,
    bite: capture.outline.canTailBite,
    registry: capture.registry === registry,
    hud: capture.state(['cooldowns', 'hasAbility1', 'animalBiome']) === hud,
    nobody: capture.state(['nothing', 'here']),
    stillFrozen: Object.isFrozen(Animal.prototype) && Object.getPrototypeOf(Entity.prototype) === null,
    cameraIsOwn: Object.prototype.hasOwnProperty.call(game, 'camera'),
  })`);
  assert.deepEqual(out, {game: true, entity: true, animal: true, method: 'nv', bite: 'Zb',
    registry: true, hud: true, nobody: null, stillFrozen: true, cameraIsOwn: true});
});

test('the frozen Animal methods can still be hooked, through the hub', () => {
  const out = hub('loading', `(() => {
    const a = new Mouse(), b = new Mouse();
    Object.assign(a, {tier: 15, angle: 0, outline: {}, tail: {}});
    Object.assign(b, {tier: 15, angle: 0, outline: {}, tail: {}});
    me = a;
    const seen = [];
    capture.afterOutline(function (args) { seen.push([this === b, args[0]]); });
    capture.aroundUpdate({before() { return this.angle; }, after(before) { seen.push(['turned', this.angle - before]); }});
    b.nv();
    b.nv('red');
    b.update();
    registry.animal.set(7, b);
    return {seen, tint: [b.outline.tint, b.tail.tint], byId: capture.entity(7) === b,
      all: [...capture.entities()].length};
  })()`);
  assert.deepEqual(out.seen, [[true, undefined], [true, 'red'], ['turned', 1]]);
  assert.deepEqual(out.tint, ['red', 'green'], 'mope\'s own method still ran, biteable tail and all');
  assert.equal(out.byId, true);
  assert.equal(out.all, 1);
});

test('a copy that starts after mope did installs nothing and says so', () => {
  const out = hub('interactive', '({late: capture.late, game: capture.game, registry: capture.registry})');
  assert.equal(out.late, true);
  assert.equal(out.game, null);
  assert.equal(out.registry, null);
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
