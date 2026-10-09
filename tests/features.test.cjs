// The pure logic of the game-facing features, run against fixtures shaped
// like mope's own entities.
const {test} = require('node:test');
const {assert, fn, constant, run} = require('./helpers.cjs');

/* ----- cooldown timers ----- */

test('cooldowns read mope\'s HUD store: recharging, running, and held', () => {
  const pieces = [fn('cdReading')];
  const store = (cd) => ({bridge: {store: () => ({cooldowns: {ability1: cd}})}});
  const read = (cd, now) => run(pieces, store(cd), 'cdReading("ability1", ' + now + ')');
  assert.deepEqual(read({startsAt: 0, endsAt: 0, active: false}, 1000), null, 'ready: no badge');
  assert.deepEqual(read({startsAt: 500, endsAt: 4000, active: false}, 1000), {left: 3000, active: false});
  assert.deepEqual(read({startsAt: 500, endsAt: 2500, active: true}, 1000), {left: 1500, active: true});
  const held = read({startsAt: 500, endsAt: 0, active: true}, 1000);
  assert.equal(held.left, Infinity, 'an active ability with no end is a hold ability');
  assert.equal(run([fn('cdReading')], {bridge: {store: () => null}}, 'cdReading("ability1", 1)'), null,
    'no store yet: nothing, rather than a throw');
});

test('cooldown text: whole seconds, then one decimal, then ∞', () => {
  const format = run([constant('CD_DECIMAL_MS'), fn('cdFormat')], {}, 'cdFormat');
  assert.equal(format(12345), '12');
  assert.equal(format(3001), '3');
  assert.equal(format(2999), '2.9', 'floored, so it never counts up');
  assert.equal(format(50), '0.0');
  assert.equal(format(Infinity), '∞');
});

/* ----- HP mode ----- */

const hpPieces = ['HP_TIER_MAX', 'HP_SUBSPECIES_BONUS', 'HP_UNKNOWN_SPECIES'].map(constant)
  .concat([fn('hpMaxOf')]);

function maxOf(entity, species, rare) {
  return run(hpPieces, {
    speciesOf: () => species,
    rareOf: () => rare || '',
    isRareRoll: (e) => e.subspecies > 0,
  }, 'hpMaxOf(' + JSON.stringify(entity) + ')');
}

test('max HP comes from the animal\'s own tier, skins included', () => {
  assert.equal(maxOf({tier: 1, subspecies: 0}, 'mouse'), 2.5);
  assert.equal(maxOf({tier: 15, subspecies: 0}, 'dragon'), 5.5);
  assert.equal(maxOf({tier: 17, subspecies: 0}, 'black_dragon'), 12);
  assert.equal(maxOf({tier: 0, subspecies: 0}, 'mouse'), 0, 'no tier, no figure');
});

test('rares get a figure only where it is known; King Dragon never does', () => {
  assert.equal(maxOf({tier: 9, subspecies: 3}, 'toucan', 'fiery'), 5);
  assert.equal(maxOf({tier: 9, subspecies: 1}, 'toucan', 'choco'), 4);
  assert.equal(maxOf({tier: 9, subspecies: 0}, 'toucan', 'toco'), 4,
    'the toucan names its default TOCO; that is not a rare roll');
  assert.equal(maxOf({tier: 2, subspecies: 1}, 'pigeon', 'dove'), 0);
  assert.equal(maxOf({tier: 17, subspecies: 0}, 'king_dragon'), 0);
});

test('damage kind follows mope\'s own effect flags, fire first', () => {
  const kind = (fx, isPlayer, resource) => run([constant('HP_DRY_PERCENT'), fn('hpDamageKind')],
    {resourcePercent: () => resource}, 'hpDamageKind(' + JSON.stringify({effects: fx}) + ', ' + isPlayer + ')');
  assert.equal(kind({burning: true, poisoned: true}, false, 50), 'fire');
  assert.equal(kind({poisoned: true, bleeding: true}, false, 50), 'poison');
  assert.equal(kind({bleeding: true}, false, 50), 'bleed');
  assert.equal(kind({}, true, 1), 'dry', 'your own resource is empty');
  assert.equal(kind({}, false, 1), 'basic', 'nobody else\'s meter is visible to us');
  assert.equal(kind({}, true, 60), 'basic');
});

/* ----- turn speed ----- */

const turnPieces = [fn('turnMultiplier'), fn('turnWrapAngle'), fn('turnShapedMultiplier'),
  fn('turnApply'), 'const turnState = {applied: 0};', 'const TURN_NEUTRAL = 120;'];

function turn(settings, animal, before) {
  return run(turnPieces, {settings}, '(() => { const a = ' + JSON.stringify(animal) +
    '; turnApply(a, ' + before + '); return a; })()');
}

test('turn speed scales mope\'s own step and never passes the server angle', () => {
  const on = {masterEnabled: true, turnSpeed: true, turnSpeedValue: 240, turnStyle: 'linear'};
  const a = turn(on, {angle: 0.1, target: {angle: 1}, body: {rotation: 0.1}}, 0);
  assert.ok(Math.abs(a.angle - 0.2) < 1e-9, 'twice mope\'s 0.1 step');
  assert.equal(a.body.rotation, a.angle, 'the drawn body follows');
  const b = turn(Object.assign({}, on, {turnSpeedValue: 480}), {angle: 0.5, target: {angle: 0.6}, body: {rotation: 0}}, 0);
  assert.ok(Math.abs(b.angle - 0.6) < 1e-9, 'clamped at the target, never past it');
  const c = turn(Object.assign({}, on, {turnStyle: 'instant'}), {angle: 0.1, target: {angle: 2}, body: {rotation: 0}}, 0);
  assert.equal(c.angle, 2, 'instant snaps to the server angle');
  const off = turn(Object.assign({}, on, {turnSpeed: false}), {angle: 0.1, target: {angle: 1}, body: {rotation: 0.1}}, 0);
  assert.equal(off.angle, 0.1, 'off leaves mope\'s step alone');
});

/* ----- boost counter ----- */

test('boosts left walks the meter at mope\'s 1-and-2 point steps, stopping at 15%', () => {
  const count = run(['BOOST_MIN_PCT', 'BOOST_PAIR_PTS'].map(constant).concat([fn('boostCountFrom')]),
    {}, 'boostCountFrom');
  assert.equal(count(15, null), 0, 'boosting stops at 15%');
  assert.equal(count(16, null), 1);
  assert.equal(count(25, null), 7, 'conservative phase: 2 first');
  assert.equal(count(25, 1), 7);
  assert.equal(count(18, 1), 2);
  assert.equal(count(18, 2), 2);
});

/* ----- party ----- */

test('your XP goes out in the shape 1.0.x receivers accept', () => {
  const compact = run([fn('partyCompact')], {}, 'partyCompact');
  assert.equal(compact(2030000), '2.03M');
  assert.equal(compact(5000000), '5M');
  assert.equal(compact(12000), '12K');
  assert.equal(compact(640), '640');
  assert.equal(compact(1999999), '1.99M', 'floored, never rounded up past the real figure');
  const receiver = /^[\d.,]{1,12}[KMB]?\/[\d.,]{1,12}[KMB]?$/i;   // 1.0.x's own check
  for (const n of [0, 99, 1234, 98765, 1234567, 40000000, 2.5e9]) {
    assert.match(compact(n) + '/' + compact(40000000), receiver, String(n));
  }
});

test('your map position is x / mapWidth, the same fraction mope\'s minimap encodes', () => {
  const pos = (player, parts) => run([fn('partySelfPosition')], {
    myAnimal: () => player,
    bridge: {game: {map: {shape: {width: 10000}}}},
  }, 'partySelfPosition(' + JSON.stringify(parts) + ')');
  assert.deepEqual(pos({position: {x: 2500, y: 6000}}, null), {u: 0.25, v: 0.6});
  // With no animal (spectating), the minimap marker is the fallback; mope
  // anchors the map sprite top-right, so x runs from -W to 0.
  assert.deepEqual(pos(null, {spriteW: 250, dot: {position: {x: -187.5, y: 150}}}), {u: 0.25, v: 0.6});
  assert.equal(pos(null, null), null);
});

test('a peer is drawn where its fraction lands on OUR minimap', () => {
  const project = run([fn('partyProjectPeer')], {}, 'partyProjectPeer');
  assert.deepEqual(project({spriteW: 250}, 0.25, 0.6), {x: -187.5, y: 150});
  assert.deepEqual(project({spriteW: 200}, 0.25, 0.6), {x: -150, y: 120}, 'window size cancels out');
});

/* ----- identity ----- */

test('an animal\'s rare variant is read off its own config, the way mope names the art', () => {
  const rare = (subspecies, names) => run([fn('rareOf')], {}, 'rareOf(' +
    JSON.stringify({subspecies, animalConfig: {subspeciesEnum: names}}) + ')');
  assert.equal(rare(0, {0: 'DEFAULT', 1: 'DOVE'}), '');
  assert.equal(rare(1, {0: 'DEFAULT', 1: 'DOVE'}), 'dove');
  assert.equal(rare(0, {0: 'TOCO', 3: 'FIERY'}), 'toco', 'mope files the default toucan under toco/');
  assert.equal(rare(3, {0: 'TOCO', 3: 'FIERY'}), 'fiery');
});

test('a skin id names its species by the longest prefix', () => {
  const pieces = [constant('SPECIES_BY_TIER'), constant('KNOWN_SPECIES'), fn('speciesFromItemId')];
  const species = run(pieces, {}, 'speciesFromItemId');
  assert.equal(species('trex_gold'), 'trex');
  assert.equal(species('black_dragon_azure'), 'black_dragon', 'not dragon');
  assert.equal(species('king_crab_amethyst'), 'king_crab');
  assert.equal(species('nothing_here'), '');
});

/* ----- arena culling ----- */

test('the arena theme gives mope\'s Arena Culling back as it found it', () => {
  const stored = new Map();
  const arena = {outsideWorld: 0};
  const env = run(['MOPE_CULL_SHOW', 'MOPE_CULL_HIDE'].map(constant).concat(
    [fn('mopeCullingValue'), fn('mopeWriteCulling'), fn('mopeSetCulling')]), {
    mopeSettingsProxy: () => ({gameplay: {arena}}),
    store: {
      get: (k, d) => (stored.has(k) ? stored.get(k) : d),
      set: (k, v) => stored.set(k, v),
    },
  }, '({set: mopeSetCulling})');
  env.set(true);
  assert.equal(arena.outsideWorld, 1, 'on: culled');
  env.set(false);
  assert.equal(arena.outsideWorld, 0, 'off: back to the player\'s SHOW');
  arena.outsideWorld = 1;          // the player's own choice is HIDE
  env.set(true);
  env.set(false);
  assert.equal(arena.outsideWorld, 1, 'off: a player who culls keeps culling');
});

/* ----- duel colours ----- */

test('a duel colour is stored as lower-case #rrggbb, anything else is Default', () => {
  const norm = run([fn('normalizeDuelColor')], {}, 'normalizeDuelColor');
  assert.equal(norm('#FF00aa'), '#ff00aa');
  assert.equal(norm(' #00ff00 '), '#00ff00');
  assert.equal(norm(null), null);
  assert.equal(norm('red'), null);
  assert.equal(norm('#fff'), null, 'the colour input always gives six digits');
});

test('duel colours: only your own duel, only where mope would draw cyan or yellow', () => {
  const pieces = [constant('duelColor'), fn('duelColorNumber'), fn('duelColorFor'),
    fn('duelShowsArenaColor'), fn('duelPaint')];
  const out = run(pieces, {}, `(() => {
    // mope's own getter order: afflictions first, then the arena's colours.
    const proto = {
      get outlineColor() {
        if (this.effects.poisoned) return '#55CF37';
        if (this.arena) return this.arena.player1 === this ? 'cyan' : this.arena.player2 === this ? 'yellow' : 'grey';
        return 'grey';
      },
    };
    const mk = (tier) => Object.assign(Object.create(proto),
      {tier, effects: {}, outline: {tint: 'x'}, tail: {tint: 'x'}});
    const me = mk(16), foe = mk(15), stranger = mk(15), strangerFoe = mk(15);
    me.canTailBite = (a) => a !== me && a.tier === me.tier;
    me.arena = foe.arena = {player1: foe, player2: me};
    stranger.arena = strangerFoe.arena = {player1: stranger, player2: strangerFoe};
    globalThis.settings = {masterEnabled: true, duelColorSelf: '#ff0000', duelColorEnemy: null};
    globalThis.bridge = {game: {player: me, colors: {arena: {player1: 'cyan', player2: 'yellow'}}}};
    duelPaint(me);
    duelPaint(foe);
    duelPaint(stranger);
    return {me: [me.outline.tint, me.tail.tint], foe: [foe.outline.tint, foe.tail.tint],
      stranger: duelColorFor(stranger), notInDuel: duelColorFor(mk(15))};
  })()`);
  assert.deepEqual(out.me, [0xff0000, 0xff0000], 'you, picked red');
  assert.deepEqual(out.foe, ['x', 'x'], 'opponent on Default: left to mope');
  assert.equal(out.stranger, null, 'somebody else\'s duel keeps mope\'s colours');
  assert.equal(out.notInDuel, null);
});

test('duel colours step aside for afflictions, a biteable tail, and the master switch', () => {
  const pieces = [constant('duelColor'), fn('duelColorNumber'), fn('duelColorFor'),
    fn('duelShowsArenaColor'), fn('duelPaint')];
  const out = run(pieces, {}, `(() => {
    const proto = {
      get outlineColor() {
        if (this.effects.poisoned) return '#55CF37';
        return this.arena.player1 === this ? 'cyan' : 'yellow';
      },
    };
    const mk = (tier) => Object.assign(Object.create(proto),
      {tier, effects: {}, outline: {tint: 'mope'}, tail: {tint: 'mope'}});
    const me = mk(16), foe = mk(16);
    me.canTailBite = (a) => a !== me && a.tier === me.tier;
    me.arena = foe.arena = {player1: me, player2: foe};
    globalThis.settings = {masterEnabled: true, duelColorSelf: null, duelColorEnemy: '#00ff00'};
    globalThis.bridge = {game: {player: me, colors: {arena: {player1: 'cyan', player2: 'yellow'}}}};
    const rows = [];
    duelPaint(foe);
    rows.push([foe.outline.tint, foe.tail.tint, duelColor.painted.has(foe)]);
    foe.outline.tint = 'mope';
    foe.effects.poisoned = true;
    duelPaint(foe);
    rows.push([foe.outline.tint, duelColor.painted.has(foe)]);
    foe.effects.poisoned = false;
    settings.masterEnabled = false;
    duelPaint(foe);
    rows.push([foe.outline.tint]);
    return rows;
  })()`);
  assert.deepEqual(out[0], [0x00ff00, 'mope', true], 'outline picked; a tail you can bite stays mope\'s green');
  assert.deepEqual(out[1], ['mope', false], 'poisoned: mope\'s colour wins');
  assert.deepEqual(out[2], ['mope'], 'Extras switched off: nothing painted');
});
