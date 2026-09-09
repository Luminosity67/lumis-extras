const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const source = fs.readFileSync(process.env.LUMI_TEST_SOURCE || path.join(__dirname, '../lumis-extras.user.js'), 'utf8');
function fn(name) {
  const start = source.search(new RegExp('^  (?:async )?function ' + name + '\\(', 'm'));
  assert.notEqual(start, -1, name + ' exists');
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
// Native mope constructor/render contract (BrhD8Ove.js, 2026-09-08):
// both rectangles stay 30 units wide. renderHealthRect changes bar.scale.x
// to health.value/100; its optional label prints target.health. Network
// synchronize() assigns the server's uint8 directly to target.health.
function shape(width, scale = 1, geometry = false) {
  const node = {scale: {x: scale}, get width() { return width * Math.abs(this.scale.x); }};
  if (geometry) node.geometry = {graphicsData: [{shape: {width}}]};
  else node.context = {instructions: [{data: {path: {instructions: [{action: 'rect', data: [0, 0, width, 7]}]}}}]};
  return node;
}
function setup({captured = true, geometry = false} = {}) {
  const entity = {children: []};
  const bar = {parent: {parent: entity, visible: true}, visible: true, alpha: 1};
  const plate = shape(30, 1, geometry), fill = shape(30, .13, geometry);
  plate.parent = fill.parent = bar;
  const label = {text: '100', visible: false, alpha: 1};
  const entry = {entity, bar, parts: {plate, fill, label}, raw: 100, settled: 100};
  const model = {container: entity, spawned: true, target: {health: 13}};
  const c = vm.createContext({
    gameCapture: {game: captured ? {player: model} : null},
    hpState: {player: entity, playerEntry: entry, bars: new Map([[bar, entry]])},
    hpBarParts: () => entry.parts,
    PARTY_PACE_MIN_MS: 100, PARTY_PACE_HEARTBEAT_MS: 2000, PARTY_PACE_EPSILON: .0015,
  });
  for (const name of ['hpGameModel', 'hpGamePlayer', 'hpSelfEntry', 'hpPercentFromLabel',
    'hpWidthFromContext', 'hpWidthFromGeometry', 'hpDrawnWidth', 'hpPercentOf',
    'partySelfHealth', 'partyMakePacer', 'partyListMembers', 'partyOnPayload', 'partyTick']) {
    vm.runInContext(fn(name), c);
  }
  return {c, entry, model, bar, plate, fill, label};
}

for (const geometry of [false, true]) test('hidden HP numbers: scaled ' + (geometry ? 'geometry' : 'context') + ' fill reports 13%, not 100%', () => {
  const h = setup({captured: false, geometry});
  assert.equal(h.c.hpPercentOf(h.bar, h.entry), 13);
  assert.equal(h.c.partySelfHealth(), 13, 'must read the bar now, not a cached 100');
  h.fill.scale.x = .07;
  assert.equal(Math.round(h.c.hpPercentOf(h.bar, h.entry)), 7);
  h.fill.scale.x = 0;
  assert.equal(h.c.partySelfHealth(), 0, 'zero scale means zero HP');
});

test('width fallback is already scaled and must not be scaled twice', () => {
  const h = setup({captured: false});
  delete h.fill.context; delete h.plate.context;
  assert.equal(h.c.hpPercentOf(h.bar, h.entry), 13);
});

test('bar rebuilds and local scale changes invalidate the reference width', () => {
  const h = setup({captured: false});
  assert.equal(h.c.hpPercentOf(h.bar, h.entry), 13);
  h.plate.scale.x = 2; h.fill.scale.x = .26;
  assert.equal(h.c.hpPercentOf(h.bar, h.entry), 13);
});

test('native health wins over stale labels, cached entries and hidden HUDs', () => {
  const h = setup();
  h.label.visible = true;
  assert.equal(h.c.partySelfHealth(), 13);
  h.bar.visible = false; h.bar.parent.visible = false;
  h.c.hpState.playerEntry = null; h.c.hpState.bars.clear();
  for (const hp of [86, 13, 9, 4, 0, 1, 30, 100]) {
    h.model.target.health = hp;
    assert.equal(h.c.partySelfHealth(), hp, 'server damage and healing work without a scanned bar');
  }
});

test('native player identity is reread on respawn and old health is refused on death', () => {
  const h = setup();
  h.model.spawned = false;
  assert.equal(h.c.partySelfHealth(), -1);
  h.c.gameCapture.game.player = null;
  assert.equal(h.c.partySelfHealth(), -1);
  h.c.gameCapture.game.player = {spawned: true, container: {children: []}, target: {health: 82}};
  assert.equal(h.c.partySelfHealth(), 82);
  h.c.gameCapture.game.player.container.destroyed = true;
  assert.equal(h.c.partySelfHealth(), -1);
});

test('invalid native values cannot turn into full health or reuse cached HP', () => {
  const h = setup();
  for (const hp of [undefined, null, NaN, Infinity, -1, 101, '13']) {
    h.model.target.health = hp;
    assert.equal(h.c.partySelfHealth(), -1, String(hp));
  }
});

test('unreadable fallback does not publish the old settled health', () => {
  const h = setup({captured: false});
  h.bar.parent.visible = false;
  assert.equal(h.c.partySelfHealth(), -1);
  h.bar.parent = null;
  assert.equal(h.c.partySelfHealth(), -1);
});

test('visible game label still wins over an interpolated fill in fallback mode', () => {
  const h = setup({captured: false});
  h.label.visible = true; h.label.text = '13'; h.fill.scale.x = .86;
  assert.equal(h.c.partySelfHealth(), 13);
});

test('older model shapes retain a fresh visual fallback', () => {
  const h = setup();
  delete h.model.target;
  assert.equal(h.c.partySelfHealth(), 13);
  h.fill.scale.x = NaN;
  assert.equal(h.c.partySelfHealth(), -1, 'invalid transforms are unknown');
});

test('party tick sends stationary damage promptly and a second client displays the same HP', async () => {
  const sender = setup(), receiver = setup();
  const sent = [], failures = [];
  Object.assign(sender.c, {
    party: {enabled: true, id: 'sender', color: 0, joinedAt: 1, peers: new Map(),
      pacer: sender.c.partyMakePacer(), transport: {isReady: () => true, publish: data => sent.push(data)}},
    partyActive: () => true, partyNeedsSelfHealth: () => true,
    partyChatTick() {}, partyListTick() {}, partyCachedMinimap: () => ({}), partyReadParts: () => ({}),
    partySelfPosition: () => ({u: .5, v: .5}), partySelfArtKey: () => '', partySelfXp: () => '',
    partySelfName: () => 'vantablack', partySelfHandle: () => '', arenaDuel: {active: false},
    partySeal: async data => data, dbg: (...args) => failures.push(args),
  });
  Object.assign(receiver.c, {
    party: {id: 'receiver', session: 1, enabled: true, listSelf: false, peers: new Map()},
    partyUnseal: async data => data, partyPlausible: (u, v) => u === .5 && v === .5,
    partyCleanHandle: () => '', performance: {now: () => 1000}, PARTY_STALE_MS: 5000,
  });
  // These messages use the real sender, pacer, receiver validation and row
  // assembly. Only encryption/transport and unrelated drawing are stubbed.
  sender.model.target.health = 100;
  sender.c.partyTick({}, {}, 1000); await Promise.resolve();
  sender.model.target.health = 13;
  sender.c.partyTick({}, {}, 1050); await Promise.resolve();
  assert.equal(sent.length, 1, '100ms transport floor');
  sender.c.partyTick({}, {}, 1100); await Promise.resolve();
  assert.equal(sent.length, 2, 'damage sends before the two-second idle heartbeat');
  assert.equal(sent[1].h, 13);
  await receiver.c.partyOnPayload(sent[1], 1);
  assert.equal(receiver.c.partyListMembers(1000)[0].hp, 13);
  sender.model.target.health = 0;
  sender.c.partyTick({}, {}, 1200); await Promise.resolve();
  await receiver.c.partyOnPayload(sent[2], 1);
  assert.equal(receiver.c.partyListMembers(1000)[0].hp, 0);
  sender.c.party.listSelf = true;
  assert.equal(sender.c.partyListMembers(1200)[0].hp, sent[2].h, 'self row matches the transmitted value');
  sender.model.spawned = false;
  sender.c.partyTick({}, {}, 1300); await Promise.resolve();
  assert.equal(Object.hasOwn(sent[3], 'h'), false, 'unknown health is omitted on the existing wire protocol');
  await receiver.c.partyOnPayload(sent[3], 1);
  assert.equal(receiver.c.partyListMembers(1000)[0].hp, -1, 'unknown clears the previously displayed health');
  assert.deepEqual(failures, []);
});
