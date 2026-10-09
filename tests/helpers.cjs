// Shared by every test: the script's own source, and a way to lift one
// top-level function or constant out of it and run it in isolation.
//
// Top-level means two-space indentation inside the script's IIFE — the tests
// only ever run production code, never a copy of it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(process.env.LUMI_TEST_SOURCE || path.join(root, 'lumis-extras.user.js'), 'utf8');

// `function name(...) { ... }` at two-space indentation, up to its closing
// brace at the same indentation.
function fn(name) {
  const start = source.search(new RegExp('^  (?:async )?function ' + name + '\\(', 'm'));
  assert.notEqual(start, -1, 'function ' + name + ' exists');
  const end = source.indexOf('\n  }\n', start);
  assert.notEqual(end, -1, 'function ' + name + ' closes');
  return source.slice(start, end + 4);
}

// `const NAME = ...;` at two-space indentation. Handles one-liners and blocks
// that close with `];`, `};` or `]);` on a line of their own.
function constant(name) {
  const start = source.search(new RegExp('^  const ' + name + ' = ', 'm'));
  assert.notEqual(start, -1, 'const ' + name + ' exists');
  const lineEnd = source.indexOf('\n', start);
  const firstLine = source.slice(start, lineEnd);
  if (/;\s*(\/\/.*)?$/.test(firstLine)) return firstLine;
  const close = source.slice(start).search(/\n  (?:\]|\}|\]\)|\}\))[^\n]*;\n/);
  assert.notEqual(close, -1, 'const ' + name + ' closes');
  const closeEnd = source.indexOf('\n', start + close + 1);
  return source.slice(start, closeEnd);
}

// Values made inside a vm context carry that context's Object.prototype,
// which strict deep-equality rejects. Results are rebuilt as plain values
// here; functions are wrapped so whatever they return is rebuilt too.
function plain(value) {
  if (typeof value === 'function') return (...args) => plain(value(...args));
  // Array.from, not value.map: map builds its result in the array's own realm.
  if (Array.isArray(value)) return Array.from(value, (item) => plain(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = plain(value[key]);
    return out;
  }
  return value;
}

// Runs the named pieces in a fresh context with `globals`, then evaluates
// `expr` there and returns its value.
function run(pieces, globals, expr) {
  const ctx = vm.createContext(Object.assign({console, performance}, globals || {}));
  vm.runInContext(pieces.join('\n'), ctx);
  return plain(vm.runInContext(expr, ctx));
}

module.exports = {assert, fs, path, vm, root, source, fn, constant, run};
