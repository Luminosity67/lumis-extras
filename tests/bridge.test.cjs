// The game bridge recognises mope's exports by SHAPE. These fixtures mirror
// what mope's game chunk actually exports (verified against BoTM2IF7.js,
// 2026-10-07): a base Entity class whose subclasses inherit its statics and
// declare their own `list`, a base Animal class whose species subclasses
// inherit its methods, the game singleton, and the animal config table.
const {test} = require('node:test');
const {assert, fn, run} = require('./helpers.cjs');

const pieces = ['mopeHasKeys', 'mopeIsGame', 'mopeIsEntityClass', 'mopeIsAnimalClass',
  'mopeIsConfigTable'].map(fn);

const fixtures = `
  class Entity {
    static create() {}
    static get() {}
    static forEach() {}
  }
  Entity.list = new Map();
  Entity.dynamicList = new Map();
  class Animal extends Entity {
    isUsingAbility1() {}
    setOutlineColor() {}
    update() {}
  }
  Animal.list = new Map();
  class Mouse extends Animal {}
  Mouse.list = new Map();
  class Arena extends Entity { update() {} }
  Arena.list = new Map();
  const game = {classes: {}, settings: {}, network: {}, loop: {canvas: null}, camera: {}};
  const configs = {mouse: {comfortZones: [], subspeciesEnum: {0: 'DEFAULT'}}, king_dragon: {}};
`;

function check(expr) {
  return run(pieces.concat(fixtures), {}, expr);
}

test('the game singleton is recognised, and plain objects are not', () => {
  assert.equal(check('mopeIsGame(game)'), true);
  assert.equal(check('mopeIsGame({camera: 1, network: 1, settings: 1})'), false, 'no loop');
  assert.equal(check('mopeIsGame({camera: 1, network: 1, settings: 1, loop: 5})'), false, 'loop not an object');
  assert.equal(check('mopeIsGame(null)'), false);
});

test('only the BASE entity class is the registry, never a subclass that inherits it', () => {
  assert.equal(check('mopeIsEntityClass(Entity)'), true);
  // The bug this guards: subclasses inherit dynamicList/create/get, so a
  // loose check took the Animal class for the registry and found no Animal.
  assert.equal(check('mopeIsEntityClass(Animal)'), false);
  assert.equal(check('mopeIsEntityClass(Mouse)'), false);
  assert.equal(check('mopeIsEntityClass(Arena)'), false);
});

test('only the BASE animal class is wrapped for turn speed, never a species', () => {
  assert.equal(check('mopeIsAnimalClass(Animal)'), true);
  assert.equal(check('mopeIsAnimalClass(Mouse)'), false, 'a species inherits the methods, it does not declare them');
  assert.equal(check('mopeIsAnimalClass(Entity)'), false);
  assert.equal(check('mopeIsAnimalClass(Arena)'), false);
});

test('the animal config table is recognised by its species entries', () => {
  assert.equal(check('mopeIsConfigTable(configs)'), true);
  assert.equal(check('mopeIsConfigTable({mouse: {}})'), false);
  assert.equal(check('mopeIsConfigTable([configs])'), false);
});

test('the bridge imports by URL from the page, and never pins a file name', () => {
  const {source} = require('./helpers.cjs');
  assert.match(source, /examine\(await import\(url\)\)/);
  assert.match(source, /script\[type="module"\]\[src\], link\[rel="modulepreload"\]\[href\]/);
  // A hash-named chunk written into the script is exactly how the modpacks
  // break on every mope deploy.
  assert.doesNotMatch(source, /mope\.io\/[A-Za-z0-9_-]{8}\.js/);
});
