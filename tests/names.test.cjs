// The name-colour share tag travels inside the nickname and is decoded by
// every Lumi's Extras client, old and new — so its encoding is a wire format.
const {test} = require('node:test');
const {assert, fn, constant, run} = require('./helpers.cjs');

const pieces = [
  constant('MARKER'), constant('ALPHA'), constant('INVIS_SET'),
  constant('NAME_COLORS'), constant('NAME_GRADIENTS'), constant('hexToInt'),
  fn('colorInt'), fn('stripInvis'), fn('encodeSuffix'), fn('decodeSuffix'),
];

function codec(state) {
  return run(pieces, {
    settings: {masterEnabled: true},
    nameColorState: Object.assign({enabled: true, share: true, mode: 'solid', color: '#ff3b30', grad: 0}, state),
  }, '({encode: encodeSuffix, decode: decodeSuffix, strip: stripInvis})');
}

test('a palette colour round-trips through the tag', () => {
  const c = codec({mode: 'solid', color: '#ff3b30'});
  const tag = c.encode(false);
  assert.equal(c.strip('Lumi' + tag), 'Lumi', 'the tag is invisible');
  assert.deepEqual(c.decode('Lumi' + tag), {solid: 0xff3b30});
});

test('a custom colour round-trips at 4 bits per channel', () => {
  const c = codec({mode: 'solid', color: '#123456'});
  const decoded = c.decode('x' + c.encode(false));
  assert.deepEqual(decoded, {solid: (0x11 << 16) | (0x33 << 8) | 0x55});
});

test('a gradient round-trips, in full and in the compact form', () => {
  const c = codec({mode: 'grad', grad: 6});
  assert.deepEqual(c.decode('x' + c.encode(false)), {grad: 6});
  assert.deepEqual(c.decode('x' + c.encode(true)), {grad: 6});
  assert.ok(c.encode(true).length < c.encode(false).length);
});

test('sharing off sends nothing, and a name without a tag is nobody\'s', () => {
  const c = codec({share: false});
  assert.equal(c.encode(false), '');
  assert.equal(codec({}).decode('Lumi'), null, 'letters alone never identify a player');
});

test('the gradient table only ever grows: indexes are on the wire', () => {
  const names = run([constant('NAME_GRADIENTS')], {}, 'NAME_GRADIENTS.map((g) => g[0])');
  // The first and last entries as of 1.0.x. Reordering or deleting would
  // repaint everyone's shared gradient as a different one.
  assert.equal(names[0], 'Flame');
  assert.equal(names[6], 'Galaxy');
  assert.equal(names[58], 'Shoreline');
});
