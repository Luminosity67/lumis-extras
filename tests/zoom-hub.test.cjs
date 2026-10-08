// The shared zoom hub is a CONTRACT with Lumi's Moderator Extras: that script
// joins whatever hub is on the page and drives it through this API. These
// tests pin the API and the behaviour it relies on.
const {test} = require('node:test');
const {assert, fn, constant, run} = require('./helpers.cjs');

function makeHub(opts) {
  const options = opts || {};
  const stored = new Map(Object.entries(options.stored || {}));
  const listeners = [];
  const camera = {zoom: 1, target: {position: {x: 0, y: 0}, angle: 0, zoom: 2}};
  const globals = {
    PAGE: {addEventListener: (type, fn) => listeners.push({type, fn})},
    document: {activeElement: null, getElementById: () => null, querySelector: () => ({})},
    localStorage: {
      getItem: (k) => (stored.has(k) ? stored.get(k) : null),
      setItem: (k, v) => stored.set(k, String(v)),
    },
    setInterval: () => 0,
    TAG: '[test]',
    dbg: () => {},
    kbCapturing: () => false,
    Element: class {},
    bridge: {
      game: {camera},
      ready: () => ({then: (f) => f()}),
      status: () => ({phase: 'ready'}),
    },
  };
  const hub = run([constant('ZOOM_HUB_REV'), fn('buildZoomHub')], globals,
    'buildZoomHub(' + (options.previous ? 'previousHub' : 'null') + ')');
  return {hub, camera, stored, listeners};
}

test('the hub keeps revision 3\'s public API, so Moderator Extras joins unchanged', () => {
  const {hub} = makeHub();
  assert.equal(hub.rev, 5);
  for (const name of ['normalize', 'getLevel', 'setLevel', 'hooked', 'hookedVia', 'preemptedBy',
    'ownerId', 'rehook', 'status', 'note', 'retire', 'join']) {
    assert.equal(typeof hub[name], 'function', name);
  }
  const seat = hub.join('moderator', {zoomPriority: 1});
  assert.equal(typeof seat.setActive, 'function');
  assert.equal(typeof seat.leave, 'function');
});

test('it hooks $.camera.target.zoom straight from the bridge, with no trap', () => {
  const {hub, camera} = makeHub();
  assert.equal(hub.hooked(), true);
  assert.match(hub.hookedVia(), /bridge/);
  const descriptor = Object.getOwnPropertyDescriptor(camera.target, 'zoom');
  assert.equal(typeof descriptor.get, 'function');
  assert.equal(typeof descriptor.set, 'function', 'mope writes target.zoom in strict mode');
});

test('the camera only moves while a member is active, and reads the shared level', () => {
  const {hub, camera, stored} = makeHub({stored: {'lumi:zoom:v1:level': '0.7'}});
  assert.equal(hub.getLevel(), 0.7, 'level is read from the shared key');
  assert.equal(camera.target.zoom, 2, 'nobody active: native value');
  const extras = hub.join('extras', {zoomPriority: 2});
  extras.setActive(true);
  assert.ok(Math.abs(camera.target.zoom - 1.4) < 1e-9, 'active: native x level');
  camera.target.zoom = 3;   // the server's camera packet
  assert.ok(Math.abs(camera.target.zoom - 2.1) < 1e-9, 'a new native value is scaled too');
  hub.setLevel(5, 'test');
  assert.equal(hub.getLevel(), 4, 'clamped to the range');
  assert.equal(stored.get('lumi:zoom:v1:level'), '4', 'and written back to the shared key');
  extras.setActive(false);
  assert.equal(camera.target.zoom, 3, 'off is native again, with nothing to undo');
});

test('the highest zoomPriority owns the camera; Extras outranks Moderator Extras', () => {
  const {hub} = makeHub();
  const extras = hub.join('extras', {zoomPriority: 2});
  const moderator = hub.join('moderator', {zoomPriority: 1});
  moderator.setActive(true);
  assert.equal(hub.ownerId(), 'moderator');
  assert.equal(hub.preemptedBy('moderator'), '');
  extras.setActive(true);
  assert.equal(hub.ownerId(), 'extras');
  assert.equal(hub.preemptedBy('moderator'), 'extras');
  extras.setActive(false);
  assert.equal(hub.ownerId(), 'moderator', 'ownership falls back on the same call');
});

test('retire() hands the camera back with its native value', () => {
  const {hub, camera} = makeHub({stored: {'lumi:zoom:v1:level': '0.5'}});
  hub.join('extras', {zoomPriority: 2}).setActive(true);
  camera.target.zoom = 4;
  assert.equal(camera.target.zoom, 2);
  hub.retire();
  const descriptor = Object.getOwnPropertyDescriptor(camera.target, 'zoom');
  assert.equal(descriptor.value, 4);
  assert.equal(hub.hooked(), false);
});

test('one wheel listener, at capture, on the window', () => {
  const {listeners} = makeHub();
  const wheels = listeners.filter((l) => l.type === 'wheel');
  assert.equal(wheels.length, 1);
});

test('zoom-in goes past vanilla: 10% steps to 200%, 25% past it, capped at 400%', () => {
  const {hub} = makeHub();
  assert.equal(hub.MAX, 4);
  assert.equal(hub.MIN, 0.5, 'zoom-out keeps its floor');
  let level = 1;
  for (let i = 0; i < 10; i++) level = hub.normalize(hub.stepped(level, 1));
  assert.equal(level, 2, 'ten notches in from 100%');
  level = hub.normalize(hub.stepped(level, 1));
  assert.equal(level, 2.25, 'coarse past 200%');
  level = hub.normalize(hub.stepped(level, -1));
  assert.equal(level, 2);
  level = hub.normalize(hub.stepped(level, -1));
  assert.equal(level, 1.9, 'fine again below 200%');
  for (let i = 0; i < 40; i++) level = hub.normalize(hub.stepped(level, 1));
  assert.equal(level, 4);
});
