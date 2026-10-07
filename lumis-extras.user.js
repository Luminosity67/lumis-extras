// ==UserScript==
// @name         Lumi's Extras
// @namespace    https://github.com/luminosity67/claude
// @updateURL    https://raw.githubusercontent.com/luminosity67/lumis-extras/main/lumis-extras.user.js
// @downloadURL  https://raw.githubusercontent.com/luminosity67/lumis-extras/main/lumis-extras.user.js
// @supportURL   https://github.com/luminosity67/lumis-extras/issues
// @version      1.1.0
// @description  Unified mope.io quality-of-life and cosmetic suite: ability cooldown timers, HP damage numbers, a shared camera zoom, turn-speed feel, a night sky behind your 1v1 duels, an encrypted party map with a party list, party chat, clutter controls, and solid or gradient player-name colors shared through an encrypted online registry.
// @author       luminosity67
// @match        *://mope.io/*
// @match        *://*.mope.io/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @noframes
// @license      MIT
// ==/UserScript==

/*
 * Lumi's Extras
 * -------------
 * Everything is configured from the panel: the button in the bottom-left
 * corner of the main menu, or N while in game.
 *
 * Versioning — 1.x.y, and the leading 1 does not move:
 *   x  MASSIVE changes only. It is NEVER bumped on anyone's initiative but
 *      Lumi's — if you are working on this and think a change earns it, ask.
 *      Default to leaving it alone.
 *   y  everything else: features, fixes, extra gradients, copy tweaks.
 *
 * 1.1.0 — THE REBUILD. Every feature that touches the game was rewritten on a
 * new foundation, and every way the old one found the game is gone: no
 * Object.prototype setters, no Map.prototype.set trap, no Proxy wrapper, no
 * Pixi devtools hook, no scene-graph shape matching, no guessing which animal
 * is yours, no canvas fillText hook for the XP bar.
 *
 * The foundation is in "the game bridge" below, and it is one observation:
 * mope's game code is split into modules that import from each other, so the
 * game module EXPORTS its own internals — the game object, the entity
 * registry, the animal class and the HUD's data stores. Importing that module
 * again from the page hands back the very instance the game is running on.
 * There is no race to win and nothing to be early for, which is what every
 * "mis-hook" since August came down to, and nothing is pinned to one mope
 * build, which is what breaks the modpacks that swap mope's file for an
 * edited copy.
 *
 * What came across unchanged, because it never touched the game: the party
 * relay protocol and its encryption (wire-compatible with 1.0.x), the online
 * colour registry, the name-tag encoding, the clutter hiders, quick chat, the
 * panel's look and every setting's stored value. What each game-facing
 * feature reads now:
 *
 *   cooldown timers   mope's HUD store (exact start/end times, no CSS ring)
 *   damage numbers    each animal's server health and its effects flags
 *   HP bar            your animal's server health, tier and effects
 *   camera zoom       $.camera.target.zoom, through the shared zoom hub
 *   turn speed        the Animal class's own update()
 *   arena features    $.player.arena and its fighters, directly
 *   draw order        $.player and the animal render layers
 *   name colours      the entity registry's animals and their name nodes
 *   party             $.player, $.minimap and the HUD stores
 *
 * The 1.0.x history (and the long notes on why each workaround existed) is
 * in the git history of github.com/Luminosity67/lumis-extras.
 */

(function () {
  'use strict';

  const PAGE = window;
  const TAG = '[LumisExtras]';

  // How this copy was loaded. The extension and the userscript are the SAME
  // FILE: the extension's manifest runs it straight in the page. Every
  // userscript manager defines GM_info for every script it runs, even under
  // @grant none, and nothing defines it for an extension's page-world script.
  const QOLC_VIA = typeof GM_info !== 'undefined' ? 'userscript' : 'extension';

  // With both installed, the extension is the copy to keep. A userscript that
  // finds it already running does nothing at all.
  if (QOLC_VIA === 'userscript') {
    let extensionRunning = false;
    try {
      const list = PAGE.__lumiExtrasInstances;
      extensionRunning = Array.isArray(list) && list.some((i) => i && i.via === 'extension');
    } catch (e) { /* sealed page: assume alone */ }
    if (extensionRunning) {
      console.warn(TAG, 'the Lumi\'s Extras browser extension is already running ' +
        'on this page, so this Tampermonkey copy is standing down. Uninstall ' +
        'the Tampermonkey copy; the extension replaces it.');
      return;
    }
  }

  // Lumi's FOV and older sibling scripts stand down against this flag.
  try { PAGE.__LUMI_EXTRAS_V1_RUNNING__ = true; } catch (e) { /* sealed page */ }

  const VERSION = (() => {
    try {
      const v = typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version;
      if (v) return String(v);
    } catch (e) { /* not exposed */ }
    return '1.1.0';
  })();

  /* ---------------------------------------------- one instance, one layer */

  // Every fixed overlay this script owns is adopted by id rather than created
  // blindly, so two copies on one page share one of each instead of drawing
  // two of everything on top of each other.
  function qolcOwnLayer(id) {
    const host = document.body || document.documentElement;
    if (!host) return null;
    let layer = document.getElementById(id);
    if (layer) {
      if (layer.parentNode !== host) host.appendChild(layer);
      return layer;
    }
    layer = document.createElement('div');
    layer.id = id;
    host.appendChild(layer);
    return layer;
  }

  // A second copy is not a supported setup, so it is said out loud: in the
  // console at once, on screen once the page is up (see onReady).
  const QOLC_INSTANCE = {
    version: VERSION,
    via: QOLC_VIA,
    at: (function () { try { return performance.now(); } catch (e) { return 0; } })(),
  };

  const qolcInstances = (function () {
    let list = null;
    try {
      list = PAGE.__lumiExtrasInstances;
      if (!Array.isArray(list)) list = PAGE.__lumiExtrasInstances = [];
    } catch (e) { list = []; }
    list.push(QOLC_INSTANCE);
    if (list.length > 1) {
      console.warn(TAG, 'ANOTHER COPY OF THIS SCRIPT IS ALREADY RUNNING on ' +
        'this page (' + list.map((i) => i.version + ' ' + (i.via || 'userscript')).join(' + ') +
        '). Keep the extension and uninstall any Tampermonkey copy.');
    }
    return list;
  })();

  /* ------------------------------------------------------------- settings */

  // Settings live in localStorage under `maut:<key>` as JSON — the same keys
  // every 1.0.x build wrote, so nothing is lost moving to 1.1.0. 1.0.x also
  // wrote Tampermonkey's own storage; that is still read first when a
  // userscript manager exposes it, so a value only it holds is not lost.
  const store = {
    get(key, fallback) {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue(key);
          if (v !== undefined) return v;
        }
      } catch (e) { /* sandbox variations */ }
      try {
        const v = localStorage.getItem('maut:' + key);
        if (v !== null) return JSON.parse(v);
      } catch (e) { /* ignore */ }
      return fallback;
    },
    set(key, value) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(key, value);
      } catch (e) { /* ignore */ }
      try { localStorage.setItem('maut:' + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    },
    remove(key) {
      try {
        if (typeof GM_deleteValue === 'function') GM_deleteValue(key);
      } catch (e) { /* ignore */ }
      try { localStorage.removeItem('maut:' + key); } catch (e) { /* ignore */ }
    },
  };

  // Settings that no longer exist. Cleared on every load so a leftover can
  // never be mistaken for a live one. `hookLog` was 1.0.25's record of how
  // the old traps fared; there are no traps left to record.
  for (const key of ['layoutPos', 'layoutSeen', 'layoutHidden', 'layoutMapFixed',
    'gameStats', 'statsHidden', 'statsColor', 'hookLog']) {
    store.remove(key);
  }

  // 120 is NEUTRAL, not a middle: at that value the multiplier is exactly 1
  // and every animal turns at mope's own rate, so the setting reads as a
  // percentage of native (30 is a quarter speed, 480 four times).
  const TURN_MIN = 30;
  const TURN_MAX = 480;
  const TURN_STEP = 30;
  const TURN_NEUTRAL = 120;
  const TURN_STYLES = [
    ['linear', 'Linear'],
    ['ease-out', 'Ease out'],
    ['ease-in', 'Ease in'],
    ['instant', 'Instant'],
  ];

  function normalizeTurnSpeed(value) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) return TURN_NEUTRAL;
    return Math.min(Math.max(number, TURN_MIN), TURN_MAX);
  }

  function normalizeTurnStyle(value) {
    const name = String(value);
    for (const [id] of TURN_STYLES) if (id === name) return id;
    return 'linear';
  }

  const HP_UNIT_MODES = [
    ['percent', 'Percentage'],
    ['hp', 'Hit points'],
  ];

  const CHAT_SLOTS = 5;
  const CHAT_MAX_LEN = 35;

  function chatCleanSlots(value) {
    const out = [];
    const list = Array.isArray(value) ? value : [];
    for (let i = 0; i < CHAT_SLOTS; i++) {
      const raw = typeof list[i] === 'string' ? list[i] : '';
      out.push(raw.replace(/[\r\n\t]+/g, ' ').slice(0, CHAT_MAX_LEN));
    }
    return out;
  }

  const settings = {
    masterEnabled: !!store.get('masterEnabled', true),
    menuClutter: !!store.get('menuClutter', false),
    gameClutter: !!store.get('gameClutter', false),
    abilityCooldown: !!store.get('abilityCooldown', true),
    hpNumbers: !!store.get('hpNumbers', true),
    hpBar: !!store.get('hpBar', true),
    hpUnits: store.get('hpUnits', 'percent') === 'hp' ? 'hp' : 'percent',
    quickChat: !!store.get('quickChat', false),
    boostCounter: !!store.get('boostCounter', false),
    chatSlots: chatCleanSlots(store.get('chatSlots', null)),
    cameraZoom: !!store.get('cameraZoom', false),
    turnSpeed: !!store.get('turnSpeed', false),
    arenaSky: !!store.get('arenaSky', false),
    arenaTheme: String(store.get('arenaTheme', 'starfield') || 'starfield'),
    panelTheme: String(store.get('panelTheme', 'teal') || 'teal'),
    zorderMode: (() => { const v = Number(store.get('zorderMode', 0)); return v === 1 || v === -1 ? v : 0; })(),
    arenaFocus: !!store.get('arenaFocus', false),
    biteIndicator: !!store.get('biteIndicator', false),
    turnSpeedValue: normalizeTurnSpeed(store.get('turnSpeedValue', TURN_NEUTRAL)),
    turnStyle: normalizeTurnStyle(store.get('turnStyle', 'linear')),
    debug: !!store.get('debug', false),
    updateCheck: store.get('updateCheck', true) !== false,
  };

  function dbg(...args) { if (settings.debug) console.log(TAG, ...args); }

  // Exposes a console helper on the page. Every debug function goes through
  // here so a locked-down page costs one try, not twenty.
  function expose(name, fn) {
    try { PAGE[name] = fn; } catch (e) { /* page is locked down */ }
  }

  /* ------------------------------------------------- overlay placement */

  function layoutVmin() {
    return Math.max(1, Math.min(innerWidth, innerHeight) / 100);
  }

  function layoutStyle(el, prop, value) {
    if (el.style[prop] !== value) el.style[prop] = value;
  }

  function layoutPlace(el, anchored) {
    if (!anchored) return null;
    const left = Math.round(anchored.left);
    const top = Math.round(anchored.top);
    layoutStyle(el, 'left', left + 'px');
    layoutStyle(el, 'top', top + 'px');
    return {left, top};
  }

  // Every surface this script owns has an id starting `qolc-`, and colour
  // sweeps and clutter hiders skip anything inside one.
  const QOLC_OWN_UI = '[id^="qolc-"]';

  // The panel. Declared up here because many features re-sync their row
  // when they change, long before the panel code further down is reached.
  let extras = null;

  // Row re-syncs, assigned when the panel is built. Until then they exist and
  // do nothing, so a hotkey pressed before the panel was ever opened is safe.
  let syncHpBarRow = () => {};
  let syncHpUnitsRow = () => {};
  let syncPartyListSubRows = () => {};
  let syncArenaSkyRow = () => {};
  let syncArenaThemeRow = () => {};
  let syncZorderRows = () => {};
  let syncKeybinds = () => {};
  let syncChatRows = () => {};
  let syncTroubleshootingUI = () => {};
  // Called from every path that takes the panel off screen, so a half-done
  // rebind can never leave every hotkey dead.
  let kbCancelCapture = () => {};

  /* ------------------------------------------------- the on-screen toast */

  const qolcToastState = {el: null, timer: 0};
  const QOLC_TOAST_MS = 2600;

  // One line, centred above the middle of the screen. Default pink; 'is-bad'
  // and 'is-info' recolour it, 'quiet' is a softer neutral.
  function qolcToast(text, cls, ms) {
    try {
      if (!qolcToastState.el || !qolcToastState.el.isConnected) {
        const host = document.body || document.documentElement;
        if (!host) return;
        qolcToastState.el = document.getElementById('qolc-party-toast') ||
          document.createElement('div');
        qolcToastState.el.id = 'qolc-party-toast';
        host.appendChild(qolcToastState.el);
      }
      const el = qolcToastState.el;
      el.textContent = text;
      el.className = cls || '';
      el.style.display = 'block';
      clearTimeout(qolcToastState.timer);
      qolcToastState.timer = setTimeout(() => {
        if (qolcToastState.el) qolcToastState.el.style.display = 'none';
      }, ms || QOLC_TOAST_MS);
    } catch (e) { /* the message is a courtesy; never let it break the caller */ }
  }

  /* ------------------------------------------------------ feature errors */

  // A feature that throws inside the frame loop is recorded and switched off
  // for that frame only — it never takes the game's own drawing down with it.
  const featureErrors = new Map();   // name -> {count, last, at}

  function frameFailed(name, error) {
    const row = featureErrors.get(name) || {count: 0, last: '', at: 0};
    row.count += 1;
    row.last = String(error && error.stack || error).slice(0, 400);
    row.at = Math.round(performance.now());
    featureErrors.set(name, row);
    if (row.count === 1 || settings.debug) console.warn(TAG, name + ' failed:', error);
  }

  /* ============================ the game bridge ============================
   *
   * HOW THIS SCRIPT REACHES THE GAME.
   *
   * mope's client is a Vite build: an entry module plus a handful of chunks
   * that import from each other. The game chunk (the camera, the network and
   * every entity class) is imported by the UI chunk, so it EXPORTS what the
   * UI needs — and that includes the game singleton `$` itself, the base
   * Entity class with its live registry (`Entity.list`, a Map of every entity
   * the client knows), the Animal class, and the Svelte stores behind the HUD
   * (ability cooldowns, XP and resources, the arena, the leaderboard).
   *
   * A module is evaluated once per page, and `import(url)` with a URL that is
   * already in the page's module map hands back THAT instance. So this script,
   * running in the page (the extension's MAIN world, or a userscript under
   * @grant none), imports the game chunk after mope has loaded it and gets the
   * very `$` the game is running on. Nothing is patched or trapped, nothing has
   * to be in place before mope starts, and the import can happen a millisecond
   * or an hour after the page loads with the same answer.
   *
   * The modpacks (Nova, angelwings) instead swap mope's game chunk for a copy
   * edited to put `$` on window. That copy is pinned to one build, so every
   * mope deploy leaves them running stale game code until their author ships
   * a new copy. This reads the build that is actually running, whatever its
   * file names are this week.
   *
   * WHAT COULD STILL BREAK IT, said plainly. The exports are recognised by
   * SHAPE — the game is the object with camera + network + settings + loop;
   * Entity is the class with `list` and `dynamicList` Maps and static
   * `create`/`get` — never by their minified names, which change every build.
   * If mope renames one of those properties the fingerprint misses, and
   * bridge.status() (Settings → Troubleshooting, or __lumi.status()) names
   * exactly which piece is missing. Nothing guesses around a miss.
   */

  // How the bridge recognises each piece of mope, by SHAPE. Top-level so the
  // tests can run them against fixtures and against mope's real classes.
  function mopeHasKeys(value, keys) {
    for (const key of keys) {
      if (!(key in value)) return false;
    }
    return true;
  }

  function mopeIsGame(value) {
    return !!value && typeof value === 'object' &&
      mopeHasKeys(value, ['camera', 'network', 'settings', 'loop']) &&
      !!value.loop && typeof value.loop === 'object';
  }

  // The BASE entity class. Every entity subclass inherits these statics
  // (and declares a `list` of its own), so the test is that `dynamicList`
  // is the class's OWN property — only the base declares it.
  function mopeIsEntityClass(value) {
    const own = Object.prototype.hasOwnProperty;
    return typeof value === 'function' &&
      own.call(value, 'dynamicList') && value.dynamicList instanceof Map &&
      value.list instanceof Map &&
      typeof value.create === 'function' && typeof value.get === 'function';
  }

  // The base Animal class, not a species subclass: it is the one that
  // declares these methods itself.
  function mopeIsAnimalClass(value) {
    const own = Object.prototype.hasOwnProperty;
    const proto = typeof value === 'function' && value.prototype;
    return !!proto && own.call(proto, 'isUsingAbility1') &&
      own.call(proto, 'setOutlineColor') && typeof proto.update === 'function';
  }

  // The animal config table: one entry per species, keyed by name, each with
  // comfortZones, biome and subspeciesEnum.
  function mopeIsConfigTable(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const mouse = value.mouse;
    return !!mouse && typeof mouse === 'object' && 'comfortZones' in mouse &&
      'subspeciesEnum' in mouse && 'king_dragon' in value;
  }

  const bridge = (function () {
    const state = {
      phase: 'waiting for the page',
      modules: [],          // same-origin module URLs that were examined
      failures: [],         // {url, error}
      game: null,           // mope's `$`
      Entity: null,         // base entity class; .list is the live registry
      Animal: null,         // animal class (prototype has isUsingAbility1)
      configs: null,        // species name -> animal config
      stores: {},           // named Svelte stores, see STORE_SHAPES
      foundAt: 0,           // performance.now() when the game was found
      attempts: 0,
    };
    const waiters = [];

    // Svelte `$state` stores the HUD is built from, recognised by their keys.
    // Each is a deep proxy; reading through it is safe and cheap.
    const STORE_SHAPES = {
      // {..., hasAbility1, animalBiome, equippedItemId, cooldowns: {ability1,
      //  ability2, dive, arena: {startsAt, endsAt, active, disabled}}}
      // The times are performance.now() milliseconds.
      hud: ['cooldowns', 'hasAbility1', 'animalBiome', 'equippedItemId'],
      // {oxygen, resource, xp, coins, coinsEarnedThisLife, gems, ...}
      stats: ['oxygen', 'resource', 'xp', 'coins'],
      // {show1v1Button, request, showUI}
      arena: ['show1v1Button', 'request', 'showUI'],
      // {serverName, entries}
      leaderboard: ['serverName', 'entries'],
      // {currentScreen: 'menu' | 'HUD' | 'spectating' | 'banned', ...}
      ui: ['currentScreen', 'showSettings'],
      // {visible, timeAlive, kills, ...} — the death screen
      death: ['timeAlive', 'kills', 'killerName'],
    };


    // Every same-origin module the page has asked for: the entry script and
    // the modulepreload links Vite writes for its static imports. Their URLs
    // change on every deploy, which is why they are read off the page rather
    // than written down here.
    function moduleUrls() {
      const urls = [];
      const nodes = document.querySelectorAll(
        'script[type="module"][src], link[rel="modulepreload"][href]');
      for (const node of nodes) {
        try {
          const url = new URL(node.getAttribute('src') || node.getAttribute('href'),
            location.href);
          if (url.origin !== location.origin) continue;
          if (urls.indexOf(url.href) === -1) urls.push(url.href);
        } catch (e) { /* a malformed attribute is not ours to fix */ }
      }
      return urls;
    }

    function examine(namespace) {
      for (const key of Object.keys(namespace)) {
        let value;
        // An export still in its temporal dead zone throws on read.
        try { value = namespace[key]; } catch (e) { continue; }
        if (!value || (typeof value !== 'object' && typeof value !== 'function')) continue;
        try {
          if (!state.game && mopeIsGame(value)) state.game = value;
          else if (!state.Animal && mopeIsAnimalClass(value)) state.Animal = value;
          else if (!state.Entity && mopeIsEntityClass(value)) state.Entity = value;
          else if (!state.configs && mopeIsConfigTable(value)) state.configs = value;
          else if (typeof value === 'object') {
            for (const name of Object.keys(STORE_SHAPES)) {
              if (!state.stores[name] && mopeHasKeys(value, STORE_SHAPES[name])) {
                state.stores[name] = value;
                break;
              }
            }
          }
        } catch (e) { /* a getter that throws is simply not a match */ }
      }
    }

    function complete() {
      return !!(state.game && state.Entity && state.Animal && state.configs &&
        Object.keys(STORE_SHAPES).every((name) => state.stores[name]));
    }

    // Every module namespace imported so far. Exports are LIVE bindings, so a
    // piece assigned after the first look shows up when the same namespace is
    // examined again — which is why each attempt re-examines all of them
    // rather than only the URLs it has not seen.
    const namespaces = [];

    async function discover() {
      state.attempts++;
      if (!state.game) state.phase = 'importing mope\'s modules';
      const urls = moduleUrls();
      for (const url of urls) {
        if (state.modules.indexOf(url) !== -1) continue;
        state.modules.push(url);
        try {
          // The SAME instance the page is running, because the URL is the
          // module map's key. See the block comment above.
          namespaces.push(await import(url));
        } catch (error) {
          state.failures.push({url, error: String(error && error.message || error)});
        }
      }
      for (const namespace of namespaces) {
        examine(namespace);
        if (complete()) break;
      }
      if (state.game) {
        if (!state.foundAt) {
          state.foundAt = performance.now();
          dbg('bridge: game found after', Math.round(state.foundAt), 'ms;', status());
        }
        state.phase = complete() ? 'ready' : 'ready (some optional pieces missing)';
        while (waiters.length) {
          const resolve = waiters.shift();
          try { resolve(state.game); } catch (e) { /* one listener cannot stop the rest */ }
        }
        return complete();
      }
      state.phase = urls.length ? 'the game was not among ' + urls.length + ' modules'
        : 'no modules on the page yet';
      return false;
    }

    // DOMContentLoaded comes after every non-async module script has run, so
    // by then the entry (and through it the game chunk) has been evaluated.
    // Until EVERYTHING is found — the game and every optional piece — it keeps
    // looking, backing off to once every five seconds: a redeploy that moved
    // something behind a dynamic import shows up as modules appearing later.
    let started = false;
    function start() {
      if (started) return;
      started = true;
      let delay = 250;
      const attempt = () => {
        discover().then((done) => {
          if (done) return;
          delay = Math.min(delay * 2, 5000);
          setTimeout(attempt, delay);
        }, (error) => {
          state.failures.push({url: '(discover)', error: String(error)});
          setTimeout(attempt, 5000);
        });
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', attempt, {once: true});
      } else {
        attempt();
      }
    }

    function status() {
      return {
        phase: state.phase,
        game: !!state.game,
        entityRegistry: !!state.Entity,
        animalClass: !!state.Animal,
        animalConfigs: !!state.configs,
        stores: Object.keys(STORE_SHAPES).map((name) =>
          name + (state.stores[name] ? ' ok' : ' MISSING')).join(', '),
        modulesExamined: state.modules.length,
        failures: state.failures.slice(-5),
        foundAfterMs: state.foundAt ? Math.round(state.foundAt) : null,
        attempts: state.attempts,
      };
    }

    return {
      start,
      status,
      complete,
      // Resolves with `$` once it is known — immediately if it already is.
      ready() {
        if (state.game) return Promise.resolve(state.game);
        return new Promise((resolve) => waiters.push(resolve));
      },
      get game() { return state.game; },
      get Entity() { return state.Entity; },
      get Animal() { return state.Animal; },
      get configs() { return state.configs; },
      store(name) { return state.stores[name] || null; },
    };
  })();

  /* ---------------------------------------------------- reading the game */

  // mope's settings object (a Svelte deep proxy). Plain assignment through it
  // is how mope's own settings UI writes, and mope persists the result.
  function mopeSettingsProxy() {
    const game = bridge.game;
    const value = game && game.settings;
    return value && typeof value === 'object' ? value : null;
  }

  // The name of mope's own action bound to a key code, or null.
  function mopeBindFor(code) {
    const proxy = mopeSettingsProxy();
    if (!proxy) return null;
    try {
      const binds = proxy.binds;
      if (!binds || typeof binds !== 'object') return null;
      for (const action of Object.keys(binds)) {
        const list = binds[action];
        if (!Array.isArray(list)) continue;
        for (const bind of list) {
          if (bind && bind.code === code) return action;
        }
      }
    } catch (e) { return null; }
    return null;
  }

  // Which screen mope says it is on: 'menu', 'HUD' (playing), 'spectating'
  // or 'banned'. Before the bridge is up the answer is 'menu', which is the
  // screen every page load starts on.
  function mopeScreen() {
    const ui = bridge.store('ui');
    if (ui) {
      try {
        const screen = ui.currentScreen;
        if (typeof screen === 'string') return screen;
      } catch (e) { /* fall through */ }
    }
    const game = bridge.game;
    return game && game.player ? 'HUD' : 'menu';
  }

  function inGame() { return mopeScreen() === 'HUD'; }
  function onMenu() { return mopeScreen() === 'menu'; }

  // Your own animal while you are playing, otherwise null. mope sets
  // `$.player` when the server tells it which entity is yours and clears it
  // on death, so this is authoritative — nothing here ever infers it.
  function myAnimal() {
    const game = bridge.game;
    const player = game && game.player;
    if (!player || player.destroyed || player.spawned === false) return null;
    if (!player.container || player.container.destroyed) return null;
    return player;
  }

  // Every live animal the client knows about, yours included. The registry
  // holds every entity — food, trees, all of it — so the filtered list is
  // built once per frame and shared by every feature that asks.
  const animalCache = {frame: -1, at: -Infinity, list: []};

  function liveAnimals() {
    const now = performance.now();
    if (animalCache.frame === frame.frames && now - animalCache.at < 50) return animalCache.list;
    const out = [];
    const Entity = bridge.Entity;
    if (Entity) {
      for (const entity of Entity.list.values()) {
        if (!entity || entity.type !== 'animal') continue;
        if (entity.spawned === false || !entity.container || entity.container.destroyed) continue;
        out.push(entity);
      }
    }
    animalCache.frame = frame.frames;
    animalCache.at = now;
    animalCache.list = out;
    return out;
  }

  // An animal's server health, 0-100. mope receives one byte per animal and
  // never anything finer; there is no hit-point figure anywhere client-side.
  function healthOf(entity) {
    const target = entity && entity.target;
    const value = target && target.health;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  /* ----- what animal is this ----- */

  // Every species with a known tier, which doubles as the list a shop skin id
  // is matched against (skin ids are `<species>_<skin>`).
  const SPECIES_BY_TIER = [
    ['mouse', 'shrimp', 'chipmunk', 'kangaroo_rat', 'lemming'],
    ['rabbit', 'pigeon', 'trout', 'arctic_hare', 'desert_chipmunk'],
    ['mole', 'chicken', 'crab', 'penguin', 'meerkat', 'baby_duck'],
    ['pig', 'woodpecker', 'sea_horse', 'seal', 'armadillo'],
    ['deer', 'flamingo', 'squid', 'reindeer', 'gazelle', 'girabie'],
    ['hedgehog', 'fox', 'peacock', 'jellyfish', 'arctic_fox', 'fennec_fox', 'bee', 'momaffie'],
    ['zebra', 'donkey', 'macaw', 'turtle', 'muskox', 'warthog', 'frog', 'duck', 'angry_duck'],
    ['cobra', 'cheetah', 'stingray', 'snowy_owl', 'wolf', 'camel', 'snail'],
    ['toucan', 'gorilla', 'pufferfish', 'snow_leopard', 'rattle_snake'],
    ['bear', 'lion', 'pelican', 'swordfish', 'walrus', 'hyena', 'gobi_bear'],
    ['tiger', 'crocodile', 'falcon', 'octopus', 'markhor', 'wolverine', 'vulture'],
    ['rhinoceros', 'eagle', 'giraffe', 'shark', 'polar_bear', 'bison'],
    ['hippopotamus', 'boa', 'ostrich', 'ostrich_baby', 'orca', 'sabertooth_tiger', 'komodo_dragon'],
    ['elephant', 'cassowary', 'giant_spider', 'blue_whale', 'mammoth', 'black_widow'],
    ['dragon', 'trex', 'phoenix', 'king_crab', 'kraken', 'yeti', 'pterodactyl'],
    ['dino_monster', 'lava_monster', 'sea_monster', 'ice_monster', 'giant_scorpion'],
    ['black_dragon', 'king_dragon'],
  ];
  const KNOWN_SPECIES = new Set([].concat(...SPECIES_BY_TIER));

  // mope's species enum (number -> name) is not exported, so the names are
  // learned: an unskinned animal's texturePath spells its species out, and a
  // skinned one's item id starts with it. Learned once per species number.
  const speciesNames = new Map();
  const TEXTURE_SPECIES_RE = /animals\/([a-z_]+)\/([a-z_0-9]+)\/(?:([a-z_0-9]+)\/)?$/;

  function speciesFromItemId(id) {
    let best = '';
    for (const species of KNOWN_SPECIES) {
      if (species.length <= best.length) continue;
      if (id === species || id.indexOf(species + '_') === 0) best = species;
    }
    return best;
  }

  function speciesOf(entity) {
    if (!entity || typeof entity.species !== 'number') return '';
    const known = speciesNames.get(entity.species);
    if (known) return known;
    let name = '';
    try {
      if (!entity.equippedItemId) {
        const m = TEXTURE_SPECIES_RE.exec(String(entity.texturePath || ''));
        if (m) name = m[2];
      } else {
        name = speciesFromItemId(String(entity.equippedItemId));
      }
    } catch (e) { name = ''; }
    // Only a texture path is proof of the number -> name pairing; a skin id
    // prefix is a good guess for this animal but is not cached for others.
    if (name && !entity.equippedItemId) speciesNames.set(entity.species, name);
    return name;
  }

  // The rare variant's directory name ('fiery', 'harpy'), or '' for the
  // default. mope's own rule: the subspecies enum name, lowercased, unless it
  // is DEFAULT. (A few species name their default — the toucan's is TOCO —
  // so `rareOf` can be non-empty on an animal that is not a rare roll; see
  // isRareRoll.)
  function rareOf(entity) {
    try {
      const config = entity && entity.animalConfig;
      const names = config && config.subspeciesEnum;
      const name = names && names[entity.subspecies];
      if (!name || name === 'DEFAULT') return '';
      return String(name).toLowerCase();
    } catch (e) { return ''; }
  }

  function isRareRoll(entity) {
    return !!entity && typeof entity.subspecies === 'number' && entity.subspecies > 0;
  }

  // The biome mope files the animal's art under.
  function artBiomeOf(entity) {
    try {
      const config = entity.animalConfig;
      const resource = config && config.animalResource;
      if (resource && resource.type === 1) return 'volcano';   // lava
      return config && typeof config.biome === 'string' ? config.biome : '';
    } catch (e) { return ''; }
  }

  // 'species' or 'species/rare' — the identity the party list sends, so the
  // receiver can draw the animal's own art.
  function artKeyOf(entity) {
    const species = speciesOf(entity);
    if (!species) return '';
    const rare = rareOf(entity);
    return rare ? species + '/' + rare : species;
  }

  /* ------------------------------------------------------ the frame hook */

  // Features that draw run once per frame the game draws, straight after
  // mope's own renderer.render() — so a DOM overlay is positioned against the
  // frame that was just put on screen. mope does not draw in a hidden tab, so
  // neither do these; anything that must keep going there uses a timer.
  //
  // The wrapper goes on the renderer INSTANCE, found at $.loop.renderer. If
  // mope rebuilds its renderer (switching WebGL/WebGPU in its settings), the
  // watchdog below notices the new instance within a second and wraps that.
  const frame = {
    hooks: [],            // {name, fn}
    renderer: null,       // the instance currently wrapped
    original: null,
    wrapper: null,
    frames: 0,
    lastAt: 0,
    fallbackRaf: 0,
  };

  function onFrame(name, fn) {
    frame.hooks.push({name, fn});
  }

  function runFrameHooks(now) {
    frame.frames++;
    frame.lastAt = now;
    if (!bridge.game) return;
    for (const hook of frame.hooks) {
      try { hook.fn(now); } catch (e) { frameFailed(hook.name, e); }
    }
  }

  // Each renderer instance is wrapped ONCE, and the wrapper runs every
  // runner registered on the page — so two copies of this script (or the
  // watchdog firing again) can never stack wrapper on wrapper and run every
  // feature twice per frame. The flag lives on the renderer itself, so a
  // rebuilt renderer is a fresh instance and gets wrapped in its turn.
  function frameRunners() {
    let runners = null;
    try {
      runners = PAGE.__lumiFrameRunners;
      if (!Array.isArray(runners)) runners = PAGE.__lumiFrameRunners = [];
    } catch (e) { runners = []; }
    if (runners.indexOf(runFrameHooks) === -1) runners.push(runFrameHooks);
    return runners;
  }

  function wrapRenderer() {
    const game = bridge.game;
    const loop = game && game.loop;
    const renderer = loop && loop.renderer;
    if (!renderer || typeof renderer.render !== 'function') return false;
    const runners = frameRunners();
    if (renderer.__lumiFrameWrapped) { frame.renderer = renderer; return true; }
    const original = renderer.render;
    const wrapper = function () {
      const result = original.apply(this, arguments);
      const now = performance.now();
      for (let i = 0; i < runners.length; i++) {
        try { runners[i](now); } catch (e) { /* one copy cannot stop another */ }
      }
      return result;
    };
    try {
      renderer.render = wrapper;
      Object.defineProperty(renderer, '__lumiFrameWrapped', {value: true, configurable: true});
    } catch (e) {
      return false;
    }
    frame.renderer = renderer;
    frame.original = original;
    frame.wrapper = wrapper;
    dbg('frame hook: wrapped the renderer');
    return true;
  }

  // The canvas mope draws into, and how renderer units map onto CSS pixels.
  const screenCache = {at: -Infinity, rect: null, w: 0, h: 0};

  function canvasRect(now) {
    if (now - screenCache.at < 250 && screenCache.rect) return screenCache;
    const game = bridge.game;
    const loop = game && game.loop;
    const canvas = loop && loop.canvas;
    const renderer = loop && loop.renderer;
    if (!canvas || !canvas.getBoundingClientRect) return null;
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return null;
    const screen = renderer && renderer.screen;
    screenCache.w = screen && screen.width > 0 ? screen.width : rect.width;
    screenCache.h = screen && screen.height > 0 ? screen.height : rect.height;
    screenCache.rect = rect;
    screenCache.at = now;
    return screenCache;
  }

  // Where a Pixi node is drawn, in CSS pixels of the viewport. Uses the
  // transform from the frame just rendered.
  function screenPosOf(node, now) {
    const wt = node && node.worldTransform;
    if (!wt || !Number.isFinite(wt.tx) || !Number.isFinite(wt.ty)) return null;
    const view = canvasRect(now || performance.now());
    if (!view) return null;
    return {
      x: view.rect.left + wt.tx * (view.rect.width / view.w),
      y: view.rect.top + wt.ty * (view.rect.height / view.h),
    };
  }

  function startFrameHook() {
    // Checked once a second: cheap, and it is what picks up a rebuilt
    // renderer. Until a renderer exists (the menu, before the first game
    // loads its assets) there is simply nothing to wrap.
    setInterval(() => {
      try { wrapRenderer(); } catch (e) { frameFailed('frame hook', e); }
      // Also picks up the Animal class if the bridge found it late.
      try { turnInstall(); } catch (e) { frameFailed('turn speed', e); }
    }, 1000);
    wrapRenderer();
  }

  // Whether a Pixi node is actually drawn: it and every ancestor visible and
  // not fully transparent, all the way up to a stage.
  function nodeShown(node) {
    let n = node;
    for (let depth = 0; n && depth < 32; depth++) {
      if (n.destroyed || n.visible === false || n.renderable === false || n.alpha === 0) return false;
      if (!n.parent) return true;
      n = n.parent;
    }
    return !!n;
  }

  /* ==================== shared camera-zoom hub ====================
   *
   * ONE zoom, owned by ONE piece of code, shared by every Lumi script on the
   * page (Lumi's Extras and Lumi's Moderator Extras). Whichever runs first
   * builds the hub on `window.__lumiZoomHub`; the other joins it. A newer
   * revision replaces an older hub outright and calls its retire().
   *
   * REVISION 4 (Extras 1.1.0) keeps revision 3's public API exactly —
   * join(id, {onChange, showToast, ignoreEvent, toastPriority, zoomPriority,
   * panelSource}) -> {setActive, leave}, getLevel/setLevel, hooked, rehook,
   * status, note, preemptedBy, ownerId — so Moderator Extras joins it
   * unchanged. What changed is how the camera is found: revision 3 trapped
   * it with Object.prototype setters and a per-frame probe, because the
   * camera was unreachable. It is reachable now — the game bridge hands over
   * `$` and `$.camera` comes with it — so there is no trap, no probe and no
   * race: the hook goes on the moment the bridge is ready.
   *
   * WHERE THE HOOK GOES. mope's camera does, every frame,
   *
   *     this.zoom = lerp(this.zoom, this.target.zoom / clamp(rendering.zoom)
   *                                  * resolution, ...)
   *
   * so `camera.target.zoom` is the one number the whole view is derived
   * from. It is written in exactly one place (synchronize(), from the
   * server's camera packet) and read in exactly one (the line above). An
   * accessor there scales the view, and everything downstream follows —
   * including the pointer position SENT TO THE SERVER, which toGlobalPoint()
   * divides by camera.zoom. Scaling the Pixi container instead would look
   * right and aim wrong.
   *
   * mope's own wheel zoom (`rendering.zoom`) is a divisor clamped to at most
   * 1, so it can only zoom IN, and mope saves it. The hub owns the wheel on
   * the window at capture phase so a notch never reaches mope's listener on
   * the canvas, and Extras holds mope's value at 1 while its zoom is on.
   */

  const ZOOM_HUB_KEY = '__lumiZoomHub';
  const ZOOM_HUB_REV = 4;

  function buildZoomHub(previous) {
    // Shared, so both panels always read the same number.
    const LEVEL_STORAGE_KEY = 'lumi:zoom:v1:level';
    const MIN = 0.5, MAX = 1.5, STEP = 0.1;

    function normalize(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return 1;
      return Math.round(Math.min(Math.max(number, MIN), MAX) * 10) / 10;
    }

    function readStoredLevel() {
      try {
        const raw = localStorage.getItem(LEVEL_STORAGE_KEY);
        if (raw !== null) return normalize(JSON.parse(raw));
      } catch (e) { /* privacy-restricted storage */ }
      return 1;
    }

    const state = {
      level: readStoredLevel(),
      camera: null,
      target: null,
      holder: null,
      getter: null,
      hookedVia: '',
      reHooks: 0,
      rehookRequests: 0,
      tookOverForeignHook: false,
      retired: false,
    };

    // An older hub's level is worth carrying over; its hook is not.
    if (previous) {
      try {
        const carried = normalize(previous.getLevel());
        if (carried !== 1) state.level = carried;
      } catch (e) { /* an unrecognisable old hub is simply ignored */ }
    }

    // id -> {id, active, onChange, showToast, ignoreEvent, toastPriority,
    //        zoomPriority, panelSource}
    const members = new Map();

    // The active member with the highest zoomPriority drives the camera.
    // Ties keep the first joiner.
    function owner() {
      let best = null;
      for (const member of members.values()) {
        if (!member.active) continue;
        if (!best || member.zoomPriority > best.zoomPriority) best = member;
      }
      return best;
    }

    function anyActive() {
      return !!owner();
    }

    // Which member, if any, has taken the camera off `id` — '' for nobody.
    function preemptedBy(id) {
      const member = members.get(id);
      if (!member) return '';
      let top = '';
      let best = -Infinity;
      for (const other of members.values()) {
        if (other === member || !other.active) continue;
        if (other.zoomPriority <= member.zoomPriority) continue;
        if (other.zoomPriority > best) { best = other.zoomPriority; top = other.id; }
      }
      return top;
    }

    // Off everywhere collapses to 1, which is why nothing has to be un-applied
    // when a switch goes off: the next frame simply reads the native value.
    function factor() {
      return anyActive() ? state.level : 1;
    }

    /* ----- the camera hook ----- */

    function hookTarget(camera, target, via) {
      if (!target || typeof target !== 'object') return false;
      let native = NaN;
      let existing = null;
      try { existing = Object.getOwnPropertyDescriptor(target, 'zoom'); } catch (e) { return false; }
      if (existing && typeof existing.get === 'function') {
        if (existing.get === state.getter) return true;   // already ours
        // Someone else's accessor (an older Lumi hub that did not let go).
        // Its current reading is the best guess at the native value.
        state.tookOverForeignHook = true;
        try { native = Number(existing.get.call(target)); } catch (e) { native = NaN; }
      } else if (existing && 'value' in existing) {
        native = Number(existing.value);
      }
      if (!Number.isFinite(native) || native <= 0) native = 1;
      const holder = {native};
      const getter = function () {
        const scaled = holder.native * factor();
        return Number.isFinite(scaled) && scaled > 0 ? scaled : holder.native;
      };
      // A setter as well as a getter: mope's bundle is a strict-mode module,
      // and its synchronize() writing target.zoom would THROW against a
      // getter-only accessor and take the game down.
      const setter = function (value) {
        const number = Number(value);
        if (Number.isFinite(number) && number > 0) holder.native = number;
      };
      try {
        Object.defineProperty(target, 'zoom', {
          configurable: true, enumerable: true, get: getter, set: setter,
        });
      } catch (e) { return false; }
      state.camera = camera;
      state.target = target;
      state.holder = holder;
      state.getter = getter;
      if (via) state.hookedVia = via;
      return true;
    }

    // The camera is `$.camera`, straight from the game bridge. Called every
    // two seconds: it hooks the camera the first time it can, notices a
    // rebuilt camera or target, and puts the accessor back if anything
    // replaced it.
    function repair() {
      if (state.retired) return;
      try {
        const game = bridge.game;
        const camera = game && game.camera;
        const target = camera && camera.target;
        if (!target || typeof target !== 'object') return;
        if (target !== state.target) {
          state.getter = null;
          if (hookTarget(camera, target, 'the game bridge ($.camera)') && state.camera) {
            dbg('zoom hub: hooked $.camera.target.zoom');
          }
          return;
        }
        const descriptor = Object.getOwnPropertyDescriptor(target, 'zoom');
        if (!descriptor || descriptor.get !== state.getter) {
          state.reHooks += 1;
          state.getter = null;
          hookTarget(camera, target, state.hookedVia || 'repair');
        }
      } catch (e) { /* a repair attempt must never be the thing that breaks */ }
    }

    function rehook() {
      state.rehookRequests += 1;
      repair();
      return status();
    }

    setInterval(repair, 2000);
    bridge.ready().then(repair);

    /* ----- the number itself ----- */

    function notify(source, changed) {
      for (const member of members.values()) {
        if (!member.onChange) continue;
        try {
          member.onChange({level: state.level, source, changed});
        } catch (e) { /* one panel's redraw must not stop another's */ }
      }
    }

    // Exactly one readout. The script whose own panel asked gets first
    // refusal; otherwise the highest toastPriority goes first. A readout that
    // cannot be drawn right now returns false and the next one draws instead.
    function announce(source) {
      const ordered = [...members.values()]
        .sort((a, b) => b.toastPriority - a.toastPriority);
      const asked = ordered.filter((m) => m.panelSource && m.panelSource === source);
      const rest = ordered.filter((m) => !m.panelSource || m.panelSource !== source);
      for (const member of asked.concat(rest)) {
        if (!member.showToast) continue;
        try { if (member.showToast() !== false) return; } catch (e) { /* try the next */ }
      }
    }

    // `changed` is passed through so a step taken at the end of the range
    // still shows a readout: zoom-out at 50% should say 50%, not look dead.
    function setLevel(value, source) {
      const next = normalize(value);
      const changed = next !== state.level;
      if (changed) {
        state.level = next;
        try { localStorage.setItem(LEVEL_STORAGE_KEY, JSON.stringify(next)); }
        catch (e) { /* privacy-restricted storage */ }
      }
      notify(source || 'hub', changed);
      if (source !== 'migrate') announce(source || 'hub');
      return changed;
    }

    /* ----- input, owned here so there is exactly one of each ----- */

    function inputBusy() {
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' ||
          active.tagName === 'SELECT' || active.isContentEditable)) return true;
      if (document.getElementById('chatInput')) return true;
      return false;
    }

    function vetoed(event) {
      for (const member of members.values()) {
        if (!member.ignoreEvent) continue;
        try { if (member.ignoreEvent(event)) return true; } catch (e) { /* ignore */ }
      }
      return false;
    }

    // The game surface and nothing else: an event that landed on a panel, a
    // menu or a list belongs to whatever it landed on.
    function onGameSurface(target) {
      if (!(target instanceof Element)) return false;
      return target.tagName === 'CANVAS' ||
        target === document.body || target === document.documentElement;
    }

    function ready() {
      return !state.retired && anyActive() && !!document.querySelector('canvas');
    }

    // Trackpads emit many tiny deltas, so a step is taken only once enough
    // distance has built up in one direction — below one mouse notch, and at
    // most one step per event.
    const WHEEL_THRESHOLD = 40;
    let wheelDelta = 0;

    PAGE.addEventListener('wheel', (event) => {
      if (!event.isTrusted || event.ctrlKey || event.altKey || event.metaKey) return;
      if (!ready() || inputBusy()) return;
      if (!onGameSurface(event.target) || vetoed(event)) return;
      // Taken whether or not it moves our number: otherwise mope's own wheel
      // zoom quietly takes the notch instead and the two drift apart.
      event.preventDefault();
      event.stopPropagation();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
      const delta = event.deltaY * scale;
      if (delta === 0) return;
      if ((delta > 0) !== (wheelDelta > 0)) wheelDelta = 0;
      wheelDelta += delta;
      if (Math.abs(wheelDelta) < WHEEL_THRESHOLD) return;
      const step = wheelDelta > 0 ? -1 : 1;
      wheelDelta = 0;
      setLevel(state.level + step * STEP, 'wheel');
    }, {capture: true, passive: false});

    PAGE.addEventListener('keydown', (event) => {
      if (!event.isTrusted || event.repeat) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      // The panel is waiting for a key to bind, so this one is not ours.
      if (typeof kbCapturing === 'function' && kbCapturing()) return;
      const out = event.code === 'Minus' || event.key === '-';
      const into = event.code === 'Equal' || event.key === '=' || event.key === '+';
      if (!out && !into) return;
      if (!ready() || inputBusy() || vetoed(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setLevel(state.level + (out ? -STEP : STEP), 'key');
    }, true);

    // mope resets its OWN zoom on a middle click and its handler still runs.
    // Ours goes back to 100% alongside it, so one gesture resets the view.
    PAGE.addEventListener('auxclick', (event) => {
      if (!event.isTrusted || event.button !== 1) return;
      if (!ready() || state.level === 1) return;
      if (!onGameSurface(event.target) || vetoed(event)) return;
      setLevel(1, 'reset');
    }, true);

    /* ----- what the panels ask ----- */

    function status() {
      return {
        rev: ZOOM_HUB_REV,
        hooked: !!state.target,
        hookedVia: state.hookedVia || '(not hooked)',
        bridge: bridge.status().phase,
        mopeOwnZoom: state.holder ? state.holder.native : '(camera not hooked)',
        level: state.level,
        factor: factor(),
        reHooks: state.reHooks,
        rehookRequests: state.rehookRequests,
        tookOverForeignHook: state.tookOverForeignHook,
        members: [...members.keys()].join(', ') || '(none)',
        owner: (() => { const top = owner(); return top ? top.id : '(none)'; })(),
        priorities: [...members.values()]
          .map((m) => m.id + ' @' + m.zoomPriority + (m.active ? ' on' : ' off'))
          .join(', ') || '(none)',
        active: anyActive(),
      };
    }

    function note() {
      if (state.target) return 'Scroll, or − and =, while in game';
      return 'Waiting for the game — it is picked up as soon as mope has loaded';
    }

    return {
      rev: ZOOM_HUB_REV,
      MIN, MAX, STEP,
      normalize,
      getLevel() { return state.level; },
      setLevel,
      hooked() { return !!state.target; },
      hookedVia() { return state.hookedVia; },
      preemptedBy,
      ownerId() { const top = owner(); return top ? top.id : ''; },
      rehook,
      status,
      note,
      // Called on this hub when a newer revision takes over, so this
      // accessor stops competing with the new one's.
      retire() {
        state.retired = true;
        try {
          if (state.target && state.holder) {
            Object.defineProperty(state.target, 'zoom', {
              value: state.holder.native,
              writable: true, enumerable: true, configurable: true,
            });
          }
        } catch (e) { /* the new hub takes the property over regardless */ }
        state.target = null;
        state.getter = null;
        members.clear();
      },
      join(id, options) {
        const member = {
          id,
          active: false,
          onChange: options && options.onChange,
          showToast: options && options.showToast,
          ignoreEvent: options && options.ignoreEvent,
          toastPriority: (options && options.toastPriority) || 0,
          zoomPriority: (options && options.zoomPriority) || 0,
          panelSource: (options && options.panelSource) || '',
        };
        members.set(id, member);
        // A change of OWNER changes what every other panel may do, so it is
        // announced like a level change. It can re-enter but cannot loop.
        const announceOwner = (before) => {
          if (owner() !== before) notify('owner', false);
        };
        return {
          setActive(on) {
            const before = owner();
            member.active = !!on;
            announceOwner(before);
          },
          leave() {
            const before = owner();
            members.delete(id);
            announceOwner(before);
          },
        };
      },
    };
  }

  // Whichever Lumi script runs first builds it; the rest join. A newer
  // revision replaces an older hub outright.
  const zoomHub = (function () {
    let existing = null;
    try { existing = PAGE[ZOOM_HUB_KEY]; } catch (e) { /* sealed page */ }
    if (existing && typeof existing.rev === 'number' && existing.rev >= ZOOM_HUB_REV) {
      return existing;
    }
    if (existing) {
      if (typeof existing.retire === 'function') {
        try { existing.retire(); } catch (e) { /* an old hub that will not let go */ }
        try {
          console.warn(TAG, 'Another Lumi script on this page brought zoom hub ' +
            'revision ' + existing.rev + ' and this one is ' + ZOOM_HUB_REV + '. Its zoom ' +
            'controls will do nothing until it is updated (Moderator Extras: join ' +
            'the hub rather than building one). Extras\' zoom works either way.');
        } catch (e) { /* console is not essential */ }
      } else {
        try {
          console.warn(TAG, 'Another Lumi script on this page is a very old version ' +
            'with a zoom of its own. Update it — until then the two will take the ' +
            'camera off each other.');
        } catch (e) { /* console is not essential */ }
      }
    }
    const built = buildZoomHub(existing);
    try { PAGE[ZOOM_HUB_KEY] = built; } catch (e) { /* nothing left to try */ }
    return built;
  })();

  /* ================= keybinds (1.0.7) =================
   *
   * Every key this script owns, in one registry, rebindable, with the clashes
   * it can see reported rather than discovered mid-fight.
   *
   * WHY A REGISTRY AND NOT FIVE HANDLERS. There were five, each with its own
   * literal, its own typing guard and its own idea of when to stand down. That
   * is fine until two of them want the same key, at which point nothing in the
   * script knows both exist and the loser fails silently. A registry is the
   * only place a question like "is anything already on this key" has an
   * answer.
   *
   * THREE KINDS OF CLASH, and they are genuinely different problems:
   *
   *   OURS   two Lumi's Extras binds on one key. Always wrong, always red: no
   *          priority setting can make one key mean two things.
   *
   *   BOUND  mope has one of its OWN rebindable actions on that key, which
   *          mopeBindFor() can see and name. Resolvable — that is what the
   *          priority control is for — so it is a warning, not an error.
   *
   *   FIXED  mope hardcodes the key in a context and it is NOT in its bind
   *          list, so mopeBindFor() reports the key as free when it is not.
   *          Digit1-Digit9 while the upgrade menu is open is the whole of this
   *          list today, and it is exactly the case that made this necessary:
   *          quick chat wanting the number row is why quick chat ships off.
   *
   * OVERRIDE AND UNDERRIDE, per bind, because the right answer differs per
   * person and per key:
   *
   *   override   ours wins. The event is consumed, so mope never sees it.
   *   underride  mope wins IN THE CONTEXT WHERE IT CLAIMS THE KEY, and ours
   *              works everywhere else. This is not "our bind off" — quick
   *              chat on underride still sends on 1-5 in open play and stands
   *              down only while the upgrade menu is up.
   *
   * Underride is the default for everything, which preserves exactly the
   * behaviour every one of these keys had before this existed.
   */
  const KB_KEYS = {codes: 'keybindCodes', prio: 'keybindPriority'};

  const KEYBINDS = [
    {id: 'panel',      def: 'KeyN',         label: 'Open the panel'},
    {id: 'partyChat',  def: 'KeyP',         label: 'Party chat channel'},
    {id: 'arenaTheme', def: 'KeyZ',         label: 'Arena theme on/off'},
    {id: 'zAbove',     def: 'BracketRight', label: 'Draw above players'},
    {id: 'zBelow',     def: 'BracketLeft',  label: 'Draw below players'},
    {id: 'chat1',      def: 'Digit1',       label: 'Quick chat 1'},
    {id: 'chat2',      def: 'Digit2',       label: 'Quick chat 2'},
    {id: 'chat3',      def: 'Digit3',       label: 'Quick chat 3'},
    {id: 'chat4',      def: 'Digit4',       label: 'Quick chat 4'},
    {id: 'chat5',      def: 'Digit5',       label: 'Quick chat 5'},
  ];

  // Keys mope claims in code rather than through its bind list, with the
  // context it claims them in. `has` is asked at event time, because a fixed
  // clash is only a clash while that context is actually up.
  const MOPE_FIXED = [
    {
      codes: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
              'Digit6', 'Digit7', 'Digit8', 'Digit9'],
      what: 'the upgrade menu',
      has: function () { return !!document.getElementById('upgradeMenu'); },
    },
  ];

  // Keys owned by handlers that are NOT in the registry, so a bind moved onto
  // one still shows a clash. The zoom hub is shared code with Lumi's Moderator
  // Extras and both scripts must keep the same handler, so it cannot simply be
  // folded in here; party chat's Enter is contextual on the channel being
  // selected. Neither is rebindable, and saying so is better than a panel that
  // reports a taken key as free.
  const SCRIPT_RESERVED = {
    Minus: 'Camera zoom out', Equal: 'Camera zoom in',
    Enter: 'Send a party chat message',
  };

  // Read through a hoisted function with a try, because the two handlers that
  // ask register at document-start — before the const below is evaluated — and
  // touching it in that window would be a temporal-dead-zone throw rather than
  // an undefined.
  function kbCapturing() { try { return !!kb.capturing; } catch (e) { return false; } }

  function kbFixedFor(code) {
    for (const f of MOPE_FIXED) if (f.codes.indexOf(code) >= 0) return f;
    return null;
  }

  // capturing is set while the panel is waiting for a key to bind. kbHit()
  // refuses everything while it is true, so the key being captured cannot also
  // fire the action it is being bound to.
  const kb = {codes: {}, prio: {}, capturing: false};
  (function () {
    const savedCodes = store.get(KB_KEYS.codes, null);
    const savedPrio = store.get(KB_KEYS.prio, null);
    for (const b of KEYBINDS) {
      // Validated on the way IN. Storage can hold anything — an older build's
      // shape, a hand-edited value — and a bind is about to be compared
      // against event.code, so anything that is not a plausible code drops
      // back to the default rather than quietly never matching.
      //
      // The empty string is the one exception, and it is load-bearing: it
      // means the user unbound this, and it has to survive a reload or the
      // unbind quietly undoes itself. It is safe as a sentinel precisely
      // because no earlier build could have written one — kbSetCode refused an
      // empty code and this loader only ever wrote a real code or the default
      // — so a '' here can only have come from kbClearCode.
      const raw = savedCodes ? savedCodes[b.id] : undefined;
      const want = typeof raw === 'string' ? raw : null;
      kb.codes[b.id] = want === '' ? ''
        : (want !== null && /^[A-Za-z0-9]{1,24}$/.test(want)) ? want
        : b.def;
      const p = savedPrio && savedPrio[b.id];
      kb.prio[b.id] = p === 'override' ? 'override' : 'underride';
    }
  })();

  function kbCode(id) { return kb.codes[id] || ''; }
  function kbPrio(id) { return kb.prio[id] === 'override' ? 'override' : 'underride'; }
  function kbDefOf(id) { for (const b of KEYBINDS) if (b.id === id) return b; return null; }

  function kbSave() {
    store.set(KB_KEYS.codes, kb.codes);
    store.set(KB_KEYS.prio, kb.prio);
  }

  function kbSetCode(id, code) {
    if (!kbDefOf(id) || !/^[A-Za-z0-9]{1,24}$/.test(code)) return false;
    kb.codes[id] = code;
    kbSave();
    dbg('keybind', id, 'to', code);
    return true;
  }

  // Unbind. Deliberately its own function rather than kbSetCode('') folded in,
  // because "put this bind on a key" and "take this bind off every key" are
  // different intentions, and a setter that silently does the second when
  // handed a falsy argument is one typo away from wiping a bind nobody touched.
  //
  // An unbound bind is '' everywhere, and nothing downstream had to learn a new
  // state: kbHit() already refused on a falsy code, kbConflicts() already
  // returned nothing for one, and kbLabelOf() already had a word for it. The
  // only thing that had to change was the loader keeping it.
  function kbClearCode(id) {
    if (!kbDefOf(id)) return false;
    kb.codes[id] = '';
    kbSave();
    dbg('keybind', id, 'cleared');
    return true;
  }

  function kbSetPrio(id, prio) {
    if (!kbDefOf(id)) return false;
    kb.prio[id] = prio === 'override' ? 'override' : 'underride';
    kbSave();
    return true;
  }

  function kbResetAll() {
    for (const b of KEYBINDS) { kb.codes[b.id] = b.def; kb.prio[b.id] = 'underride'; }
    kbSave();
  }

  // Everything wrong with one bind, worst first. Returned as data rather than
  // as a string so the panel can colour it and the debug hook can print it.
  function kbConflicts(id) {
    const code = kbCode(id);
    const out = [];
    if (!code) return out;
    for (const b of KEYBINDS) {
      if (b.id === id) continue;
      if (kbCode(b.id) === code) out.push({kind: 'ours', what: b.label});
    }
    const fixed = kbFixedFor(code);
    if (fixed) out.push({kind: 'fixed', what: fixed.what});
    if (SCRIPT_RESERVED[code]) out.push({kind: 'ours', what: SCRIPT_RESERVED[code] + ' (not rebindable)'});
    const bound = mopeBindFor(code);
    if (bound) out.push({kind: 'bound', what: bound});
    return out;
  }

  function kbWorstKind(list) {
    if (!list || !list.length) return '';
    for (const c of list) if (c.kind === 'ours') return 'ours';
    for (const c of list) if (c.kind === 'fixed') return 'fixed';
    return 'bound';
  }

  // The one guard every hotkey in this script already had, in one place.
  function kbTyping() {
    if (document.getElementById('chatInput')) return true;
    const active = document.activeElement;
    if (!active) return false;
    return active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' ||
      active.tagName === 'SELECT' || active.isContentEditable === true;
  }

  // Does this event match this bind, AND are we allowed to act on it?
  //
  // Deliberately one function rather than a match test and a permission test,
  // because every caller wants both and splitting them is how a handler ends
  // up checking one and not the other.
  function kbHit(id, event) {
    if (kb.capturing) return false;
    if (!event || !event.isTrusted) return false;
    // isTrusted lives here rather than at each call site: every caller already
    // checked it except the panel hotkey, which is exactly the one that could
    // be reached by a synthetic key from the other script sharing this page.
    if (!settings.masterEnabled) return false;
    if (!event || event.repeat) return false;
    // Modifiers are never part of a bind here: a key with ctrl or alt held is
    // a browser or OS gesture far more often than it is a game action.
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return false;
    const code = kbCode(id);
    if (!code || event.code !== code) return false;
    if (kbTyping()) return false;
    if (kbPrio(id) === 'override') return true;
    // Underride stands down only where something else actually claims the key
    // RIGHT NOW. A bound clash is contextless — mope acts on it whenever the
    // game has focus — so underride yields outright. A fixed clash is
    // contextual, so it yields only while that context is up.
    const fixed = kbFixedFor(code);
    if (fixed && fixed.has()) return false;
    if (mopeBindFor(code)) return false;
    return true;
  }

  // How a code should be written on a key cap. event.code is a physical
  // position and reads badly — "BracketRight" is not what is printed on the
  // key — so the common families are unwrapped and anything unrecognised is
  // shown as it came, which is still better than showing nothing.
  const KB_NAMES = {
    BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: 'Apostrophe',
    Comma: ',', Period: '.', Slash: '/', Backslash: 'Backslash', Backquote: 'Backtick',
    Minus: '-', Equal: '=', Space: 'Space', Enter: 'Enter', Escape: 'Esc',
    Tab: 'Tab', Backspace: 'Backspace', ArrowUp: 'Up', ArrowDown: 'Down',
    ArrowLeft: 'Left', ArrowRight: 'Right',
  };
  function kbLabelOf(code) {
    if (!code) return 'Not bound';
    if (KB_NAMES[code]) return KB_NAMES[code];
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^Numpad/.test(code)) return 'Num ' + code.slice(6);
    if (/^F[0-9]{1,2}$/.test(code)) return code;
    return code;
  }


  /* ----- panel themes (1.0.7) -----
   *
   * The panel already had its colours in custom properties on #qolc-panel, so
   * a theme is a second block of the same properties under an attribute
   * selector and nothing else has to know. That is the whole reason this is
   * cheap: no component was ever written against a literal, so none of them
   * need touching.
   *
   * The shell gradient is the one thing that was NOT a property — it sat
   * inline on the panel rule — so 1.0.7 lifts it into --qolc-shell. Without
   * that, a theme could recolour every control and leave the panel itself
   * teal, which reads as a bug rather than as a theme.
   *
   * Default is the original, exactly, and is what an unrecognised id falls
   * back to.
   */
  const PANEL_THEMES = [
    {id: 'teal',   label: 'Teal',   note: 'The original.'},
    {id: 'ember',  label: 'Ember',  note: 'Warm orange over a dark ground.'},
    {id: 'violet', label: 'Violet', note: 'Deep purple with a lilac accent.'},
    {id: 'slate',  label: 'Slate',  note: 'Neutral grey-blue. The quiet one.'},
  ];

  function panelThemeOf() {
    const want = String(settings.panelTheme || '');
    for (const t of PANEL_THEMES) if (t.id === want) return t;
    return PANEL_THEMES[0];
  }

  function panelThemeApply() {
    const el = extras && extras.panel;
    if (!el) return;
    // Written as an attribute rather than a class so it cannot collide with
    // the state classes the panel already carries, and so the stylesheet reads
    // as one selector per theme.
    try { el.setAttribute('data-qolc-theme', panelThemeOf().id); } catch (e) {}
  }

  function panelThemeSet(id) {
    for (const t of PANEL_THEMES) {
      if (t.id !== id) continue;
      settings.panelTheme = id;
      store.set('panelTheme', id);
      panelThemeApply();
      dbg('panel theme', id);
      return true;
    }
    return false;
  }
  function kbDebug() {
    const rows = KEYBINDS.map(function (b) {
      const list = kbConflicts(b.id);
      return {
        bind: b.label,
        key: kbCode(b.id)
          ? kbLabelOf(kbCode(b.id)) + ' (' + kbCode(b.id) + ')'
          : 'not bound',
        priority: kbPrio(b.id),
        conflicts: list.length
          ? list.map(function (c) { return c.kind + ': ' + c.what; }).join(', ')
          : 'none',
      };
    });
    console.log(TAG, 'keybinds');
    if (console.table) console.table(rows); else console.log(rows);
    // Said separately because a null here is not "no clashes" — it is "we
    // cannot see mope's bind list at all", and every BOUND check above is
    // therefore silently answering no.
    console.log(TAG, 'mope bind list readable:',
      mopeSettingsProxy() ? 'yes' : 'NO - bound-key clashes cannot be detected');
    return rows;
  }
  expose('__lumiKeybindDebug', kbDebug);
  // ------------------------------------------------ cosmetic name-color engine

  // ---------------- settings (persisted) ----------------
  const LS = {
    color:   'mnc:color',
    name:    'mnc:name',
    enabled: 'mnc:enabled',
    dom:     'mnc:dom',
    mode:    'mnc:mode',
    grad:    'mnc:grad',
    share:   'mnc:share',
    anim:    'mnc:anim',
    unlock:  'mnc:unlock',
    ego:     'mnc:ego',
    relay:   'mnc:relay',
  };

  // Two hidden series, each behind its own code. Gating applies to the PICKER
  // ONLY — decoding stays open, so a shared hidden gradient still renders for
  // everyone. Ranges must stay put: the share encoding transmits the index.
  // Empty since 1.0.0: the Fate and Ego series were DELETED outright along
  // with the rest of the archived gradients, which makes their unlock codes
  // inert. Left in place so a future series can use the machinery again.
  const GRAD_SERIES = [];
  const nameColorState = {
    color:   localStorage.getItem(LS.color)   || '#ff3b30',
    name:    localStorage.getItem(LS.name)    || '',
    enabled: localStorage.getItem(LS.enabled) !== '0',
    dom:     localStorage.getItem(LS.dom)     !== '0', // also color name in leaderboard/menus (HTML)
    mode:    localStorage.getItem(LS.mode) === 'grad' ? 'grad' : 'solid',
    grad:    Math.max(0, parseInt(localStorage.getItem(LS.grad) || '0', 10) || 0),
    share:   localStorage.getItem(LS.share)   === '1', // broadcast color to other script users
    anim:    localStorage.getItem(LS.anim)    !== '0', // animate gradients (flowing effect)
    unlocked: localStorage.getItem(LS.unlock) === '1', // Fate series revealed
    egoUnlocked: localStorage.getItem(LS.ego) === '1', // Ego series revealed
    // Off until asked for: it is the one part of the cosmetics tab that opens
    // a network connection, so it is not something to switch itself on during
    // an update. See the online name-color registry, further down.
    relay:   localStorage.getItem(LS.relay)   === '1',
    // The exact share suffix this client last wrote into the nickname box,
    // or an empty string if it wrote none. Not persisted: it describes the
    // name the SERVER is currently showing for you, which only injectSuffix()
    // can know, and a stale one read back from storage would be worse than
    // none. It is what tells your own nameplate apart from a friend playing
    // under your name.
    emitted: '',
  };

  // The highest-indexed series that covers i decides — ranges are ordered, so
  // scan backwards and take the first match.
  // The hidden series have no entry point in the panel at all. Each code is
  // installed as a bare global whose GETTER does the unlocking, so typing the
  // word into the browser console and pressing enter is the whole ritual:
  //
  //   > Fate
  //   'Fate series unlocked — 15 gradients added to the picker.'
  //
  // A getter rather than a function keeps it to the word itself, with no
  // parentheses, and the returned string is what the console prints back.
  // Unlocks persist, so this is only ever done once per browser.
  function installGradientCodes() {
    for (const series of GRAD_SERIES) {
      try {
        if (Object.prototype.hasOwnProperty.call(PAGE, series.code)) continue;
        Object.defineProperty(PAGE, series.code, {
          configurable: true,
          get() {
            const already = nameColorState[series.key];
            nameColorState[series.key] = true;
            saveNameColor();
            syncNameColorUI();
            const count = gradientSeriesSize(series);
            return already
              ? series.code + ' series was already unlocked (' + count + ' gradients).'
              : series.code + ' series unlocked — ' + count +
                ' gradients added to the picker.';
          },
        });
      } catch (e) { dbg('could not install the', series.code, 'code', e); }
    }
  }

  function gradientSeriesSize(series) {
    const i = GRAD_SERIES.indexOf(series);
    const end = i + 1 < GRAD_SERIES.length
      ? GRAD_SERIES[i + 1].from : NAME_GRADIENTS.length;
    return end - series.from;
  }

  function gradientLocked(i) {
    for (let s = GRAD_SERIES.length - 1; s >= 0; s--) {
      if (i >= GRAD_SERIES[s].from) return !nameColorState[GRAD_SERIES[s].key];
    }
    return false;
  }
  function saveNameColor() {
    localStorage.setItem(LS.color, nameColorState.color);
    localStorage.setItem(LS.name, nameColorState.name);
    localStorage.setItem(LS.enabled, nameColorState.enabled ? '1' : '0');
    localStorage.setItem(LS.dom, nameColorState.dom ? '1' : '0');
    localStorage.setItem(LS.mode, nameColorState.mode);
    localStorage.setItem(LS.grad, String(nameColorState.grad));
    localStorage.setItem(LS.share, nameColorState.share ? '1' : '0');
    localStorage.setItem(LS.anim, nameColorState.anim ? '1' : '0');
    localStorage.setItem(LS.unlock, nameColorState.unlocked ? '1' : '0');
    localStorage.setItem(LS.ego, nameColorState.egoUnlocked ? '1' : '0');
    localStorage.setItem(LS.relay, nameColorState.relay ? '1' : '0');
    // Every cosmetic write lands here, which makes it the one place the
    // registry has to be told that what it publishes may have changed.
    // Declared `var` down there rather than `let` precisely so this call is
    // safe: see the note on nrStarted.
    if (nrStarted) nrOnLocalChange();
  }

  const NAME_COLORS = [
    ['White',   '#ffffff'], ['Black',  '#000000'], ['Red',    '#ff3b30'], ['Orange', '#ff9500'],
    ['Yellow',  '#ffd60a'], ['Lime',   '#a3e635'], ['Green',  '#34c759'], ['Teal',   '#14b8a6'],
    ['Cyan',    '#32ade6'], ['Blue',   '#007aff'], ['Navy',   '#4169e1'], ['Purple', '#7c3aed'],
    ['Magenta', '#d946ef'], ['Pink',   '#ff69b4'], ['Brown',  '#b5651d'], ['Gray',   '#9ca3af'],
  ];

  // 79 presets. IMPORTANT: existing presets keep their original order — the share
  // encoding transmits the index, so reordering would change colors for
  // other script users on older versions.
  const NAME_GRADIENTS = [
    ['Flame',     ['#f83600', '#fee140']],
    ['Rose',      ['#ff5f6d', '#ffc371']],
    ['Candy',     ['#ff6a9d', '#c56bff']],
    ['Ocean',     ['#2193b0', '#6dd5ed']],
    ['Mint',      ['#11998e', '#38ef7d']],
    ['Frost',     ['#83a4d4', '#b6fbff']],
    ['Galaxy',    ['#7f00ff', '#e100ff']],
    ['Gold',      ['#bf953f', '#fcf6ba']],
    ['Silver',    ['#8e9eab', '#eef2f3']],
    ['Ember',     ['#ed213a', '#93291e']],
    ['Cherry',    ['#eb3349', '#f45c43']],
    ['Coral',     ['#ff9966', '#ff5e62']],
    ['Mango',     ['#ffe259', '#ffa751']],
    ['Rust',      ['#b21f1f', '#fdbb2d']],
    ['Blush',     ['#ffafbd', '#ffc3a0']],
    ['Fuchsia',   ['#ff0080', '#ff8c00']],
    ['Sakura',    ['#fbd3e9', '#bb377d']],
    ['Berry',     ['#8e2de2', '#4a00e0']],
    ['Grape',     ['#6a3093', '#a044ff']],
    ['Wine',      ['#b24592', '#f15f79']],
    ['Orchid',    ['#da22ff', '#9733ee']],
    ['Amethyst',  ['#9d50bb', '#6e48aa']],
    ['Indigo',    ['#4776e6', '#8e54e9']],
    ['Nebula',    ['#3a1c71', '#d76d77', '#ffaf7b']],
    ['Twilight',  ['#4b6cb7', '#182848']],
    ['Navy',      ['#000046', '#1cb5e0']],
    ['Sapphire',  ['#2b32b2', '#1488cc']],
    ['Sky',       ['#56ccf2', '#2f80ed']],
    ['Azure',     ['#007adf', '#00ecbc']],
    ['Ice',       ['#74ebd5', '#acb6e5']],
    ['Lagoon',    ['#43c6ac', '#191654']],
    ['Aurora',    ['#00c9ff', '#92fe9d']],
    ['Jade',      ['#00b09b', '#96c93d']],
    ['Lime',      ['#a8e063', '#56ab2f']],
    ['Tropic',    ['#00f260', '#0575e6']],
    ['Rainbow',   ['#ff5e62', '#ffd452', '#38ef7d']],
    ['Unicorn',   ['#fbc2eb', '#a6c1ee']],
    // edgy set (indexes 50-63)
    ['Venom',     ['#0f0f0f', '#39ff14']],
    ['Reaper',    ['#200122', '#6f0000']],
    ['Hellfire',  ['#ff4e00', '#1f0000']],
    ['Toxic',     ['#a8ff00', '#1a3300']],
    ['Midnight',  ['#0f2027', '#2c5364']],
    ['Void',      ['#000000', '#434343']],
    ['Phantom',   ['#4b0082', '#0d0d0d']],
    ['Vampire',   ['#8a0303', '#000000']],
    ['Cyber',     ['#00f0ff', '#ff00e0']],
    ['Neon',      ['#39ff14', '#00e5ff']],
    ['Glitch',    ['#ff0055', '#00ffee']],
    ['Matrix',    ['#003b00', '#00ff41']],
    ['Onyx',      ['#232526', '#414345']],
    ['Demon',     ['#ff416c', '#590d22']],
    // 1.30.0, added at the END of the array as it then stood.
    // Names are ours; the colour pairs were given.
    ['Pearl',     ['#f0f2f0', '#000c40']],   // near-white into deep navy
    ['Dusk',      ['#e8cbc0', '#636fa4']],   // warm sand into slate blue
    ['Kindling',  ['#f3904f', '#3b4371']],   // ember orange into night
    ['Arcade',    ['#ff00cc', '#333399']],   // hot magenta into indigo
    ['Harbour',   ['#ffd89b', '#19547b']],   // lamplight into deep water
    ['Olive',     ['#ccccb2', '#757519']],   // pale linen into moss
    ['Ash',       ['#948e99', '#2e1437']],   // grey into aubergine
    ['Shoreline', ['#70e1f5', '#ffd194']],   // shallow sea into sand
  ];


  // Runs here rather than beside gradientLocked so the array it validates
  // against already exists. A gradient selected before a gate existed, on
  // another profile, or under a newer build must not stay selected while
  // locked or out of range — it would show a colour the picker denies.
  if (nameColorState.grad >= NAME_GRADIENTS.length ||
      gradientLocked(nameColorState.grad)) {
    nameColorState.grad = 0;
  }

  const NAME_WHITE = 0xffffff;
  const hexToInt = (h) => parseInt(h.slice(1), 16);
  function colorInt() { return hexToInt(nameColorState.color); }
  function gradStopsOf(i) { return NAME_GRADIENTS[i][1].map(hexToInt); }
  function cssGrad(g)  { return 'linear-gradient(90deg, ' + NAME_GRADIENTS[g][1].join(', ') + ')'; }
  // mirrored stops (A→B→A) so a scrolling background tiles seamlessly
  function cssGradCyc(g) {
    const s = NAME_GRADIENTS[g][1];
    return 'linear-gradient(90deg, ' + s.concat(s.slice(0, -1).reverse()).join(', ') + ')';
  }
  // color at position t (0..1) along a multi-stop gradient
  function gradColorAt(stops, t) {
    if (stops.length === 1) return stops[0];
    const seg = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
    const lt = t * (stops.length - 1) - seg;
    const a = stops[seg], b = stops[seg + 1];
    const l = (x, y) => Math.round(x + (y - x) * lt);
    return (l((a >> 16) & 255, (b >> 16) & 255) << 16) |
           (l((a >> 8) & 255, (b >> 8) & 255) << 8) |
           l(a & 255, b & 255);
  }

  // ---------------- invisible-suffix color sharing ----------------
  // Verified live: mope's server preserves these zero-width characters in
  // names, and the game's renderer draws them with zero width. The payload is
  // ONLY ever a color: 2-bit symbols from ALPHA after a MARKER —
  //   type 0: solid palette index (2 symbols)
  //   type 1: gradient preset index (3 symbols for 0-63, 4 for 64+;
  //           2 accepted from old versions)
  //   type 2: custom solid color, RGB 4 bits/channel (6 symbols)
  // Anything else is ignored by the decoder.
  const MARKER = '⁣'; // INVISIBLE SEPARATOR
  const ALPHA = ['​', '‌', '‍', '⁠'];
  const INVIS_SET = new Set([...ALPHA, MARKER, '‎', '‏', '⁡', '⁢', '⁤', '﻿']);
  function stripInvis(s) {
    let out = '';
    for (const ch of s) if (!INVIS_SET.has(ch)) out += ch;
    return out;
  }
  function nameKey() { return stripInvis(nameColorState.name).trim().toLowerCase(); }
  function baseKey(text) { return stripInvis(text).trim().toLowerCase(); }

  function encodeSuffix(compact) {
    if (!settings.masterEnabled || !nameColorState.enabled || !nameColorState.share) return '';
    const sym = (v, n) => { let s = ''; for (let i = n - 1; i >= 0; i--) s += ALPHA[(v >> (2 * i)) & 3]; return s; };
    if (nameColorState.mode === 'grad') {
      // Indexes 0-15 also fit in 2 symbols, a form every released decoder
      // already accepts (see the bits.length === 2 branch below). Only used
      // when the full form would overflow the game's name field.
      if (compact && nameColorState.grad < 16) {
        return MARKER + ALPHA[1] + sym(nameColorState.grad, 2);
      }
      const symbols = nameColorState.grad < 64 ? 3 : 4;
      return MARKER + ALPHA[1] + sym(nameColorState.grad, symbols);
    }
    const idx = NAME_COLORS.findIndex(([, h]) => h.toLowerCase() === nameColorState.color.toLowerCase());
    if (idx >= 0) return MARKER + ALPHA[0] + sym(idx, 2);
    const c = colorInt();
    const q4 = (v) => Math.min(15, Math.round(v / 17));
    const q = (q4((c >> 16) & 255) << 8) | (q4((c >> 8) & 255) << 4) | q4(c & 255);
    return MARKER + ALPHA[2] + sym(q, 6);
  }

  // returns {solid: int} | {grad: index} | null — strictly bounded, never throws
  function decodeSuffix(text) {
    const i = text.lastIndexOf(MARKER);
    if (i < 0) return null;
    const vals = [];
    for (const ch of text.slice(i + 1)) {
      const v = ALPHA.indexOf(ch);
      if (v < 0) return null;
      vals.push(v);
      if (vals.length > 7) return null;
    }
    if (vals.length < 3) return null;
    const type = vals[0];
    const bits = vals.slice(1);
    const num = bits.reduce((a, v) => (a << 2) | v, 0);
    if (type === 0 && bits.length === 2) return num < NAME_COLORS.length ? {solid: hexToInt(NAME_COLORS[num][1])} : null;
    // 3 symbols preserves compatibility for indexes 0-63; 4 supports new presets.
    // 2 is still accepted from older script versions (indexes 0-9).
    if (type === 1 && (bits.length === 4 || bits.length === 3 || bits.length === 2)) {
      return num < NAME_GRADIENTS.length ? {grad: num} : null;
    }
    if (type === 2 && bits.length === 6) {
      const r = ((num >> 8) & 15) * 17, g = ((num >> 4) & 15) * 17, b = (num & 15) * 17;
      return {solid: (r << 16) | (g << 8) | b};
    }
    return null;
  }

  // What styling does this text node get? Own name uses live settings; other
  // names are styled only if they carry a valid share-suffix or have an entry
  // in the online registry.
  function ownStyle() {
    // A fresh object each time on purpose: registry styles are shared between
    // callers, so nothing here may ever hand back an object it does not own.
    // Self is established by the owning game model or leaderboard main row.
    if (nameColorState.mode === 'grad') return {grad: nameColorState.grad, self: true};
    return {solid: colorInt(), self: true};
  }

  // Somebody else's colour, by whatever channel they published it on. The
  // registry is asked first: it is fresher than a suffix baked into the name at
  // spawn, it carries an exact colour rather than the suffix's 4-bits-per-
  // channel approximation, and it is the only one of the two that works at all
  // for a name with no room left for a tag. A miss costs one Map read and falls
  // straight through to the old path, so a player whose friends are still on an
  // older build loses nothing.
  function sharedStyleFor(text) {
    // A retained name-keyed entry is a colour preference, never identity.
    // Require an opt-in tag on this name before consulting that entry.
    const tag = decodeSuffix(text);
    if (!tag) return null;
    return nrLookup(baseKey(text)) || tag;
  }

  function styleFor(text, isSelf = false) {
    if (!settings.masterEnabled || !nameColorState.enabled || typeof text !== 'string' || !text) return null;
    return isSelf === true ? ownStyle() : sharedStyleFor(text);
  }

  // How much room the nickname box actually has. The field's own maxlength is
  // the authority; the HTML spec measures it in UTF-16 code units, which is
  // exactly what String#length counts. This matters for decorative "maths
  // alphabet" letters (�, �, �, …): each is a surrogate pair costing TWO
  // units, so a name that looks 8 characters long already spends 16 of the
  // budget. Overflowing it gets the name truncated mid-suffix or rejected
  // outright, and the server renders a rejected name as "mope.io".
  const NAME_LIMIT_FALLBACK = 24;
  function nameFieldLimit(el) {
    const n = el && el.maxLength;
    return (typeof n === 'number' && n > 0) ? n : NAME_LIMIT_FALLBACK;
  }

  // Rewrite the nickname box right before the game reads it on Play:
  // base name (any old invisible chars stripped) + current color suffix.
  function injectSuffix() {
    try {
      const el = document.getElementById('name');
      if (!el) return;
      const base = stripInvis(el.value);
      const limit = nameFieldLimit(el);
      // no suffix on an empty name — an invisible-only name would confuse the
      // game's default-name handling
      let suf = '';
      if (base.trim()) {
        // Prefer the full tag, but fall back to the compact gradient form
        // rather than dropping the color entirely on a nearly-full name.
        for (const candidate of [encodeSuffix(false), encodeSuffix(true)]) {
          if (candidate && base.length + candidate.length <= limit) { suf = candidate; break; }
        }
      }
      const wanted = base + suf;
      el.value = wanted;
      nameColorState.emitted = suf;
      // the game's menu tracks the field via input events (verified live:
      // silent value changes are NOT sent), so fire one for it to pick up
      el.dispatchEvent(new PAGE.Event('input', {bubbles: true}));
      // If the field (or the game's own input handler) mangled what we wrote,
      // a half-written tag is worse than none: it decodes to the wrong color,
      // or the whole name gets rejected and comes back as "mope.io". Bail out
      // to the bare name, which at least keeps your own client's coloring.
      if (suf && el.value !== wanted) {
        dbg('share suffix rejected by the name field — sending the bare name');
        nameColorState.emitted = '';
        el.value = base;
        el.dispatchEvent(new PAGE.Event('input', {bubbles: true}));
      }
    } catch (e) {}
  }
  document.addEventListener('submit', (e) => {
    if (e.target && e.target.id === 'playForm') injectSuffix();
  }, true);
  document.addEventListener('pointerdown', (e) => {
    const t = e.target;
    if (t && t.closest && t.closest('#playButton')) injectSuffix();
  }, true);
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.closest && t.closest('#playButton')) injectSuffix();
  }, true);


  function destroyOverlay(node, m) {
    for (const c of m.clones) {
      try { if (c.parent) c.parent.removeChild(c); if (c.destroy) c.destroy(); } catch (e) {}
    }
    overlays.delete(node);
    try { node.renderable = true; } catch (e) {}
  }

  const NAME_GRAPHEME_SEGMENTER = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, {granularity: 'grapheme'})
    : null;

  function splitNameGraphemes(text) {
    const clean = [...text].filter((ch) => !INVIS_SET.has(ch)).join('');
    return NAME_GRAPHEME_SEGMENTER
      ? [...NAME_GRAPHEME_SEGMENTER.segment(clean)].map((part) => part.segment)
      : [...clean];
  }

  // Emoji keep their own colours.
  //
  // A Pixi tint MULTIPLIES the glyph's texture, so a colour-font emoji comes
  // out as a muddy silhouette of itself rather than as an emoji — the tint
  // that was complained about. There is no per-glyph tint on a Text node, so
  // the only way to leave them out is to draw the name as one node per
  // grapheme and tint only the graphemes that are not emoji. That machinery
  // already existed for gradients; 1.14.0 gives solid names the same treatment,
  // but ONLY when the name actually contains an emoji — building clones for
  // every plain name on screen would be real work for no visible gain.
  //
  // Emoji PRESENTATION, not \p{Extended_Pictographic}: the latter also covers
  // (tm), (c), (r) and the dingbat arrows, which are ordinary text characters
  // and should take the name's colour like any other letter. What is wanted is
  // the set that renders out of a colour font — characters that are emoji by
  // default, anything switched to emoji presentation with U+FE0F, and flags,
  // which are pairs of regional indicators.
  //
  // Built with `new RegExp` rather than written as a literal on purpose: a
  // literal containing an unsupported property escape is a PARSE error, which
  // would take the whole script down on an old engine instead of just this.
  const NAME_EMOJI_RE = (() => {
    try {
      // The backslashes MUST be doubled. Written as '\p{...}' the string
      // literal collapses \p to a bare p, so the source became p{...} \u2014 an
      // unescaped { that is not a quantifier, which is a SyntaxError under the
      // u flag on EVERY engine. The try/catch then swallowed it and the crude
      // fallback below ran everywhere, which is the opposite of what this
      // indirection was written to achieve: the graceful path was never once
      // taken, on any browser, since it was added.
      return new RegExp('\\p{Emoji_Presentation}|\\p{Regional_Indicator}|\uFE0F', 'u');
    } catch (e) {
      // No Unicode property escapes: the surrogate ranges that hold almost
      // every emoji, plus the explicit presentation selector.
      return /[\uD83C-\uD83E][\uDC00-\uDFFF]|️|[←-⯿]️/;
    }
  })();

  function isEmojiGrapheme(grapheme) {
    try { return NAME_EMOJI_RE.test(grapheme); } catch (e) { return false; }
  }

  function textHasEmoji(text) {
    try { return typeof text === 'string' && NAME_EMOJI_RE.test(text); }
    catch (e) { return false; }
  }

  // What a node's overlay is FOR. Rebuilt whenever any part of it changes, so
  // switching mode, colour, gradient or name never leaves a stale set of
  // clones behind.
  function overlayKeyFor(node, st) {
    return (st.grad !== undefined ? 'g' + st.grad : 's' + st.solid) + '|' + node.text;
  }

  function overlayWanted(node, st) {
    return !!st && (st.grad !== undefined || textHasEmoji(node.text));
  }

  // Returns false if the clones could not be built, so the caller can fall
  // back to tinting the real node rather than leaving the name uncoloured.
  function ensureNameOverlay(node, st) {
    const key = overlayKeyFor(node, st);
    let m = overlays.get(node);
    if (m && m.key !== key) { destroyOverlay(node, m); m = null; }
    if (!m) {
      const clones = [];
      try {
        const Ctor = node.constructor;
        const stops = st.grad !== undefined ? gradStopsOf(st.grad) : null;
        const chars = splitNameGraphemes(node.text);
        const emoji = chars.map(isEmojiGrapheme);
        chars.forEach((ch, i) => {
          const c = new Ctor({
            text: ch,
            style: node.style && node.style.clone ? node.style.clone()
                 : {fontFamily: node.style.fontFamily, fontSize: node.style.fontSize},
          });
          c.__lumiNameOverlay = true;
          clones.push(c);
          if (c.anchor) c.anchor.set(0, node.anchor ? node.anchor.y : 0.5);
          c.tint = emoji[i] ? NAME_WHITE
            : stops ? gradColorAt(stops, chars.length > 1 ? i / (chars.length - 1) : 0.5)
            : st.solid;
          node.parent.addChild(c);
        });
        m = {key, clones, chars, emoji, stops, laidOut: false};
        overlays.set(node, m);
      } catch (e) {
        for (const c of clones) {
          try { if (c.parent) c.parent.removeChild(c); c.destroy(); } catch (ignored) {}
        }
        return false; // graceful: the caller tints the real node
      }
    }
    syncOverlayLayout(node, m);
    node.renderable = false;
    return true;
  }

  // The one place a name's styling is put on a node, so the overlay and the
  // plain tint can never both be live on the same node.
  function applyNameStyle(node, st) {
    if (!st) {
      const m = overlays.get(node);
      if (m) destroyOverlay(node, m);
      // Bookkeeping first: if restoring the node throws (it was destroyed under
      // us), it must not stay listed and fail again on every frame.
      const original = nameOriginals.get(node);
      nameOriginals.delete(node);
      tinted.delete(node);
      if (original && !node.destroyed) {
        try { node.tint = original.tint; node.renderable = original.renderable; } catch (e) { /* gone */ }
      }
      return;
    }
    if (!nameOriginals.has(node)) nameOriginals.set(node, {tint: node.tint, renderable: node.renderable});
    if (overlayWanted(node, st) && ensureNameOverlay(node, st)) {
      if (node.tint !== NAME_WHITE) node.tint = NAME_WHITE; // clean slate under it
      tinted.delete(node);
      return;
    }
    const m = overlays.get(node);
    if (m) destroyOverlay(node, m);
    // A gradient whose clones could not be built still gets a colour rather
    // than silently rendering white: the middle of its own ramp.
    const solid = st.solid !== undefined
      ? st.solid : gradColorAt(gradStopsOf(st.grad), 0.5);
    if (node.tint !== solid) node.tint = solid;
    tinted.add(node);
  }

  // A gradient name is drawn as one clone per letter, sitting beside the real
  // name node rather than inside it — so the game hiding the name does not
  // hide ours unless we mirror it. The game writes both of these on the node
  // every frame:
  //
  //   name.visible = isNameVisible   // = !shouldHideHUD && !arena
  //                                  //   shouldHideHUD covers being in a hole,
  //                                  //   unspawned, zero-size or zero-opacity
  //   name.alpha   = opacity * skinOpacity   // fades out while diving
  //
  // Without this the coloured name stayed on screen through holes, dives and
  // the whole of a 1v1 arena — exactly where the game had hidden everyone's.
  // (Solid mode only tints the real node, so it never had this problem.)
  function syncOverlayVisibility(node, m) {
    const visible = node.visible !== false;
    const alpha = Number.isFinite(node.alpha) ? node.alpha : 1;
    for (const c of m.clones) {
      if (c.visible !== visible) c.visible = visible;
      if (c.alpha !== alpha) c.alpha = alpha;
    }
  }

  // Flowing-gradient animation: each letter's tint is re-sampled every frame
  // from the gradient treated as cyclic (position bounces A→B→A), phase-
  // shifted by time. At phase 0 this equals the static A→B layout. Also
  // smooths out the per-letter color steps on short names.
  const ANIM_PERIOD = 3000; // ms per full cycle
  function animateOverlayTints(m, now) {
    const n = m.clones.length;
    if (!n || !m.stops) return;
    const phase = nameColorState.anim ? (now % ANIM_PERIOD) / ANIM_PERIOD : 0;
    for (let i = 0; i < n; i++) {
      // An emoji clone was never given the name's colour and must not be given
      // one now: the flow animation re-tints every frame, so skipping it here
      // is what keeps it out of the gradient for good rather than for one frame.
      if (m.emoji && m.emoji[i]) continue;
      let u = (n > 1 ? i / (n - 1) : 0.5) * 0.5 + phase;
      u -= Math.floor(u);
      const tri = u < 0.5 ? u * 2 : 2 - u * 2;
      const c = gradColorAt(m.stops, tri);
      if (m.clones[i].tint !== c) m.clones[i].tint = c;
    }
  }

  // The game positions/scales the name node AFTER creating it (on spawn and
  // again on animal upgrade, sometimes animated over several frames), so a
  // one-time layout goes stale — track the original every frame and re-lay
  // out whenever its local position or scale changes.
  function syncOverlayLayout(node, m) {
    const sx = node.scale ? node.scale.x : 1;
    const sy = node.scale ? node.scale.y : 1;
    if (m.laidOut && (m.px !== node.position.x || m.py !== node.position.y ||
                      m.sx !== sx || m.sy !== sy)) {
      m.laidOut = false;
    }
    if (!m.laidOut) {
      m.clones.forEach((c) => { if (c.scale) c.scale.set(sx, sy); });
      const measured = m.clones.map((c) =>
        Number.isFinite(c.width) && c.width > 0 ? c.width : 0);
      const visibleWidths = measured.filter((width, i) =>
        width > 0 && !/^\s+$/u.test(m.chars[i]));
      const averageGlyph = visibleWidths.length
        ? visibleWidths.reduce((a, b) => a + b, 0) / visibleWidths.length
        : Math.max(1, Number(node.width) / Math.max(1, m.chars.length));
      // BitmapText commonly reports zero width for a clone containing only a
      // space. Give whitespace an explicit advance, and give unsupported
      // zero-width graphemes a conservative glyph advance.
      const advances = measured.map((width, i) => {
        if (/^\s+$/u.test(m.chars[i])) return Math.max(1, averageGlyph * 0.48);
        return width > 0 ? width : averageGlyph;
      });
      const measuredTotal = advances.reduce((a, b) => a + b, 0);
      const targetWidth = Number.isFinite(node.width) && node.width > 0
        ? node.width : measuredTotal;
      if (measuredTotal > 0 && targetWidth > 0) {
        // Normalize advances to the intact Pixi object's width. This retains
        // word spacing and most shaping/kerning even though colors still use
        // one clone per grapheme.
        const correction = targetWidth / measuredTotal;
        let x = node.position.x - targetWidth * (node.anchor ? node.anchor.x : 0.5);
        m.clones.forEach((c, i) => {
          c.position.set(x, node.position.y);
          x += advances[i] * correction;
        });
        m.px = node.position.x; m.py = node.position.y; m.sx = sx; m.sy = sy;
        m.laidOut = true;
      }
    }
  }


  /* ----- painting the names in the world -----
   *
   * Which nodes are names, and whose: mope's entity registry answers both.
   * Every animal entity owns its nameplate (`entity.name`, a Pixi Text), and
   * `$.player` is yours. Nothing here walks the scene graph or matches a
   * shape — a node is styled because the game says it is an animal's name,
   * and it is styled as YOURS only because the game says that animal is you.
   *
   * The two rules learned the hard way still hold:
   *   - a name's visible letters never identify a player; a remote name is
   *     coloured only if it carries a valid share tag (see sharedStyleFor);
   *   - emoji are never tinted (see ensureNameOverlay).
   */

  const nameOriginals = new WeakMap();   // node -> {tint, renderable} before we touched it
  const nameBindings = new WeakMap();    // node -> {owner, parent, text, self}
  const tinted = new Set();              // nodes we solid-tinted (to restore)
  const overlays = new Map();            // node -> {key, clones, ...} per-grapheme overlays
  // Names worn by more than one nameplate on screen right now. The registry
  // is keyed by the name alone, so it refuses to answer for these.
  let ambiguousNames = new Set();

  const NAME_SWEEP_MS = 250;      // discovery: new animals, changed names
  const NAME_OVERLAY_MS = 15;     // animation and layout of gradient clones
  const nameFrameState = {sweptAt: -Infinity, animatedAt: -Infinity, styled: 0};

  function nameSweep() {
    const me = myAnimal();
    const owners = new Map();
    const counts = new Map();
    for (const animal of liveAnimals()) {
      const node = animal.name;
      if (!node || node.destroyed || node.__lumiNameOverlay ||
          typeof node.text !== 'string' || !node.parent) continue;
      owners.set(node, animal);
      const key = baseKey(node.text);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    ambiguousNames = new Set([...counts].filter(([, n]) => n > 1).map(([key]) => key));
    let styled = 0;
    for (const [node, animal] of owners) {
      const self = animal === me;
      nameBindings.set(node, {owner: animal, parent: node.parent, text: node.text, self});
      const style = styleFor(node.text, self);
      applyNameStyle(node, style);
      if (style) styled++;
    }
    // Anything still styled that is no longer an animal's live nameplate goes
    // back to exactly how mope left it.
    for (const node of [...tinted, ...overlays.keys()]) {
      if (!owners.has(node)) applyNameStyle(node, null);
    }
    nameFrameState.styled = styled;
  }

  // Between sweeps a nameplate can be recycled (new text, new owner, the
  // animal died). Revoke on the very next frame rather than up to 250ms late.
  function nameReconcile() {
    const me = myAnimal();
    const validate = (node) => {
      const b = nameBindings.get(node);
      const owner = b && b.owner;
      if (!b || node.destroyed || node.parent !== b.parent || node.text !== b.text ||
          !owner || owner.spawned === false || owner.name !== node ||
          (b.self && owner !== me)) applyNameStyle(node, null);
    };
    for (const node of [...tinted]) validate(node);
    for (const node of [...overlays.keys()]) validate(node);
  }

  function nameClearAll() {
    for (const node of [...tinted]) applyNameStyle(node, null);
    for (const node of [...overlays.keys()]) applyNameStyle(node, null);
  }

  function nameFrame(now) {
    if (!settings.masterEnabled || !nameColorState.enabled) {
      if (tinted.size || overlays.size) nameClearAll();
      return;
    }
    nameReconcile();
    if (now - nameFrameState.sweptAt >= NAME_SWEEP_MS) {
      nameFrameState.sweptAt = now;
      nameSweep();
    }
    if (overlays.size && now - nameFrameState.animatedAt >= NAME_OVERLAY_MS) {
      nameFrameState.animatedAt = now;
      for (const [node, m] of overlays) {
        syncOverlayLayout(node, m);
        syncOverlayVisibility(node, m);
        animateOverlayTints(m, now);
      }
    }
  }
  // --------------------------------------------------------------- party map

  const PARTY_KEYS = {
    enabled: 'party:enabled', code: 'party:code', broker: 'party:broker',
    dots: 'party:dots', tags: 'party:tags', color: 'party:color',
    pin: 'party:pin', chat: 'party:chat', list: 'party:list',
    listSelf: 'party:listSelf', listBox: 'party:listBox',
    handle: 'party:handle',
  };

  // Public brokers that speak MQTT over TLS WebSockets. Best-effort and
  // world-readable by design — which is exactly why the payload is encrypted
  // rather than merely posted to an obscure topic.
  //
  // These three are UNRELATED servers with no bridging between them, so two
  // members holding the same code but sitting on different ones never see each
  // other — while both panels show a green light, because each connection is
  // genuinely fine. The relay is therefore selectable, and a chosen one is
  // PINNED: see rotateBroker(). Auto-rotation drifting on a dropped connection
  // is what silently split a working party, and it could not be caught by
  // testing on one machine, where both tabs read the same stored index.
  const PARTY_BROKERS = [
    ['HiveMQ',    'wss://broker.hivemq.com:8884/mqtt'],
    ['EMQX',      'wss://broker.emqx.io:8084/mqtt'],
    ['Mosquitto', 'wss://test.mosquitto.org:8081/mqtt'],
  ];

  const PARTY_STALE_MS = 5000;   // dot dims after this long with no update
  const PARTY_DROP_MS  = 15000;  // peer removed entirely
  // The original single tint was purple: clear of every colour mope uses for
  // pumpkins (orange, #deb887, gold, #6adb41, #e4384c, #38e4e1), so a team-mate
  // could never be mistaken for a collectible, and deliberately on the light
  // side — the marker sits inside a dark ring on a busy, mostly mid-green map,
  // and the darker shade it started as read as muddy against it. It is index 0
  // below and remains the default.
  //
  // Each preset carries its OWN outline rather than the flat black the single
  // colour used, because a black ring only separates a light dot from the map.
  // Four of these are bright enough for that; ultramarine is not — at roughly
  // 7% relative luminance a black ring is a 2.5:1 edge and the marker loses its
  // shape — so it takes a pale ring instead. Every fill/outline pairing here
  // clears 4:1, which is what keeps a dot legible at nine pixels across.
  //
  // Two of these sit near a pumpkin tint by request: cyan against the diamond's
  // #38e4e1, crimson against the ruby's #e4384c. The outline is what separates
  // them at a glance, since a pumpkin always rings brown and never rings teal
  // or plum.
  const PARTY_DOT_COLORS = [
    ['Lilac',       '#cba6ff', '#000000'],
    ['Magenta',     '#ed25ed', '#3a0a3a'],
    ['Rose',        '#ed2589', '#3a0620'],
    ['Cyan',        '#09f4ec', '#03403d'],
    ['Crimson',     '#f40963', '#3d0418'],
    ['Ultramarine', '#0800ff', '#cfd2ff'],
    // 1.16.0. The six above are pinks, purples and cyans; these five are the
    // colours that roster did not have. Ratios are fill against outline,
    // measured, and all clear the 4:1 the table has always held to.
    ['Chartreuse',  '#c6ff00', '#1e2b00'],  // 12.6:1 — the green that was asked
                                            // for, kept well clear of the
                                            // emerald pumpkin's #6adb41 by
                                            // being far lighter and yellower
    ['Scarlet',     '#ff2a00', '#1a0400'],  //  5.3:1 — a true orange-red, which
                                            // neither Crimson nor the ruby
                                            // pumpkin's #e4384c is; both of
                                            // those read pink beside it
    ['Sunflower',   '#ffe500', '#3a2f00'],  // 10.4:1 — nearest a pumpkin tint
                                            // of anything here (gold, #ffd700)
                                            // and kept for the same reason
                                            // Cyan was: a pumpkin rings brown
                                            // and this rings near-black
    ['Violet',      '#8b2fff', '#f2e8ff'],  //  4.5:1 — deep and saturated where
                                            // Lilac is pale; takes a pale ring
                                            // for the same reason Ultramarine
                                            // does
    ['Azure',       '#2e86ff', '#04203f'],  //  4.7:1 — the mid blue between
                                            // Cyan and Ultramarine, both of
                                            // which sit at an extreme
  ].map(([name, fill, line]) => ({
    name, fill, line,
    fillTint: parseInt(fill.slice(1), 16),
    lineTint: parseInt(line.slice(1), 16),
  }));

  // Peers publish an INDEX into that table, never a colour, so the outline is
  // paired locally at each end and nothing outside the set can arrive. Every
  // read goes through here, which makes this the single place a stale, absent
  // or out-of-range index turns back into the default rather than a crash.
  function partyDotPreset(idx) {
    return PARTY_DOT_COLORS[
      Number.isInteger(idx) && idx >= 0 && idx < PARTY_DOT_COLORS.length ? idx : 0];
  }

  const PARTY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0, I/1
  const PARTY_CODE_LENGTH = 10;

  const party = {
    enabled: !!store.get(PARTY_KEYS.enabled, false),
    code:    String(store.get(PARTY_KEYS.code, '') || ''),
    broker:  Math.min(PARTY_BROKERS.length - 1,
               Math.max(0, Number(store.get(PARTY_KEYS.broker, 0)) || 0)),
    // Which relay the player CHOSE, or -1 for auto. Kept separate from
    // `broker` (which is wherever we happen to be connected right now)
    // because the two answer different questions, and only this one survives
    // a reconnect.
    pin:     partyReadPin(store.get(PARTY_KEYS.pin, -1)),
    dots:    store.get(PARTY_KEYS.dots, true) !== false,
    tags:    store.get(PARTY_KEYS.tags, true) !== false,
    chat:    store.get(PARTY_KEYS.chat, true) !== false,
    list:    store.get(PARTY_KEYS.list, true) !== false,
    // Both default OFF. Excluding yourself was a deliberate 1.16.1 decision —
    // you already know your own health — and the box is a change to how the
    // HUD looks, so neither should arrive unasked for on an existing install.
    listSelf: store.get(PARTY_KEYS.listSelf, false) === true,
    listBox:  store.get(PARTY_KEYS.listBox, false) === true,
    // A handle typed into the panel. Only ever consulted when the account
    // cannot supply one, so the normal case is this staying empty.
    handle:  String(store.get(PARTY_KEYS.handle, '') || ''),
    // Clamped the way broker is, and for the same reason: the table can shrink
    // between versions, and a stored index that no longer exists must land on
    // the default rather than paint nothing.
    color:   Math.min(PARTY_DOT_COLORS.length - 1,
               Math.max(0, Number(store.get(PARTY_KEYS.color, 0)) || 0)),
    // runtime only
    id:        'p' + Math.random().toString(36).slice(2, 10),
    // When this client joined the party, epoch ms, set on every connect and
    // published with the position. The EARLIEST join in the room is the party
    // leader — see partyLeaderId().
    joinedAt:  0,
    peers:     new Map(),   // id -> {id, name, u, v, at, color, node, tag,
                            //        handle, hp, art}
    key:       null,
    topic:     null,
    transport: null,
    status:    'off',
    statusInfo: '',
    session:   0,           // bumped on every (re)connect to void stale async work
    pacer:     null,
    minimapSeen: false,
    tagLayer:  null,
    listLayer: null,        // the party list under the leaderboard
    listRows:  new Map(),   // key -> its row element, so rows are reused
    listAt:    0,           // last time the list was rebuilt
    listOrder: '',          // the row order currently hung, to avoid re-hanging
  };

  // A pinned relay wins over whatever was last connected to, so a rotation
  // that happened before the pin was set cannot outlive it.
  if (party.pin >= 0) party.broker = party.pin;

  // Anything that is not a real relay index means auto. A stored index also
  // has to survive the list getting shorter in a later version.
  function partyReadPin(raw) {
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n < PARTY_BROKERS.length ? n : -1;
  }

  // Picking a relay reconnects immediately: the whole point of choosing one is
  // to land on the same server as somebody else, and waiting for the next
  // dropped connection to apply it would defeat that.
  function partySetRelay(pin) {
    party.pin = partyReadPin(pin);
    store.set(PARTY_KEYS.pin, party.pin);
    if (party.pin >= 0) {
      party.broker = party.pin;
      store.set(PARTY_KEYS.broker, party.broker);
    }
    syncPartyUI();
    if (partyActive()) partyConnect();
  }

  function partyRandomCode() {
    const values = new Uint32Array(PARTY_CODE_LENGTH);
    try { PAGE.crypto.getRandomValues(values); }
    catch (e) { for (let i = 0; i < values.length; i++) values[i] = (Math.random() * 4294967296) >>> 0; }
    let out = '';
    for (let i = 0; i < PARTY_CODE_LENGTH; i++) {
      out += PARTY_CODE_ALPHABET[values[i] % PARTY_CODE_ALPHABET.length];
    }
    return out;
  }

  function partySetStatus(status, info) {
    if (party.status === status && party.statusInfo === (info || '')) return;
    party.status = status;
    party.statusInfo = info || '';
    syncPartyUI();
  }

  // The name a peer is shown as. Taken from the cosmetics tab, which is where
  // the player already tells this script what they are called in game.
  function partySelfName() {
    const n = stripInvis(nameColorState.name).trim();
    return (n || 'Player').slice(0, 20);
  }


  /* ----- who you are: handle, animal, health ----- */

  // A HANDLE is not an in-game name and the two are deliberately kept apart.
  // Names are typed per game, are not unique, and several members of one party
  // can wear the same one; a handle belongs to a mope account and is unique to
  // it. Party chat names the sender, so it uses the handle — naming the wrong
  // person is worse than naming nobody, which is why a member with no handle
  // is shown under their name rather than under a guess at one.
  //
  // mope's own rules on the shape of a handle are not visible from here, so
  // this is a conservative subset: what it rejects it simply treats as absent.
  const PARTY_HANDLE_RE = /^[A-Za-z0-9_.-]{2,24}$/;

  // Where a handle comes from, in order:
  //
  //   1. The panel's override field, if anything is typed in it.
  //   2. localStorage — mope caches the signed-in profile under
  //      `axis-auth-cache-v2` as {profile:{id, displayName, avatarUrl,
  //      handle}, walletBalances:[...]}. This is the normal answer: it costs
  //      nothing, it is there before the page has finished loading, and it is
  //      unambiguously the local player.
  //   3. GET /users/me, once every few minutes while 2 comes up empty. mope's
  //      account API is plain cookie-authenticated REST on this origin, so
  //      this needs nothing the page does not already have.
  //
  // The profile card's own DOM is deliberately NOT one of these.
  // `.identityHandle` and `.profileHandleCopy` render whichever profile is
  // open, which is very often somebody else's — a friends list is made of them
  // — and publishing a stranger's handle as your own is exactly the failure
  // this feature must not have.
  const PARTY_AUTH_CACHE_KEY = 'axis-auth-cache-v2';
  const PARTY_ME_URL = 'https://api.mope.io/users/me';
  const PARTY_HANDLE_LOOK_MS = 4000;    // how often the cache is re-read
  const PARTY_HANDLE_FETCH_MS = 300000; // and how often the request is retried

  const partyHandle = {
    cache: '',           // from localStorage
    remote: '',          // from /users/me
    lookedAt: -Infinity,
    fetchedAt: -Infinity,
  };

  function partyCleanHandle(raw) {
    const s = String(raw == null ? '' : raw).trim().replace(/^@+/, '');
    return PARTY_HANDLE_RE.test(s) ? s : '';
  }

  // The same reader serves the cache and the response, because they are the
  // same object wearing different amounts of wrapping — the client builds one
  // out of the other. Every plausible nesting is tried rather than one being
  // picked, since getting it wrong shows up only as a silently missing handle.
  function partyPickHandle(data) {
    if (!data || typeof data !== 'object') return '';
    const roots = [data, data.profile, data.publicProfile, data.user, data.data];
    for (const root of roots) {
      if (!root || typeof root !== 'object') continue;
      const direct = partyCleanHandle(root.handle);
      if (direct) return direct;
      const nested = root.publicProfile;
      if (nested && typeof nested === 'object') {
        const found = partyCleanHandle(nested.handle);
        if (found) return found;
      }
    }
    return '';
  }

  function partyHandleFromCache() {
    try {
      let raw = localStorage.getItem(PARTY_AUTH_CACHE_KEY);
      // The key carries a version suffix and mope has moved it before (this is
      // v2), so a miss falls back to whatever auth cache is actually there
      // rather than reporting no account at all.
      if (!raw) {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.indexOf('auth-cache') !== -1) { raw = localStorage.getItem(k); break; }
        }
      }
      if (!raw) return '';
      return partyPickHandle(JSON.parse(raw));
    } catch (e) { return ''; }
  }

  function partyFetchHandle(at) {
    try {
      PAGE.fetch(PARTY_ME_URL, {credentials: 'include', mode: 'cors'})
        .then((r) => (r && r.ok ? r.json() : null))
        .then((data) => {
          // Accepted only while it is still the newest request outstanding, so
          // a slow reply can never overwrite a fresher one.
          if (partyHandle.fetchedAt > at) return;
          partyHandle.remote = partyPickHandle(data);
        })
        .catch(() => { if (partyHandle.fetchedAt <= at) partyHandle.remote = ''; });
    } catch (e) { /* no fetch here, or blocked — the override field is the answer */ }
  }

  // Called from the per-frame list, so both lookups inside it run on their own
  // clocks rather than the caller's.
  function partySelfHandle() {
    const manual = partyCleanHandle(party.handle);
    if (manual) return manual;
    const now = performance.now();
    if (now - partyHandle.lookedAt >= PARTY_HANDLE_LOOK_MS) {
      partyHandle.lookedAt = now;
      partyHandle.cache = partyHandleFromCache();
      if (!partyHandle.cache && now - partyHandle.fetchedAt >= PARTY_HANDLE_FETCH_MS) {
        partyHandle.fetchedAt = now;
        partyFetchHandle(now);
      }
    }
    return partyHandle.cache || partyHandle.remote || '';
  }

  // Which biome directory each animal's artwork is filed under. This is mope's
  // own `biome` field, read out of the client bundle and then checked by
  // fetching all 101 of the `.ui.webp` paths it produces — every one resolved.
  //
  // It lives here rather than in the message because the biome is NOT the
  // peer's to choose: it is a fixed property of the species. A peer names an
  // animal and a rare variant; each end builds the path from its own copy of
  // this. So the worst a peer can name is an animal that does not exist, which
  // draws nothing — the same reasoning that has dot colors travel as an index
  // into a table rather than as a colour.
  //
  // `comfortZones` is a different thing and is not this: it is terrain an
  // animal survives in, and it files the kraken with the penguins.
  const PARTY_ART_BIOMES = {
    land: 'angry_duck baby_duck bear bee boa cassowary cheetah chicken cobra girabie momaffie ' +
          'crocodile deer dino_monster donkey dragon duck eagle elephant ' +
          'falcon fox frog giant_spider giraffe gorilla hedgehog ' +
          'hippopotamus lion macaw mole mouse ostrich ostrich_baby peacock ' +
          'pig pigeon rabbit rhinoceros tiger toucan trex woodpecker zebra',
    arctic: 'arctic_fox arctic_hare chipmunk ice_monster lemming mammoth ' +
            'markhor muskox penguin polar_bear reindeer sabertooth_tiger seal ' +
            'snow_leopard snowy_owl walrus wolf wolverine yeti',
    desert: 'armadillo bison black_widow camel desert_chipmunk fennec_fox ' +
            'gazelle giant_scorpion gobi_bear hyena kangaroo_rat komodo_dragon ' +
            'meerkat pterodactyl rattle_snake vulture warthog',
    ocean: 'blue_whale crab flamingo jellyfish king_crab kraken octopus orca ' +
           'pelican pufferfish sea_horse sea_monster shark shrimp snail squid ' +
           'stingray swordfish trout turtle',
    volcano: 'black_dragon king_dragon lava_monster phoenix',
  };

  const partyArtBiome = new Map();
  for (const partyArtBiomeName of Object.keys(PARTY_ART_BIOMES)) {
    for (const species of PARTY_ART_BIOMES[partyArtBiomeName].split(' ')) {
      if (species) partyArtBiome.set(species, partyArtBiomeName);
    }
  }

  const PARTY_ART_SUB_RE = /^[a-z_0-9]{2,24}$/;

  // What travels: '<species>' or '<species>/<rare>'. Anything not in the table
  // above comes back empty, which is a row without a picture rather than a row
  // with the wrong one.
  function partyArtKeyOf(ident) {
    if (!ident || !ident.species) return '';
    const species = String(ident.species).toLowerCase();
    if (!partyArtBiome.has(species)) return '';
    const sub = ident.sub ? String(ident.sub).toLowerCase() : '';
    return sub && PARTY_ART_SUB_RE.test(sub) ? species + '/' + sub : species;
  }

  // Every field is re-checked here even though partyArtKeyOf built it, because
  // between the two ends sits a peer that could have sent anything at all. The
  // result goes into an <img> src, so this is the boundary that keeps it
  // same-origin and inside the set of paths mope actually publishes.
  function partyArtUrl(key) {
    if (typeof key !== 'string' || !key) return '';
    const bits = key.split('/');
    if (bits.length > 2) return '';
    const species = bits[0];
    const sub = bits[1] || '';
    const biome = partyArtBiome.get(species);
    if (!biome) return '';
    if (sub && !PARTY_ART_SUB_RE.test(sub)) return '';
    return './assets/animals/' + biome + '/' + species + '/' +
      (sub ? sub + '/' : '') + species + '.ui.webp';
  }

  // Your own animal, straight from mope's own player entity: its species and
  // rare variant are read off the animal itself, so a shop skin no longer
  // costs the rare (the 1.0.x ability-icon reading lost it).
  function partySelfArtKey() {
    return artKeyOf(myAnimal());
  }

  // Your server health, 0-100 — the same percent mope prints above your
  // animal. -1 means "not known", which a list row shows as an em-dash rather
  // than as a claim of zero.
  function partySelfHealth() {
    const value = healthOf(myAnimal());
    return value != null && value >= 0 && value <= 100 ? Math.round(value) : -1;
  }

  // The XP needed for the NEXT tier, per tier (index 0 is tier 1). From
  // mope's own upgrade table (requiredXP, shifted by one).
  const TIER_NEXT_XP = [
    100, 400, 1000, 2000, 5000, 12000, 25000, 40000, 60000,
    90000, 145000, 350000, 650000, 1000000, 5000000, 10000000, 40000000,
  ];

  // 2030000 -> '2.03M', 5000000 -> '5M', 640 -> '640'. The receiver shows the
  // string as it is, so only its shape matters (1.0.x checks it against
  // /^[\d.,]{1,12}[KMB]?$/ on each side of the slash).
  function partyCompact(n) {
    if (!Number.isFinite(n) || n < 0) return '';
    const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (const [size, suffix] of units) {
      // The epsilon absorbs float error: 2030000 / 1e6 * 100 is 202.99999...
      if (n >= size) return String(Math.floor(n / size * 100 + 1e-6) / 100) + suffix;
    }
    return String(Math.floor(n));
  }

  // Your XP as the party list shows it: "2.03M/5M", or '' when either half
  // is unknown — an unreadable member and one on an older build look the same.
  function partySelfXp() {
    const me = myAnimal();
    const game = bridge.game;
    const xp = game && game.animalStats && game.animalStats.xp;
    const tier = me && me.tier;
    if (typeof xp !== 'number' || !(tier >= 1)) return '';
    const next = TIER_NEXT_XP[Math.min(tier, TIER_NEXT_XP.length) - 1];
    const have = partyCompact(xp);
    const need = partyCompact(next);
    return have && need ? have + '/' + need : '';
  }

  // Health and animal travel whenever you are in a party and in a game — not
  // only while your own list is on. The list toggle says whether YOU want to
  // see the party; this says whether the party can see YOU.
  function partyNeedsSelfHealth() {
    return partyActive() && inGame();
  }
  function partyActive() {
    return settings.masterEnabled && party.enabled;
  }

  /* ----- who is in charge -----
   *
   * 1.0.2. There is no server here. Every member is a peer publishing to a
   * public broker, so "leader" cannot be granted by anyone — it has to be a
   * fact all of us compute the same way from what we can all see.
   *
   * The rule is the EARLIEST JOIN WINS, tie-broken by id. Everybody publishes
   * the epoch millisecond they joined; the lowest one in the room is the
   * leader, and since everybody applies that to the same roster, everybody
   * arrives at the same answer without anyone announcing anything.
   *
   * Two things follow from it that are worth stating, because both are
   * features rather than accidents:
   *   - Leadership HEALS. If the leader closes the game they age out of the
   *     roster, the next-earliest join becomes the lowest, and the party has a
   *     new leader within PARTY_DROP_MS. No election, no handover message.
   *   - Reconnecting does not cost you it. joinedAt is stamped once and kept
   *     across dropped sockets, so a member whose wifi blinks comes back as
   *     the same age they were.
   *
   * THE WEAKNESS IS CLOCK SKEW, and it is worth being honest about. These are
   * wall clocks on different machines, so two people joining within a few
   * seconds of each other can be ordered by whose clock is fast rather than by
   * who was actually first. For a party of friends deciding who can remove
   * somebody, that is an acceptable trade against the complexity of a real
   * election. It is stable once decided, which matters more than being right
   * to the second: everybody agrees, and it does not flap.
   *
   * A member on an older build publishes no join time at all. They are skipped
   * rather than defaulted, so they simply cannot be leader — defaulting them
   * to 0 would make every old client leader instead, which is the wrong way
   * round to fail.
   */
  function partyLeaderId() {
    let bestId = '';
    let bestAt = Infinity;
    if (party.joinedAt > 0) { bestId = party.id; bestAt = party.joinedAt; }
    for (const peer of party.peers.values()) {
      if (!(peer.joinedAt > 0)) continue;
      if (peer.joinedAt < bestAt ||
          (peer.joinedAt === bestAt && peer.id < bestId)) {
        bestAt = peer.joinedAt;
        bestId = peer.id;
      }
    }
    return bestId;
  }

  function partyIsLeader() {
    return partyActive() && party.joinedAt > 0 && partyLeaderId() === party.id;
  }

  // Remove somebody from the party. Cooperative by nature: the packet asks
  // their client to leave and their client does, which is enough among people
  // who chose to be in a party together and is not a security control. A
  // modified client can ignore it, exactly as a modified client can do
  // anything else — there is no server to enforce against.
  //
  // Dropped locally as well as asked to leave, so the leader's own roster
  // reflects the decision immediately rather than waiting PARTY_DROP_MS for
  // the kicked member to age out.
  function partyKick(targetId) {
    if (!partyIsLeader()) return false;
    if (!targetId || targetId === party.id) return false;
    const peer = party.peers.get(targetId);
    if (!peer) return false;
    const name = peer.name || '(unnamed)';
    if (party.transport && party.transport.isReady()) {
      partySeal({i: party.id, k: targetId})
        .then((bytes) => { if (party.transport) party.transport.publish(bytes); })
        .catch(() => {});
    }
    partyDestroyPeer(peer);
    party.peers.delete(targetId);
    partyChatToast('Removed ' + name + ' from the party', false);
    dbg('party kick', targetId, name);
    return true;
  }

  // Being on the receiving end. The party is switched OFF rather than merely
  // disconnected: a reconnect loop that keeps rejoining a party you were just
  // removed from is worse for everybody than a switch you can turn back on.
  function partyKicked() {
    party.enabled = false;
    store.set(PARTY_KEYS.enabled, false);
    partyDisconnect('kicked');
    partySetStatus('off', 'removed from the party');
    party.joinedAt = 0;
    partyChatClear();
    partyListHide();
    qolcToast('You were removed from the party', 'bad');
    syncPartyUI();
    dbg('party kicked');
  }

  /* ----- crypto ----- */

  const PARTY_ENC = new TextEncoder();
  const PARTY_DEC = new TextDecoder();
  // Topic and key both come from the party code, but through different
  // prefixes, so holding one tells you nothing about the other.
  const PARTY_TOPIC_INFO = 'lumi-party-topic-v1|';
  const PARTY_KEY_SALT = 'lumi-party-key-v1';
  const PARTY_TOPIC_PREFIX = 'lumi/party/v1/';
  // PBKDF2 rather than HKDF: a party code is short and human-typed, and
  // PBKDF2's entire purpose is making a guess expensive. See the header note
  // on the fixed salt.
  const PARTY_KEY_ITERATIONS = 200000;
  const PARTY_IV_BYTES = 12;

  function partyNormalizeCode(code) {
    return String(code || '').trim().toUpperCase();
  }

  function partyHex(bytes) {
    let s = '';
    for (const b of bytes) s += b.toString(16).padStart(2, '0');
    return s;
  }

  async function partyDerive(code) {
    const norm = partyNormalizeCode(code);
    if (!norm) return null;
    const subtle = PAGE.crypto && PAGE.crypto.subtle;
    if (!subtle) return null;
    const digest = await subtle.digest('SHA-256', PARTY_ENC.encode(PARTY_TOPIC_INFO + norm));
    const topic = PARTY_TOPIC_PREFIX + partyHex(new Uint8Array(digest)).slice(0, 24);
    const base = await subtle.importKey('raw', PARTY_ENC.encode(norm), 'PBKDF2', false, ['deriveKey']);
    const key = await subtle.deriveKey(
      {name: 'PBKDF2', salt: PARTY_ENC.encode(PARTY_KEY_SALT),
       iterations: PARTY_KEY_ITERATIONS, hash: 'SHA-256'},
      base, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
    return {topic, key};
  }

  // Fresh random 96-bit IV per message, prepended. AES-GCM only breaks on IV
  // REUSE under one key, and at the pacing below a collision needs billions of
  // messages.
  async function partySeal(value) {
    const iv = PAGE.crypto.getRandomValues(new Uint8Array(PARTY_IV_BYTES));
    const ct = await PAGE.crypto.subtle.encrypt(
      {name: 'AES-GCM', iv}, party.key, PARTY_ENC.encode(JSON.stringify(value)));
    const out = new Uint8Array(PARTY_IV_BYTES + ct.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), PARTY_IV_BYTES);
    return out;
  }

  // null means "not from a code holder" — wrong party, corruption, or an
  // unrelated message that happened to land on the topic. Always ignored,
  // never surfaced as an error.
  async function partyUnseal(bytes) {
    if (!party.key || !bytes || bytes.length <= PARTY_IV_BYTES) return null;
    try {
      const pt = await PAGE.crypto.subtle.decrypt(
        {name: 'AES-GCM', iv: bytes.subarray(0, PARTY_IV_BYTES)},
        party.key, bytes.subarray(PARTY_IV_BYTES));
      const parsed = JSON.parse(PARTY_DEC.decode(pt));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) { return null; }
  }

  /* ----- MQTT 3.1.1 over WebSocket ----- */
  // Carried over from the 1.2.1 party map. This part was never the problem:
  // it is correct MQTT and it worked against these brokers.

  function partyMqStr(s) {
    const b = PARTY_ENC.encode(s);
    const out = new Uint8Array(b.length + 2);
    out[0] = (b.length >> 8) & 255;
    out[1] = b.length & 255;
    out.set(b, 2);
    return out;
  }

  function partyMqConcat(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function partyMqPacket(typeByte, body) {
    let len = body.length;
    const lenBytes = [];
    do {
      let b = len & 127;
      len >>>= 7;
      if (len > 0) b |= 128;
      lenBytes.push(b);
    } while (len > 0);
    const out = new Uint8Array(1 + lenBytes.length + body.length);
    out[0] = typeByte;
    out.set(lenBytes, 1);
    out.set(body, 1 + lenBytes.length);
    return out;
  }

  // A WebSocket frame is not a packet boundary — one frame can carry several
  // packets, or half of one.
  function partyMakeReader() {
    let buf = new Uint8Array(0);
    return function feed(chunk) {
      const merged = new Uint8Array(buf.length + chunk.length);
      merged.set(buf);
      merged.set(chunk, buf.length);
      buf = merged;
      const packets = [];
      for (;;) {
        if (buf.length < 2) break;
        let mult = 1, len = 0, i = 1, digit, need = false;
        do {
          if (i >= buf.length) { need = true; break; }
          if (i > 4) return {packets, fatal: 'malformed length'};
          digit = buf[i++];
          len += (digit & 127) * mult;
          mult *= 128;
        } while (digit & 128);
        if (need) break;
        if (buf.length < i + len) break;
        packets.push({type: buf[0] >> 4, body: buf.slice(i, i + len)});
        buf = buf.slice(i + len);
      }
      return {packets, fatal: null};
    };
  }

  function partyReadPublish(body) {
    if (body.length < 2) return null;
    const tlen = (body[0] << 8) | body[1];
    if (body.length < 2 + tlen) return null;
    return {payload: body.subarray(2 + tlen)};
  }

  function partyDisconnect(reason) {
    const t = party.transport;
    party.transport = null;
    party.session += 1;
    if (t) t.close(reason);
    for (const peer of party.peers.values()) partyDestroyPeer(peer);
    party.peers.clear();
    if (party.pacer) party.pacer.reset();
  }

  function partyCreateTransport(url, topic, session) {
    const WS = PAGE.WebSocket || WebSocket;
    let ws = null, ready = false, pingId = 0, connectTimer = 0, read = null;

    function close(reason) {
      const sock = ws;
      ws = null;
      ready = false;
      clearInterval(pingId);
      clearTimeout(connectTimer);
      if (!sock) return;
      try { sock.onopen = sock.onmessage = sock.onerror = sock.onclose = null; } catch (e) {}
      try { sock.close(); } catch (e) {}
      dbg('party: socket closed —', reason);
    }

    function rotateBroker() {
      // A pinned relay is a deliberate choice, and it is almost always made so
      // that two people end up on the SAME server — so a dropped connection
      // must not quietly move it. Rotating on every onclose is what split a
      // working party: both ends kept a green light, because each connection
      // was fine, and only the relay underneath had changed. Retry the chosen
      // one instead and let the status line say it is unreachable.
      if (party.pin >= 0) { party.broker = party.pin; return; }
      party.broker = (party.broker + 1) % PARTY_BROKERS.length;
      store.set(PARTY_KEYS.broker, party.broker);
    }

    const label = PARTY_BROKERS[party.broker][0];
    try {
      ws = new WS(url, 'mqtt'); // the subprotocol is required for MQTT-over-WS
      ws.binaryType = 'arraybuffer';
    } catch (e) {
      partySetStatus('bad', 'blocked — ' + ((e && e.message) || 'page CSP?'));
      rotateBroker();
      return {close() {}, isReady() { return false; }, publish() { return false; }};
    }
    read = partyMakeReader();
    const sock = ws;
    partySetStatus('wait', 'connecting to ' + label + '…');
    connectTimer = setTimeout(() => {
      if (ws !== sock || ready) return;
      partySetStatus('bad', label + ' timed out — trying another relay…');
      try { sock.close(); } catch (e) {}
    }, 7000);

    sock.onopen = () => {
      try {
        sock.send(partyMqPacket(0x10, partyMqConcat([
          partyMqStr('MQTT'),
          new Uint8Array([4, 0x02, 0x00, 0x3c]), // v3.1.1, clean session, 60s keepalive
          partyMqStr('lumi-' + party.id + '-' + Math.random().toString(36).slice(2, 8)),
        ])));
      } catch (e) { partySetStatus('bad', 'handshake failed'); }
    };
    sock.onmessage = (ev) => {
      if (ws !== sock || party.session !== session) return;
      let res;
      try { res = read(new Uint8Array(ev.data)); }
      catch (e) { return; }
      if (res.fatal) { close(res.fatal); return; }
      for (const p of res.packets) {
        if (p.type === 2) {                               // CONNACK
          if (p.body.length >= 2 && p.body[1] !== 0) {
            partySetStatus('bad', 'broker refused (code ' + p.body[1] + ')');
            rotateBroker();
            close('refused');
            return;
          }
          ready = true;
          clearTimeout(connectTimer);
          try {
            sock.send(partyMqPacket(0x82, partyMqConcat([
              new Uint8Array([0, 1]), partyMqStr(topic), new Uint8Array([0]),
            ])));
          } catch (e) {}
          pingId = setInterval(() => {
            try { sock.send(partyMqPacket(0xc0, new Uint8Array(0))); } catch (e) {}
          }, 30000);
          partySetStatus('ok', label);
        } else if (p.type === 3) {                        // PUBLISH (QoS 0)
          const msg = partyReadPublish(p.body);
          if (msg) partyOnPayload(msg.payload, session);
        }
      }
    };
    sock.onerror = () => {
      if (ws === sock) partySetStatus('bad', 'cannot reach ' + label + ' (CSP or broker down)');
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      ready = false;
      clearInterval(pingId);
      clearTimeout(connectTimer);
      rotateBroker();
      if (partyActive()) partySetStatus('bad', 'disconnected — retrying…');
    };

    return {
      close,
      isReady() { return ready; },
      publish(payload) {
        if (!ws || !ready) return false;
        try { ws.send(partyMqPacket(0x30, partyMqConcat([partyMqStr(topic), payload]))); return true; }
        catch (e) { return false; }
      },
    };
  }

  async function partyConnect() {
    partyDisconnect('reconnecting');
    if (!partyActive()) { partySetStatus('off', ''); return; }
    const code = partyNormalizeCode(party.code);
    if (!code) { partySetStatus('bad', 'set a party code'); return; }

    const session = party.session;
    partySetStatus('wait', 'deriving key…');
    let derived = null;
    try { derived = await partyDerive(code); }
    catch (e) { derived = null; }
    // The code can change (or the feature be switched off) while PBKDF2 runs.
    if (party.session !== session) return;
    if (!derived) {
      partySetStatus('bad', PAGE.crypto && PAGE.crypto.subtle
        ? 'could not derive a key from that code'
        : 'this browser has no WebCrypto — party map needs HTTPS');
      return;
    }
    party.key = derived.key;
    party.topic = derived.topic;
    // Stamped once per connect, not once per session. Reconnecting after a
    // dropped socket must not hand leadership to somebody who joined later:
    // the party is the same party, and you were in it first.
    if (!party.joinedAt) party.joinedAt = Date.now();
    party.pacer = partyMakePacer();
    party.transport = partyCreateTransport(PARTY_BROKERS[party.broker][1], derived.topic, session);
  }

  async function partyOnPayload(bytes, session) {
    const data = await partyUnseal(bytes);
    if (!data || party.session !== session) return;
    if (typeof data.i !== 'string' || data.i === party.id) return;
    // A chat message carries no position, so it has to be taken before the
    // plausibility check below — which would otherwise throw it away. Our own
    // messages never reach here: the broker echoes them back to us, but the id
    // check above drops them and partyChatSend() has already drawn them.
    if (typeof data.m === 'string') {
      if (party.chat && data.m) {
        // The name is carried on the message as well as the handle, and is
        // ALSO looked up from the roster, because either one can be missing:
        // a chat message can arrive before that member's first position does,
        // and a member on an older build sends neither.
        const known = party.peers.get(data.i);
        const said = typeof data.n === 'string' ? data.n.slice(0, 20) : '';
        partyChatShow(data.m.slice(0, PARTY_CHAT_MAX), data.c, performance.now(),
          partyCleanHandle(data.g), said || (known && known.name) || '');
      }
      return;
    }
    // A kick, which like a chat message carries no position and so has to be
    // taken before the plausibility check throws it away.
    //
    // Honoured ONLY from whoever we independently reckon the leader to be. It
    // is not a permission check — there is no server and nothing is signed —
    // but it does mean a member cannot kick anybody just by sending the
    // packet, and that everyone in the room applies the same answer, because
    // everyone computes the leader from the same roster.
    if (typeof data.k === 'string' && data.k) {
      if (data.i !== partyLeaderId()) return;
      if (data.k === party.id) partyKicked();
      else {
        const gone = party.peers.get(data.k);
        if (gone) { partyDestroyPeer(gone); party.peers.delete(data.k); }
      }
      return;
    }
    if (!partyPlausible(data.u, data.v)) return;
    let peer = party.peers.get(data.i);
    if (!peer) {
      peer = {id: data.i, name: '', u: 0, v: 0, at: 0, color: 0, node: null,
              tag: null, handle: '', hp: -1, art: '', xp: '', joinedAt: 0};
      party.peers.set(data.i, peer);
    }
    peer.name = typeof data.n === 'string' ? data.n.slice(0, 20) : '';
    peer.u = data.u;
    peer.v = data.v;
    // Stored raw and validated at the point of use — a peer on an older build
    // sends no colour at all, and partyDotPreset() turns that into the default.
    peer.color = data.c;
    // The three 1.16.0 fields, all optional for exactly that reason. Health is
    // checked here because -1 has to mean "not known" everywhere downstream;
    // the animal is left as sent and checked by partyArtUrl(), which is the
    // one place it turns into a URL.
    peer.handle = partyCleanHandle(data.g);
    peer.hp = Number.isInteger(data.h) && data.h >= 0 && data.h <= 100 ? data.h : -1;
    peer.art = typeof data.a === 'string' ? data.a.slice(0, 48) : '';
    // 1.21.0. Shape-checked here rather than at the point of use, because
    // unlike the animal it goes straight to the screen as text — anything that
    // is not two mope-formatted figures either side of a slash is refused
    // outright rather than printed. A peer on an older build sends nothing and
    // lands on '', which is the same thing a member whose XP bar has not been
    // read yet looks like.
    peer.xp = typeof data.x === 'string' &&
      /^[\d.,]{1,12}[KMB]?\/[\d.,]{1,12}[KMB]?$/i.test(data.x) ? data.x : '';
    // 1.29.0. Whether this member is in a 1v1 right now. Sent only when true,
    // so a peer on an older build and a peer who is not duelling are the same
    // thing on the wire — which is what they are. `=== true` rather than a
    // truthiness test, because a field arriving as a string or a number from
    // some future build should read as "no" rather than as "yes".
    peer.duel = data.d === true;
    // 1.0.2. When they joined, which is what decides the leader. Validated as
    // a positive finite number and otherwise left at 0, which reads as "not
    // eligible" rather than "joined at the dawn of time" — a member on an
    // older build sends nothing, and defaulting them to 0 the other way would
    // make every old client the leader.
    peer.joinedAt = Number.isFinite(data.j) && data.j > 0 ? data.j : 0;
    peer.at = performance.now();
  }

  /* ----- pacing ----- */
  // The 1.2.1 build published at a flat 10 Hz whether or not anything had
  // changed. This sends promptly while moving and drops to a heartbeat while
  // still — a parked player costs one message every two seconds, not twenty.
  const PARTY_PACE_MIN_MS = 100;
  const PARTY_PACE_HEARTBEAT_MS = 2000;
  const PARTY_PACE_EPSILON = 0.0015; // fraction of the map; below this is noise

  // 1.16.0 gave it a second question to ask. Position alone was the whole
  // input, so a member standing still dropped to one message every two seconds
  // — which is fine for a dot that is not moving and far too slow for a health
  // reading, since standing still is exactly what you do while something is
  // eating you. The stamp is the health and animal rolled into one string, and
  // a change in it sends as promptly as movement does.
  //
  // The idle cost is unchanged: a parked member at full health has neither
  // moved nor changed, so they still send one heartbeat every two seconds. And
  // the 100ms floor still caps everything, so a health bar ticking down cannot
  // send faster than the map already could.
  function partyMakePacer() {
    let lastAt = -Infinity, lastU = null, lastV = null, lastStamp = null;
    return {
      should(now, u, v, stamp) {
        if (!Number.isFinite(u) || !Number.isFinite(v)) return false;
        if (now - lastAt < PARTY_PACE_MIN_MS) return false;
        const moved = lastU === null || Math.hypot(u - lastU, v - lastV) >= PARTY_PACE_EPSILON;
        const changed = stamp !== lastStamp;
        if (!moved && !changed && now - lastAt < PARTY_PACE_HEARTBEAT_MS) return false;
        lastAt = now;
        lastU = u;
        lastV = v;
        lastStamp = stamp;
        return true;
      },
      reset() { lastAt = -Infinity; lastU = null; lastV = null; lastStamp = null; },
    };
  }

  /* ----- projection -----
   *
   * mope's own minimap is `$.minimap`: {container, sprite, player, ...}, and it
   * places your marker with
   *
   *     worldToMinimapPosition(p) {
   *       const k = sprite.width / $.map.shape.width;
   *       return {x: p.x * k - sprite.width, y: p.y * k};
   *     }
   *
   * so a position divided by the sprite width is a fraction of the map that
   * means the same thing on every screen: u = (x + W) / W, v = y / W. That is
   * the wire format 1.0.x established, kept exactly. The 1.0.x build had to
   * FIND this container by shape among tens of thousands of nodes and guess
   * which child was the marker; the bridge hands all three over by name.
   */

  // {container, sprite, dot, spriteW} for mope's minimap, or null while there
  // is none (the menu, a culled duel).
  function partyReadParts() {
    const game = bridge.game;
    const minimap = game && game.minimap;
    if (!minimap) return null;
    const container = minimap.container;
    const sprite = minimap.sprite;
    const dot = minimap.player;
    if (!container || container.destroyed || !sprite || !dot || !dot.position) return null;
    const spriteW = Number(sprite.width);
    if (!Number.isFinite(spriteW) || spriteW <= 0) return null;
    return {container, sprite, dot, spriteW};
  }

  // Our own fractional position. Read from the animal itself rather than off
  // the marker, so it is right even on a frame the minimap skipped — and it
  // is the identical number: x / mapWidth is (x * k) / W with k = W / mapWidth.
  function partySelfPosition(parts) {
    const me = myAnimal();
    const game = bridge.game;
    const shape = game && game.map && game.map.shape;
    const width = shape && Number(shape.width);
    if (me && me.position && width > 0) {
      const u = Number(me.position.x) / width;
      const v = Number(me.position.y) / width;
      if (Number.isFinite(u) && Number.isFinite(v)) return {u, v};
    }
    if (!parts) return null;
    const x = Number(parts.dot.position.x);
    const y = Number(parts.dot.position.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const u = (x + parts.spriteW) / parts.spriteW;
    const v = y / parts.spriteW;
    return Number.isFinite(u) && Number.isFinite(v) ? {u, v} : null;
  }

  // Inverse of the above, using OUR live sprite width — which is what makes
  // two clients with different window sizes agree.
  function partyProjectPeer(parts, u, v) {
    return {x: u * parts.spriteW - parts.spriteW, y: v * parts.spriteW};
  }

  // Deliberately loose on v: mope scales BOTH axes by width (see its own
  // worldToMinimapPosition), so on a non-square map v legitimately exceeds 1.
  function partyPlausible(u, v) {
    return Number.isFinite(u) && Number.isFinite(v) &&
      u >= -0.05 && u <= 1.05 && v >= -0.05 && v <= 2.05;
  }

  /* ----- drawing ----- */

  // Clone mope's own player marker rather than inventing one: same texture,
  // same construction (a black outline sprite under a filled one), same size.
  // Only the fill is tinted, so a party dot reads as a native marker in a
  // different colour instead of a foreign blob.
  function partyMakeDot(container, parts, colorIdx) {
    const src = parts.dot;
    const kids = Array.isArray(src.children) ? src.children : [];
    if (!kids.length) return null;
    try {
      const node = new src.constructor();
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        const clone = new k.constructor({
          texture: k.texture,
          width: k.width,
          height: k.height,
        });
        if (clone.anchor && k.anchor) {
          clone.anchor.x = k.anchor.x;
          clone.anchor.y = k.anchor.y;
        }
        node.addChild(clone);
      }
      // Painted here as well as in the tick so a marker is never briefly the
      // colour of whatever it was cloned from, not even for one frame.
      partyPaintDot(node, colorIdx);
      // Marked so partyReadParts can never mistake one of ours for the game's
      // own marker, and sorted above pumpkins but below your own dot.
      node.__lumiPartyDot = true;
      try { node.zIndex = 1; } catch (e) { /* zIndex is optional */ }
      container.addChild(node);
      return node;
    } catch (e) {
      return null;
    }
  }

  // Tints are set outright rather than copied from the source. Copying is how
  // party dots came out brown-ringed and pumpkin-coloured when the wrong node
  // was cloned; stating both colours means the marker looks the same no matter
  // what it was built from.
  //
  // Applied after construction rather than during it, so a peer that switches
  // colour repaints the marker it already has instead of rebuilding it. This
  // runs per member per frame, hence the guard — after the frame a colour
  // actually changes on, it is one comparison and out. The preset OBJECT is
  // what is remembered, so an index that resolves to the default is not
  // repainted every frame while the peer keeps publishing it.
  function partyPaintDot(node, colorIdx) {
    const preset = partyDotPreset(colorIdx);
    if (node.__lumiPartyPaint === preset) return;
    const kids = Array.isArray(node.children) ? node.children : [];
    for (let i = 0; i < kids.length; i++) {
      // The last child is the fill; everything under it is the outline mope
      // draws beneath its own marker.
      kids[i].tint = (i === kids.length - 1) ? preset.fillTint : preset.lineTint;
    }
    node.__lumiPartyPaint = preset;
  }

  function partyDestroyPeer(peer) {
    try {
      if (peer.node) {
        if (peer.node.parent) peer.node.parent.removeChild(peer.node);
        if (typeof peer.node.destroy === 'function') peer.node.destroy({children: true});
      }
    } catch (e) { /* the game owns the tree; never fight it */ }
    peer.node = null;
    if (peer.tag) { try { peer.tag.remove(); } catch (e) {} peer.tag = null; }
  }

  // ADOPTED BY ID, never created blind — see qolcOwnLayer().
  function partyTagLayer() {
    let layer = party.tagLayer;
    if (layer && layer.isConnected) return layer;
    layer = qolcOwnLayer('qolc-party');
    party.tagLayer = layer;
    return layer;
  }

  function partyHideAll() {
    for (const peer of party.peers.values()) {
      if (peer.node) peer.node.visible = false;
      if (peer.tag) peer.tag.style.display = 'none';
    }
  }

  // Name tags are DOM nodes while party dots live inside Pixi: the
  // container's own toGlobal() maps the dot onto the canvas, and canvasRect()
  // maps the canvas onto the page. Every DOM write is compared first so an
  // unchanged peer heartbeat does not invalidate layout or paint.
  function partyPlaceTag(peer, container, local, screen) {
    if (!party.tags || !screen) {
      if (peer.tag) peer.tag.style.display = 'none';
      return;
    }
    const layer = partyTagLayer();
    if (!layer) return;
    if (!peer.tag) {
      peer.tag = document.createElement('div');
      peer.tag.className = 'qolc-party-tag';
      layer.appendChild(peer.tag);
    }
    let global = null;
    try { global = container.toGlobal({x: local.x, y: local.y}); } catch (e) { global = null; }
    if (!global) {
      if (peer.tag.style.display !== 'none') peer.tag.style.display = 'none';
      return;
    }
    const name = peer.name || '?';
    if (peer.tag.textContent !== name) peer.tag.textContent = name;
    const left = Math.round(
      screen.rect.left + global.x * (screen.rect.width / screen.w)) + 'px';
    const top = Math.round(
      screen.rect.top + global.y * (screen.rect.height / screen.h)) + 'px';
    if (peer.tag.style.display !== 'block') peer.tag.style.display = 'block';
    if (peer.tag.style.left !== left) peer.tag.style.left = left;
    if (peer.tag.style.top !== top) peer.tag.style.top = top;
  }

  /* ----- party chat ----- */

  // Mode is NOT persisted. Coming back in a later session already talking on a
  // channel you cannot see would be a nasty surprise, so every session starts
  // in public chat and the switch has to be made deliberately.
  const partyChat = {
    mode:   false,   // false = public chat, true = party chat
    lines:  [],      // {el, at} — newest last, drawn nearest the head
    stack:  null,    // the container the lines live in
    input:  null,
    field:  null,
    open:   false,
    // 1.0.2. Whether the party has already been told this duel that we cannot
    // see them. Latched rather than counted, and cleared when the duel ends.
    focusTold: false,
  };

  const PARTY_CHAT_MAX = 120;          // characters per message
  const PARTY_CHAT_LIFE_MS = 6500;     // how long a line stays above a head
  const PARTY_CHAT_MAX_LINES = 4;      // oldest is dropped past this
  // A viewport-space offset, deliberately unrelated to the Pixi animal, canvas
  // scale or camera zoom. Keeping this in CSS is what makes the composer hold
  // exactly one position instead of being rewritten while the game renders.
  const PARTY_CHAT_FIXED_RISE = 90;
  const PARTY_CHAT_PINK = '#ff5ec4';

  // Focus mode takes the HOTKEYS with it, which is what this gates — P and
  // Enter stop being ours for the duration of a duel and go back to the game.
  // It does not gate receiving: messages still arrive and still expire on
  // their own timer, so a duel that ends inside a message's six seconds shows
  // it with the right time left rather than a backlog.
  function partyChatOn() {
    return partyActive() && party.chat && !arenaFocusHiding();
  }

  function partyChatToast(text, bad) {
    qolcToast(text, bad ? 'is-bad' : '');
  }

  function partyChatSetMode(on) {
    partyChat.mode = !!on;
    if (!partyChat.mode) partyChatCloseInput();
    partyChatToast(partyChat.mode
      ? 'Party chat — only your party can see what you say'
      : 'Public chat — everyone can see what you say');
  }

  // Swapping channel is debounced. Hammering P walked the feature through
  // states nobody designed for — a switch landing mid-open, an input closing
  // underneath its own toast — so a swap inside this window is dropped
  // outright. The key is still consumed either way, so a spammed P never
  // reaches the game either.
  const PARTY_CHAT_SWAP_MS = 1000;
  let partyChatSwapAt = -Infinity;

  function partyChatToggle() {
    if (!partyChatOn()) {
      partyChatToast('Party chat needs the party map switched on', true);
      return;
    }
    const now = performance.now();
    if (now - partyChatSwapAt < PARTY_CHAT_SWAP_MS) return;
    partyChatSwapAt = now;
    partyChatSetMode(!partyChat.mode);
  }

  /* ----- the bubbles above your own animal ----- */

  // ONE stack, adopted rather than made a second time.
  //
  // This used to `createElement` unconditionally whenever the cached node was
  // not connected, with nothing checking whether a `#qolc-party-chat` was
  // already on the page. Two of them is not a cosmetic problem: both carry
  // `position: fixed` at the SAME anchor — `top: calc(50% - 90px)` with
  // `translate(-50%, -100%)`, so both are bottom-aligned to the same line —
  // and whichever one holds the composer draws it straight on top of whatever
  // messages are sitting in the other. That is the overlapping chat box in the
  // report; nothing about the flex layout can produce it, because inside one
  // stack the input is the last child and the messages are above it.
  //
  // Two stacks needs two things holding separate references to "the stack",
  // which is what a second copy of this script installed alongside the first
  // gives you — see the instance guard at the top of the file. Adopting by id
  // makes the duplicate structurally impossible either way.
  function partyChatStack() {
    if (partyChat.stack && partyChat.stack.isConnected) return partyChat.stack;
    const layer = partyTagLayer();
    if (!layer) return null;
    let stack = document.getElementById('qolc-party-chat');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'qolc-party-chat';
      layer.appendChild(stack);
    } else if (stack.parentNode !== layer) {
      // Adopted from wherever it was — a layer that has since been replaced,
      // or another copy of this script's. Moving it keeps one stack rather
      // than leaving an orphan drawing at the same anchor.
      layer.appendChild(stack);
    }
    partyChat.stack = stack;
    // The composer is re-parented with it. It is the stack's last child by
    // design, and a stack swapped out from under it would otherwise leave the
    // input behind in the old one — the exact overlap this is here to stop.
    if (partyChat.input && partyChat.input.parentNode !== stack && partyChat.open) {
      stack.appendChild(partyChat.input);
    }
    return stack;
  }

  // "@handle: message" — the handle in the sender's own dot colour, the
  // message itself plain white. The whole line used to take the dot colour,
  // which said who was talking but made the darker presets a struggle to read
  // and gave what they actually said no emphasis of its own. Splitting it does
  // both jobs at once, and it puts the colour on the part that is identifying
  // somebody rather than on the part that is not.
  //
  // A member with no handle is labelled with their in-game name and no @, so
  // the two can never be read as the same kind of thing. A member with neither
  // is "someone", which is honest: the message is real and worth showing even
  // when nothing has come through to say who sent it.
  //
  // The coloured halo this used to carry was there to keep a dark preset
  // readable over the map, back when the text sat on the map itself; with a
  // dark box behind it that job is done, and the glow only read as a white
  // outline smeared around the letters.
  // The chat box is `rgba(22,24,28,0.76)` over the map — call it a very dark
  // grey. A handle has to be readable on that, and two of the eleven presets
  // are not: Violet and Ultramarine are saturated and dark by design, because
  // on the MAP they are read against grass and sand rather than against this.
  //
  // The floor is relative luminance, the same measure the preset table's own
  // contrast ratios are quoted in. Reaching it is a tint — a small step toward
  // white, repeated — which keeps the hue exactly and gives up a little
  // saturation.
  //
  // 0.16 is not a taste judgement, it is where 3:1 lands. The box is
  // rgba(22,24,28,0.76) over the map, whose luminance is about 0.02, so a
  // contrast ratio of 3 needs (L + 0.05) / (0.02 + 0.05) >= 3, i.e. L >= 0.16.
  // 3:1 is the large-text threshold and this text is 21px bold, which is large
  // text by any definition.
  //
  // Set deliberately LOW. A higher floor was tried first and moved seven of
  // the eleven presets — Rose came out a noticeably paler pink — which is a
  // redesign of the palette rather than a bug fix, and none of those seven
  // were ever hard to read. At 0.16 exactly the two that carry a PALE outline
  // move, which is exactly the two that had the white halo: Ultramarine
  // (0.073) and Violet (0.147). The other nine are untouched.
  const PARTY_CHAT_MIN_LUMA = 0.16;

  function partyChatSrgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function partyChatLuma(r, g, b) {
    return 0.2126 * partyChatSrgbToLinear(r / 255) +
           0.7152 * partyChatSrgbToLinear(g / 255) +
           0.0722 * partyChatSrgbToLinear(b / 255);
  }

  // TWO CALLERS since 1.20.1. The chat handle, whose box the floor above was
  // measured against, and the PARTY LIST name, which has no box at all and
  // sits straight on the map. The list borrows the floor as a VALUE, not as a
  // derivation: on a boxless surface it is the dark halo that carries contrast
  // against bright grass, and the lift is what stops Ultramarine and Violet
  // sinking into dark water now that the halo there is dark rather than pale.
  function partyLegibleColor(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    if (partyChatLuma(r, g, b) >= PARTY_CHAT_MIN_LUMA) return hex;
    // Walked up in small steps rather than solved for, because the luminance
    // curve is not linear in any of the three channels and a closed form would
    // be more code than the loop it replaces. Twenty steps of 5% is plenty to
    // clear the floor from the darkest preset here, and the bound means a
    // colour that somehow cannot reach it stops rather than running away.
    for (let i = 0; i < 20 && partyChatLuma(r, g, b) < PARTY_CHAT_MIN_LUMA; i++) {
      r = Math.min(255, Math.round(r + (255 - r) * 0.05));
      g = Math.min(255, Math.round(g + (255 - g) * 0.05));
      b = Math.min(255, Math.round(b + (255 - b) * 0.05));
    }
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  function partyChatShow(text, colorIdx, now, handle, name) {
    if (!party.chat) return;
    const stack = partyChatStack();
    if (!stack) return;
    const preset = partyDotPreset(colorIdx);
    const el = document.createElement('div');
    el.className = 'qolc-party-line';

    const clean = partyCleanHandle(handle);
    const who = document.createElement('span');
    who.className = 'qolc-party-who';
    // textContent throughout. A name is whatever a player typed into mope and
    // a handle arrives from a peer, so neither one ever becomes markup.
    who.textContent =
      (clean ? '@' + clean : (String(name || '').trim() || 'someone')) + ':';
    // THE HALO IS GONE as of 1.20.0, and the colour is lifted instead.
    //
    // The handle used to carry `0 0 3px <preset.line>` — the dot's own paired
    // outline, as a glow. On the map that pairing is right and necessary: a
    // dark fill on bright grass needs a light ring. In this box it is neither.
    // Two presets take a deliberately PALE outline because their fills are so
    // dark — Violet (#8b2fff on #f2e8ff) and Ultramarine (#0800ff on #cfd2ff)
    // — so those two, and only those two, rendered with a white glow smeared
    // around the letters. That is the "purple name has a white shadow" in the
    // report, and it was never going to show up for anyone on a lighter
    // preset, which is most of them.
    //
    // The glow was there to solve a real problem — #0800ff on a near-black box
    // is genuinely hard to read — so it is solved properly rather than just
    // deleted: the fill itself is lifted to a luminance floor against the box.
    // A colour that is already bright enough is left exactly as it is, so the
    // nine presets that were never the problem are unchanged.
    who.style.color = partyLegibleColor(preset.fill);
    // Plain dark drop shadow only, for edge definition against the box.
    who.style.textShadow = '0 1px 2px rgba(0,0,0,0.7)';

    const said = document.createElement('span');
    said.className = 'qolc-party-said';
    said.textContent = text;

    el.appendChild(who);
    el.appendChild(said);
    // Before the input, never after it: the input is the stack's last child so
    // that it sits nearest your head, and a message appended after it would
    // push it away from the animal.
    const anchorEl = partyChat.input && partyChat.input.parentNode === stack
      ? partyChat.input : null;
    stack.insertBefore(el, anchorEl);
    partyChat.lines.push({el, at: now});
    while (partyChat.lines.length > PARTY_CHAT_MAX_LINES) {
      const old = partyChat.lines.shift();
      try { old.el.remove(); } catch (e) {}
    }
  }

  function partyChatClear() {
    for (const line of partyChat.lines) { try { line.el.remove(); } catch (e) {} }
    partyChat.lines.length = 0;
    if (partyChat.stack) partyChat.stack.style.display = 'none';
  }

  // LIFETIME DOES NOT BELONG ON THE RENDER LOOP, which is what 1.20.0 fixes.
  //
  // partyChatTick() is called from partyTick(), which is called from the
  // wrapper around the renderer's own `render()`. That is the right place for
  // anything that has to agree with a frame — dot positions, the list — and
  // the wrong place for a countdown, because it silently assumes the game is
  // still drawing. When mope stops calling render(), and it does, every
  // message on screen freezes at whatever age it had reached and stays there
  // for ever. The report was messages lingering on the menu; the same stall
  // happens on any frame the loop is not running.
  //
  // So expiry runs on its own timer as well, which owes nothing to Pixi. The
  // per-frame call is kept — it is what makes a message vanish on the exact
  // frame it should during play — and both go through the same function, so
  // there is one rule about when a line dies rather than two.
  const PARTY_CHAT_SWEEP_MS = 500;

  setInterval(() => {
    try {
      if (!partyChat.lines.length && !partyChat.open) return;
      partyChatTick(performance.now());
    } catch (e) { /* a stalled sweep must never break the timer */ }
  }, PARTY_CHAT_SWEEP_MS);

  // CSS owns the stack's coordinates. The per-frame path only handles lifetime
  // and focus; it never reads or writes position, size, Pixi bounds or zoom.
  function partyChatTick(now) {
    // Before anything that can return early: the party has to be told we have
    // gone quiet whether or not there is a stack to draw into.
    partyFocusNoticeTick();
    // Leaving the game closes the input rather than leaving it floating over
    // the menu with focus.
    if (partyChat.open && !inGame()) partyChatCloseInput();
    // If mope's own chat box turns up while ours is open, only one of them has
    // focus and the player cannot tell which. Ours stands down rather than
    // leaving two boxes up and letting a party message be typed into neither.
    if (partyChat.open && document.getElementById('chatInput')) partyChatCloseInput();
    // Expired first, so the visibility decision below counts what is really
    // left rather than what was there at the start of the frame.
    for (let i = partyChat.lines.length - 1; i >= 0; i--) {
      if (now - partyChat.lines[i].at <= PARTY_CHAT_LIFE_MS) continue;
      try { partyChat.lines[i].el.remove(); } catch (e) {}
      partyChat.lines.splice(i, 1);
    }
    const stack = partyChat.stack;
    if (!stack) return;
    // Focus mode. Checked here rather than folded into partyChatOn(), because
    // that one is about the hotkeys and this one is about the pixels: messages
    // keep arriving and keep counting down behind the duel, they are simply
    // not drawn over it.
    if (arenaFocusHiding()) {
      if (stack.style.display !== 'none') stack.style.display = 'none';
      return;
    }
    // The stack carries the input as well as the messages, so it has to stay
    // up while you are typing even with nothing said yet.
    if (!partyChat.lines.length && !partyChat.open) {
      if (stack.style.display !== 'none') stack.style.display = 'none';
      return;
    }
    if (stack.style.display !== 'flex') stack.style.display = 'flex';
    // The game can take focus back — clicking the canvas to steer does it — and
    // then keystrokes go to the game instead of the box that is plainly open in
    // front of the player. Held here rather than only set once on open.
    if (partyChat.open) partyChatFocus();
  }

  /* ----- typing one ----- */

  function partyChatCloseInput() {
    partyChat.open = false;
    if (partyChat.input) partyChat.input.style.display = 'none';
    if (partyChat.field) partyChat.field.value = '';
    try {
      const active = document.activeElement;
      if (active && active === partyChat.field) active.blur();
    } catch (e) {}
  }

  function partyChatOpenInput() {
    if (!partyChatOn() || !partyChat.mode) return;
    // Lives in the message stack so it shares the exact fixed anchor used by
    // the bubbles and always opens where the resulting message will appear.
    const host = partyChatStack();
    if (!host) return;
    if (!partyChat.input) {
      partyChat.input = document.createElement('div');
      partyChat.input.id = 'qolc-party-input';
      partyChat.field = document.createElement('input');
      partyChat.field.type = 'text';
      partyChat.field.maxLength = PARTY_CHAT_MAX;
      partyChat.field.spellcheck = false;
      // Matched to mope's own box on request, so there is no longer a written
      // label saying which channel this is — the pink border carries that on
      // its own, backed by the channel message shown on every switch.
      partyChat.field.placeholder = 'Chat here...';
      partyChat.field.setAttribute('aria-label', 'Party chat message');
      // Keys are handled by the document-level capture listeners further down
      // rather than here. A listener on the field itself runs in the target
      // phase, by which point anything mope registered at CAPTURE has already
      // seen the keystroke — which would have you walking around the map while
      // typing.
      partyChat.input.appendChild(partyChat.field);
    }
    // Re-parented rather than rebuilt, so a stack that was torn down and made
    // again keeps the same field — and the input always ends up LAST, nearest
    // the animal, with anything already said stacked above it.
    if (partyChat.input.parentNode !== host) host.appendChild(partyChat.input);
    partyChat.open = true;
    partyChat.input.style.display = 'flex';
    partyChat.field.value = '';
    // Shown here rather than waiting for the per-frame tick to do it. focus()
    // is a no-op on an element inside a display:none subtree, and the stack is
    // hidden until the tick runs — so on every frame where the tick had not
    // caught up yet, the box opened with no caret in it and the player had to
    // click it before they could type.
    host.style.display = 'flex';
    partyChatFocus();
  }

  function partyChatFocus() {
    if (!partyChat.open || !partyChat.field) return;
    if (document.activeElement === partyChat.field) return;
    // preventScroll matters: the field sits in a fixed overlay, and without it
    // the browser scrolls the page trying to bring it into view.
    try { partyChat.field.focus({preventScroll: true}); }
    catch (e) { try { partyChat.field.focus(); } catch (e2) {} }
  }

  // ----- the focus-mode notice -----
  //
  // 1.0.2. Focus mode blanks the party while you are in a 1v1: messages still
  // arrive and still expire, they are simply not drawn over the duel. From the
  // other side of the party that is indistinguishable from being ignored, so
  // this says it out loud, once, when the duel starts.
  //
  // It deliberately does NOT go through partyChatSend(). That one refuses to
  // send while partyChatOn() is false, and partyChatOn() is false during a
  // duel for exactly the reason we are announcing — the one moment this has to
  // work is the one moment that gate is shut. It also skips partyChatShow():
  // the sender cannot see their own chat right now, and a line sitting in the
  // buffer to surface when the duel ends would be a stale announcement about a
  // state that had already passed.
  //
  // The NOTIFICATION: prefix is plain text in an ordinary chat message rather
  // than a new wire field, so members on older builds read it as written
  // instead of dropping a message kind they do not know about.
  const PARTY_FOCUS_NOTICE_MS = 30000;   // floor between two notices
  let partyFocusNoticeAt = 0;

  function partyChatNotify(text) {
    if (!partyActive() || !party.chat) return false;
    if (!party.transport || !party.transport.isReady()) return false;
    const now = performance.now();
    // A second floor under the once-per-duel latch. Arena hopping is a normal
    // way to play, and somebody who takes six duels in a minute should not
    // spend that minute announcing it to everyone.
    if (partyFocusNoticeAt && now - partyFocusNoticeAt < PARTY_FOCUS_NOTICE_MS) {
      return false;
    }
    partyFocusNoticeAt = now;
    const message = {i: party.id, c: party.color, n: partySelfName(),
                     m: String(text).slice(0, PARTY_CHAT_MAX)};
    const handle = partySelfHandle();
    if (handle) message.g = handle;
    partySeal(message)
      .then((bytes) => { if (party.transport) party.transport.publish(bytes); })
      .catch(() => {});
    return true;
  }

  // Called every frame from partyChatTick. The latch is what makes this once
  // per duel rather than once per frame; clearing it on the way out is what
  // makes the NEXT duel announce again.
  function partyFocusNoticeTick() {
    const hiding = arenaFocusHiding();
    if (!hiding) { partyChat.focusTold = false; return; }
    if (partyChat.focusTold) return;
    // Latched whether or not the send succeeds. A duel that started while the
    // relay was down is not worth announcing thirty seconds late, by which
    // time it may well be over.
    partyChat.focusTold = true;
    const who = partySelfName() || 'A party member';
    partyChatNotify('NOTIFICATION: ' + who +
      ' is in a 1v1 and cannot see party chat until it ends.');
  }

  function partyChatSend(raw) {
    const text = String(raw || '').trim().slice(0, PARTY_CHAT_MAX);
    if (!text) return;
    if (!partyChatOn()) { partyChatToast('Party chat is switched off', true); return; }
    if (!party.transport || !party.transport.isReady()) {
      // Said out loud rather than dropped silently. QoS 0 is fire-and-forget,
      // so a message sent while disconnected simply never existed, and the
      // player has no other way to find that out.
      partyChatToast('Party chat: not connected to the relay', true);
      return;
    }
    // Both are carried on the message rather than left to the roster, because
    // a chat message can be the FIRST thing a member ever sends — a position
    // needs the minimap found and this does not.
    const handle = partySelfHandle();
    const name = partySelfName();
    // Shown locally at once rather than waiting for the broker to echo it
    // back: it makes sending feel immediate, and this is the one message we
    // know for certain was sent.
    partyChatShow(text, party.color, performance.now(), handle, name);
    const message = {i: party.id, c: party.color, m: text, n: name};
    if (handle) message.g = handle;
    partySeal(message)
      .then((bytes) => { if (party.transport) party.transport.publish(bytes); })
      .catch(() => {});
  }

  /* ----- the party list, under the leaderboard ----- */

  // Four times a second. Nothing on the list changes faster than a peer
  // publishes (10 Hz at the very most, and usually far less), and everything
  // here reads layout — a rectangle and a computed style — which is the kind
  // of work that does not belong on a frame.
  const PARTY_LIST_MIN_MS = 250;
  // Gap between the leaderboard's box and the first row, and the row gap
  // inside the list. Both in dvmin, which is the unit mope sizes that box in,
  // so the list keeps its proportions on every screen and at every zoom.
  const PARTY_LIST_GAP_DVMIN = 0.9;

  function partyListOn() {
    return partyActive() && party.list && !arenaFocusHiding();
  }

  function partyListLayer() {
    let layer = party.listLayer;
    if (layer && layer.isConnected) return layer;
    const host = document.body || document.documentElement;
    if (!host) return null;
    layer = document.createElement('div');
    layer.id = 'qolc-party-list';
    host.appendChild(layer);
    party.listLayer = layer;
    // The old rows went with the old layer, so the map that remembers them has
    // to go too or every row would be rebuilt as an orphan on the next pass —
    // and the remembered ORDER with it, since a fresh layer holds no rows in
    // any order at all.
    party.listRows.clear();
    party.listOrder = '';
    return layer;
  }

  function partyListHide() {
    const layer = party.listLayer;
    if (layer && layer.style.display !== 'none') layer.style.display = 'none';
  }

  // mope's leaderboard is one of the few parts of the game that is real DOM
  // with a real id — `#leaderboard`, a .HUDBox holding `#serverName` and
  // `#leaderboardContent`. Its rectangle is measured rather than its position
  // assumed, so the list follows it wherever the HUD puts it, including the
  // 1.35 zoom mope applies on mobile.
  //
  // The padding is read as well as the rectangle: the box insets its own text
  // by 1.75dvmin, so aligning to the box's edge would leave the list a visible
  // step to the left of the names above it.
  //
  // Where the list hangs, and — since 1.22.0 — what mope's own box looks like.
  //
  // The box is COPIED FROM `#leaderboard` at runtime rather than written as a
  // constant. mope's `.HUDBox` is its own design and it is not ours to guess
  // at: a hardcoded colour would be a near-miss the day it was written and a
  // visible mismatch the first time mope retunes its HUD. Reading the computed
  // style means the box is mope's box by construction, in whatever theme or
  // future build the player is on.
  //
  // getComputedStyle forces layout, so it is read here and nowhere else — this
  // function already ran once per list tick (250ms) for the padding.
  function partyListAnchor() {
    const el = document.getElementById('leaderboard');
    if (!el || !el.isConnected) return null;
    const rect = el.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return null;
    let padLeft = 0, padRight = 0, box = null;
    try {
      const style = getComputedStyle(el);
      // The BORDER counts as well as the padding, and it was missed until
      // 1.22.0: getBoundingClientRect() includes the border, so a box with a
      // 2px one put the unboxed list 2px left of the names it is supposed to
      // sit under. Measured against the leaderboard's own text: -2px before,
      // 0px after. Invisible on its own and worth fixing while the boxed path
      // — which lands on 0 by construction — is being added beside it.
      padLeft = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.borderLeftWidth) || 0);
      padRight = (parseFloat(style.paddingRight) || 0) + (parseFloat(style.borderRightWidth) || 0);
      box = {
        background: style.backgroundColor,
        radius: style.borderRadius,
        shadow: style.boxShadow,
        border: style.borderTopWidth + ' ' + style.borderTopStyle + ' ' + style.borderTopColor,
        padTop: style.paddingTop,
        padRight: style.paddingRight,
        padBottom: style.paddingBottom,
        padLeft: style.paddingLeft,
      };
    } catch (e) { /* fall back to the raw box */ }
    return {
      // Unboxed, the list aligns to the leaderboard's TEXT column, so the
      // names sit under the names above them. Boxed, our own padding does that
      // job, so the box aligns to the leaderboard's box and the text lands in
      // the same column either way. Both are reported and the tick chooses.
      left: rect.left + padLeft,
      top: rect.bottom,
      width: Math.max(0, rect.width - padLeft - padRight),
      boxLeft: rect.left,
      boxWidth: rect.width,
      box,
    };
  }

  // Wear mope's box, or take it off again. `box` is null for "no box".
  //
  // Written as inline styles rather than a class because the VALUES come from
  // mope at runtime — a class could toggle the box on and off but could not
  // carry a colour that is only known once #leaderboard exists. Every property
  // is compared before it is written: this runs four times a second, and
  // assigning a style property that already holds that value still dirties
  // style and can force layout.
  //
  // The last-applied signature is kept on the node itself, so a rebuilt layer
  // starts with no box and gets one on the next pass rather than inheriting a
  // stale one.
  function partyListApplyBox(layer, box) {
    const sig = box
      ? box.background + '|' + box.radius + '|' + box.shadow + '|' + box.border +
        '|' + box.padTop + '|' + box.padRight + '|' + box.padBottom + '|' + box.padLeft
      : '';
    if (layer.__lumiBoxSig === sig) return;
    layer.__lumiBoxSig = sig;
    const s = layer.style;
    if (!box) {
      s.background = '';
      s.borderRadius = '';
      s.boxShadow = '';
      s.border = '';
      s.padding = '';
      return;
    }
    s.background = box.background;
    s.borderRadius = box.radius;
    s.boxShadow = box.shadow;
    s.border = box.border;
    s.padding = box.padTop + ' ' + box.padRight + ' ' + box.padBottom + ' ' + box.padLeft;
  }

  function partyListRow(layer, key) {
    let row = party.listRows.get(key);
    if (row && row.el.isConnected) return row;
    const el = document.createElement('div');
    el.className = 'qolc-pl-row';

    const art = document.createElement('img');
    art.className = 'qolc-pl-art';
    art.alt = '';
    art.decoding = 'async';
    // A rare folder that does not exist is a 404, and mope's catch-all answers
    // those with the index page rather than an error — so the browser gets
    // HTML where it wanted an image and fires this. Hidden rather than
    // removed: the row keeps its shape instead of shuffling left, and a later
    // animal that does load simply shows up again.
    art.addEventListener('error', () => { art.style.visibility = 'hidden'; });
    art.addEventListener('load', () => { art.style.visibility = ''; });

    // 1.22.0 — TWO LINES ("concept 4"). Name and health on the first, handle
    // and XP on a quieter second.
    //
    // Everything before this tried to fit four things across one column and
    // lost: 1.21.0 put the numbers side by side, 1.21.1 stacked them into one
    // column to win width back, and both still produced a row where the name
    // AND the handle were cut ("lui…" beside "@luminosi…"). The column is
    // simply not wide enough for four things, and the widest of them — the XP
    // pair — was setting the width the name had to pay for.
    //
    // Taking a second line ends the competition instead of rebalancing it.
    // Each line now carries one label and one number, the name gets the whole
    // width of its own line, and nothing truncates at ordinary name lengths.
    // The cost is height, and it is affordable: the row was already as tall as
    // the 2.1em animal picture, so two tight lines very nearly fit inside the
    // height the row had anyway.
    //
    // The handle no longer needs `flex-shrink: 20`. That existed to make it
    // collapse before the name when they shared a line; on its own line with
    // only XP beside it, ordinary ellipsis is enough.
    const col = document.createElement('div');
    col.className = 'qolc-pl-col';
    const line1 = document.createElement('div');
    line1.className = 'qolc-pl-l1';
    const line2 = document.createElement('div');
    line2.className = 'qolc-pl-l2';

    const name = document.createElement('span');
    name.className = 'qolc-pl-name';
    const hp = document.createElement('span');
    hp.className = 'qolc-pl-hp';
    const handle = document.createElement('span');
    handle.className = 'qolc-pl-handle';
    const xp = document.createElement('span');
    xp.className = 'qolc-pl-xp';

    line1.appendChild(name);
    line1.appendChild(hp);
    line2.appendChild(handle);
    line2.appendChild(xp);
    col.appendChild(line1);
    col.appendChild(line2);

    el.appendChild(art);
    el.appendChild(col);
    layer.appendChild(el);

    // The last-written value of everything that can change is kept beside the
    // node. Writing a property that already holds that value still dirties
    // style and can force layout, and this runs four times a second for every
    // member — so nothing is written twice.
    row = {el, art, name, handle, xp, hp,
           shown: {src: '', name: '', handle: '', hp: '', xp: '', colour: '', stale: null}};
    party.listRows.set(key, row);
    return row;
  }

  function partyListPaint(row, member) {
    const shown = row.shown;
    const src = partyArtUrl(member.art);
    if (shown.src !== src) {
      shown.src = src;
      if (src) {
        row.art.style.display = '';
        row.art.style.visibility = '';
        row.art.src = src;
      } else {
        // No animal known yet — a member who has connected but not spawned, or
        // one on a build that does not send it. The space is kept so the names
        // beside it still line up.
        row.art.removeAttribute('src');
        row.art.style.visibility = 'hidden';
      }
    }

    // 1.29.0. "(1v1)" after the name of anybody currently in an arena.
    //
    // Appended to the NAME rather than given a column of its own, deliberately.
    // The row is two lines with four things on it already and the column was
    // never wide enough for four — that is what 1.22.0's rebuild was about, and
    // a fifth field would undo it. As part of the name it also ellipsises with
    // the name instead of pushing the health figure off the row.
    //
    // Cached against the composed string, not against member.name, or the tag
    // would appear and never come off.
    const label = member.name + (member.duel ? ' (1v1)' : '');
    if (shown.name !== label) {
      shown.name = label;
      row.name.textContent = label;
    }
    const colour = partyLegibleColor(partyDotPreset(member.color).fill);
    if (shown.colour !== colour) {
      shown.colour = colour;
      // The name takes the member's dot colour so a row and a dot on the map
      // are obviously the same person.
      //
      // It used to take the dot's PAIRED OUTLINE with it, as a halo. That is
      // the second site of the bug 1.20.0 fixed in chat, and it was missed
      // there: Violet and Ultramarine carry a deliberately PALE outline —
      // right on the map, where a dark fill on bright grass needs a light ring
      // — so exactly those two, and no others, came out smeared in white.
      //
      // The chat fix does not transfer as written. Chat DELETED its halo,
      // which it can afford because it draws on a dark box. This list has no
      // box by design; it sits straight on the map, so it needs a halo and
      // that halo has to be DARK. Which is what the list container already
      // sets for every other cell in the row — so the name simply stops
      // overriding it and inherits the same treatment as the handle and the
      // percentage beside it, one source of truth instead of two.
      //
      // The lift comes across from chat unchanged. A dark halo does nothing
      // for a near-black fill on dark water, which is the case the pale ring
      // was there to cover, so removing the ring without it would trade a
      // white smear for an unreadable name. It moves the same two presets.
      row.name.style.color = colour;
      row.name.style.textShadow = '';
    }

    const handle = member.handle ? '@' + member.handle : '';
    if (shown.handle !== handle) {
      shown.handle = handle;
      row.handle.textContent = handle;
      row.handle.style.display = handle ? '' : 'none';
    }

    // XP, 1.21.0. Rendered with spaces around the slash where the wire format
    // has none: "2.03M / 5M" is mope's own presentation, and the compact form
    // exists to keep the message small rather than to be read.
    //
    // Blank rather than an em-dash when it is not known. The percentage uses a
    // dash because "this member's health is unreadable" is worth saying — a
    // member with no health showing is a member you cannot look after. An
    // unknown XP figure is not news, and a column of dashes for every peer on
    // an older build would be noise in the busiest part of the row.
    const xp = member.xp ? member.xp.replace('/', ' / ') : '';
    if (shown.xp !== xp) {
      shown.xp = xp;
      row.xp.textContent = xp;
    }

    // Percent, always, for every member. See the header note on why this is
    // not the figure the HP bar shows you about yourself.
    const hp = member.hp >= 0 ? member.hp + '%' : '—';
    if (shown.hp !== hp) {
      shown.hp = hp;
      row.hp.textContent = hp;
      row.hp.style.color = member.hp >= 0
        ? hpBarColour(member.hp / 100) : 'rgba(255,255,255,0.55)';
    }

    if (shown.stale !== member.stale) {
      shown.stale = member.stale;
      row.el.classList.toggle('is-stale', member.stale);
    }
  }

  // Who is on the list, in order: the OTHER members, and never you.
  //
  // 1.16.0 put you on it first, on the reasoning that a party list ought to
  // include the whole party. In a real game it does not read that way — the
  // game already tells you your own health, your own animal is in the middle
  // of the screen, and the row was a line of the leaderboard's width spent
  // saying nothing you could not already see. What the list is FOR is the
  // members you cannot see, so that is all it holds.
  //
  // Your own health and animal still go out on every publish. They are what
  // fill in your row on everybody else's list, and nothing about not drawing
  // it here changes that.
  function partyListMembers(now) {
    const members = [];
    // 1.22.0. Your own row, when the sub-option asks for it. Off by default:
    // leaving yourself off was a deliberate 1.16.1 decision, and it is still
    // the better default — you already know your own health, and mope draws
    // your XP bar for you. This exists because players asked for it anyway,
    // and the reason they gave is a fair one: a party list that shows everyone
    // BUT you reads as a list with a hole in it.
    //
    // PINNED FIRST rather than sorted in among the names. The rest of the list
    // is alphabetical, so sorting yourself into it would move your own row
    // whenever somebody joined, left or renamed — and the one row you look for
    // by position is your own. First is also stable, which matters because the
    // key ORDER is what decides whether every node gets re-hung.
    //
    // Everything is read the same way it would be PUBLISHED, so your row and
    // the row your party sees for you cannot disagree. Health is gated on
    // partyNeedsSelfHealth() for that reason: outside a game it is -1 here
    // exactly as it would be -1 on the wire.
    if (party.listSelf) {
      members.push({
        key: 'self',
        name: partySelfName(),
        handle: partySelfHandle() || '',
        color: party.color,
        hp: partyNeedsSelfHealth() ? partySelfHealth() : -1,
        // Never stale: staleness means "we have not heard from them", and you
        // are not something this client has to hear from.
        stale: false,
        art: partySelfArtKey() || '',
        xp: partyNeedsSelfHealth() ? partySelfXp() : '',
        // Read the same way it is published, like everything else on this row.
        duel: arenaDuel.active,
        self: true,
      });
    }
    const peers = [...party.peers.values()]
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    for (const peer of peers) {
      members.push({
        key: 'p:' + peer.id,
        name: peer.name || '(unnamed)',
        handle: peer.handle || '',
        color: peer.color,
        hp: typeof peer.hp === 'number' ? peer.hp : -1,
        // Dimmed on the same timer that dims their dot, so the two agree about
        // who has gone quiet.
        stale: now - peer.at > PARTY_STALE_MS,
        art: peer.art || '',
        xp: peer.xp || '',
        duel: peer.duel === true,
      });
    }
    return members;
  }

  function partyListTick(now) {
    // The DOM timer can run without partyTick: departed peers must still
    // expire while renderer capture is pending.
    for (const [id, peer] of party.peers) {
      if (now - peer.at > PARTY_DROP_MS) {
        partyDestroyPeer(peer);
        party.peers.delete(id);
      }
    }
    // Hidden outside a game, and hidden while nobody else is in the party —
    // which since 1.16.1 is the same thing as the list being empty, because
    // you are not on it. The panel is where "is this connected?" is answered.
    // A party of one now has something to show, but only when your own row is
    // switched on. With it off this is still "nobody else is here", which is
    // what 1.16.0 meant by an empty list.
    if (!partyListOn() || !inGame() || document.hidden ||
        (!party.peers.size && !party.listSelf)) {
      partyListHide();
      return;
    }
    if (now - party.listAt < PARTY_LIST_MIN_MS) return;
    party.listAt = now;

    const anchor = partyListAnchor();
    // No leaderboard means no anchor, and a list floating where the
    // leaderboard would have been is worse than no list. This is also what
    // happens when the clutter settings hide the HUD, which is the right
    // outcome for those too.
    if (!anchor) { partyListHide(); return; }
    const layer = partyListLayer();
    if (!layer) return;

    const vmin = layoutVmin();
    const gap = Math.round(PARTY_LIST_GAP_DVMIN * vmin);
    // 1.22.0. Boxed, the list wears mope's own HUDBox and aligns box-to-box, so
    // its padding puts the text in the same column the unboxed list sits in.
    const boxed = !!(party.listBox && anchor.box);
    // The width, the box and the display mode are decided here — they are
    // what the list IS — and read off #leaderboard, which is also where it is
    // placed. Hiding the HUD with the clutter settings takes the list with it.
    const width = Math.round(boxed ? anchor.boxWidth : anchor.width) + 'px';
    layoutStyle(layer, 'width', width);
    layoutStyle(layer, 'display', 'flex');
    partyListApplyBox(layer, boxed ? anchor.box : null);
    layoutPlace(layer, {
      left: Math.round(boxed ? anchor.boxLeft : anchor.left),
      top: Math.round(anchor.top + gap),
    });

    const members = partyListMembers(now);
    const live = new Set();
    for (const member of members) {
      live.add(member.key);
      partyListPaint(partyListRow(layer, member.key), member);
    }
    for (const [key, row] of party.listRows) {
      if (live.has(key)) continue;
      try { row.el.remove(); } catch (e) {}
      party.listRows.delete(key);
    }

    // Rows are only re-hung when the ORDER actually changes — a member joining,
    // leaving, or renaming past a neighbour. Appending each row in turn every
    // pass would sort them correctly too, and would move every node in the
    // list four times a second to achieve nothing.
    const order = members.map((m) => m.key).join('|');
    if (party.listOrder !== order) {
      party.listOrder = order;
      for (const member of members) {
        const row = party.listRows.get(member.key);
        if (row) layer.appendChild(row.el);
      }
    }
  }

  /* ----- the per-frame tick ----- */

  function partyTick(now) {
    // Its own try/catch. hookRenderer runs every per-frame feature inside ONE
    // try block, so without this a throw upstream (HP scan, name sweep) would
    // silently take the party map down with it, and a throw in here would take
    // them down instead — with no error either way, since that catch is silent.
    try {
      if (!partyActive()) {
        partyHideAll(); partyChatClear(); partyListHide(); return;
      }

      // Chat lifetime and focus are handled before anything else and do not
      // depend on the minimap being found. A frame where the minimap cannot be
      // located must not swallow what somebody said.
      partyChatTick(now);
      // Nor is the list allowed to depend on it. The minimap is what the dots
      // need, and the list is under the leaderboard — a frame that cannot find
      // one has no business taking the other off screen. Its own throttle is
      // inside it.
      partyListTick(now);

      // The minimap is only needed to DRAW the others. Your own position comes
      // from your animal, so you keep publishing even on a frame with no
      // minimap on screen (a culled duel hides it).
      const parts = partyReadParts();
      party.minimapSeen = !!parts;

      // Publish our own position, and — since 1.16.0 — the animal and health
      // that ride with it. Both are read before the pacer is asked, because
      // the stamp is what tells it a still player has something new to say.
      const self = inGame() ? partySelfPosition(parts) : null;
      const health = partyNeedsSelfHealth() ? partySelfHealth() : -1;
      const art = partyNeedsSelfHealth() ? partySelfArtKey() : '';
      // 1.21.0. Read beside health and the animal, and gated on the same
      // question, so a member publishes all three or none of them.
      const xp = partyNeedsSelfHealth() ? partySelfXp() : '';
      // XP IS DELIBERATELY NOT IN THE STAMP BELOW, and this is the whole design
      // decision in the feature. The stamp is what tells the pacer that a
      // player who has not MOVED still has something worth saying, and it is
      // floored at 100ms rather than at the 2s heartbeat. Health earns that:
      // it changes in a fight, in steps, and seconds of staleness during one is
      // the difference between a useful list and a decorative one.
      //
      // XP does not. It ticks up continuously the entire time you are eating,
      // which is most of a game — so folding it in turns every grinding member
      // from one message every two seconds into ten a second, permanently.
      // That is twenty times the traffic, per member, on public brokers shared
      // with strangers, to animate a figure nobody reads frame by frame. It
      // rides the messages health and movement were already sending, and on a
      // standing, unharmed player it updates on the heartbeat. That is the
      // right resolution for it.
      // 1.29.0. Duelling joins the pacer's change key alongside health and the
      // animal. It has to: entering an arena often does not move you far and
      // may not change your health at all, and without this the "(1v1)" tag
      // would wait for the two-second heartbeat to appear and to go away.
      const duelling = arenaDuel.active;
      if (self && party.transport && party.transport.isReady() && party.pacer &&
          party.pacer.should(now, self.u, self.v,
                             health + '|' + art + '|' + (duelling ? 1 : 0))) {
        const message = {i: party.id, n: partySelfName(),
                         u: self.u, v: self.v, c: party.color};
        if (duelling) message.d = true;
        // Sent on every position rather than announced once: the broker holds
        // nothing for us, so a member who joins later has no way to learn an
        // announcement they were not there for. Riding on a message everyone
        // already sends costs one small number and means the roster is always
        // enough on its own to work out who is leading.
        if (party.joinedAt > 0) message.j = party.joinedAt;
        // Left out entirely rather than sent as a placeholder, so a member on
        // an older build and a member whose health is not readable yet look
        // the same on the wire — which is what they are.
        const handle = partySelfHandle();
        if (handle) message.g = handle;
        if (health >= 0) message.h = health;
        if (art) message.a = art;
        if (xp) message.x = xp;
        partySeal(message)
          .then((bytes) => { if (party.transport) party.transport.publish(bytes); })
          .catch(() => {});
      }

      // Nothing else to do in a party of one, which is the common case — bail
      // before touching the DOM or the layout engine.
      if (!party.peers.size) return;
      // Only while mope is actually showing its minimap: not on the death
      // screen, the menu, or a culled duel, where a DOM name tag would be left
      // floating over nothing.
      if (!parts || !inGame() || !nodeShown(parts.container)) { partyHideAll(); return; }
      const container = parts.container;

      // One shared canvas measurement for DOM name tags. v1.8.0 accidentally
      // removed this value while partyPlaceTag still consumed it; evaluating
      // the missing identifier aborted the loop after its first circle.
      // Focus mode hides dots and tags together. Read once, above the loop:
      // it cannot change between two peers of the same frame, and the tag
      // measurement below is worth skipping entirely rather than doing and
      // throwing away.
      const focusHiding = arenaFocusHiding();
      const screen = (party.tags && !focusHiding) ? canvasRect(now) : null;

      // Draw everyone else.
      for (const [id, peer] of party.peers) {
        const age = now - peer.at;
        if (age > PARTY_DROP_MS) { partyDestroyPeer(peer); party.peers.delete(id); continue; }
        if (!party.dots || focusHiding) {
          if (peer.node) peer.node.visible = false;
          if (peer.tag) peer.tag.style.display = 'none';
          continue;
        }
        // A dot whose minimap was rebuilt (new server, new game) is gone with
        // it: Pixi nulls a destroyed node's position, so it is dropped and
        // drawn again here rather than read.
        if (peer.node && (peer.node.destroyed || peer.node.parent !== container)) {
          partyDestroyPeer(peer);
        }
        if (!peer.node) peer.node = partyMakeDot(container, parts, peer.color);
        if (!peer.node) continue;
        partyPaintDot(peer.node, peer.color);
        const local = partyProjectPeer(parts, peer.u, peer.v);
        if (peer.node.visible !== true) peer.node.visible = true;
        if (peer.node.position.x !== local.x) peer.node.position.x = local.x;
        if (peer.node.position.y !== local.y) peer.node.position.y = local.y;
        // Dimmed rather than dropped, so a peer that lags briefly does not
        // flicker in and out of the map.
        const alpha = age > PARTY_STALE_MS ? 0.35 : 1;
        if (peer.node.alpha !== alpha) peer.node.alpha = alpha;
        // A DOM-label failure must never stop later Pixi circles from drawing.
        try { partyPlaceTag(peer, container, local, screen); }
        catch (e) {
          if (peer.tag) peer.tag.style.display = 'none';
          dbg('party: name tag failed —', e);
        }
      }
    } catch (e) {
      dbg('party: tick failed —', e);
    }
  }

  /* ----- diagnostic ----- */

  function partyDebug() {
    const parts = partyReadParts();
    const self = partySelfPosition(parts);
    const report = {
      version: VERSION,
      masterEnabled: settings.masterEnabled,
      featureEnabled: party.enabled,
      leader: (() => {
        const id = partyLeaderId();
        if (!id) return 'nobody eligible (no join times seen yet)';
        if (id === party.id) return 'you (joined ' + new Date(party.joinedAt).toISOString() + ')';
        const p = party.peers.get(id);
        return (p && p.name ? p.name : id) + ' (joined ' +
          (p && p.joinedAt ? new Date(p.joinedAt).toISOString() : '?') + ')';
      })(),
      focusNoticeSent: partyChat.focusTold,
      codeSet: !!partyNormalizeCode(party.code),
      relay: PARTY_BROKERS[party.broker][0] +
        (party.pin >= 0 ? ' (pinned)' : ' (auto — can change on a dropped connection)'),
      dotColor: partyDotPreset(party.color).name + ' (' + party.color + ')',
      list: !party.list ? 'off in the panel'
        : !inGame() ? 'on — hidden, not in a game'
        : !document.getElementById('leaderboard') ? 'on — no #leaderboard to sit under'
        : !partyListAnchor() ? 'on — #leaderboard measures 0x0, nothing to anchor to'
        : !party.peers.size ? 'on — hidden, nobody else in the party yet'
        : 'on — ' + party.peers.size + ' row(s)',
      handle: (function () {
        const found = partySelfHandle();
        if (!found) return '(none — chat falls back to your in-game name)';
        return '@' + found + ' (from ' +
          (partyCleanHandle(party.handle) ? 'the panel override'
            : partyHandle.cache ? 'localStorage ' + PARTY_AUTH_CACHE_KEY
            : 'GET /users/me') + ')';
      })(),
      selfHealth: partyNeedsSelfHealth()
        ? (partySelfHealth() >= 0 ? partySelfHealth() + '% (mope\'s own $.player.target.health)'
           : 'not readable — mope has no animal for you right now')
        : 'not sent — ' + (partyActive() ? 'not in a game' : 'party is off'),
      selfAnimal: partySelfArtKey() || '(no animal)',
      selfAnimalArt: partyArtUrl(partySelfArtKey()) || '(none)',
      selfXp: partySelfXp() || '(no animal)',
      chat: !party.chat ? 'off'
        : (partyChat.mode ? 'PARTY channel' : 'public channel') +
          (partyChat.open ? ', typing' : '') +
          ', ' + partyChat.lines.length + ' line(s) up',
      chatHotkeys: document.getElementById('chatInput') ? 'stood down — mope chat is open'
        : !inGame() ? 'stood down — not in a game'
        : party.chat ? 'live (P switches channel)' : 'off in the panel',
      status: party.status + (party.statusInfo ? ' — ' + party.statusInfo : ''),
      transportReady: !!(party.transport && party.transport.isReady()),
      topicTail: party.topic ? '…' + party.topic.slice(-8) : '(none)',
      peersKnown: party.peers.size,
      minimap: parts ? 'mope\'s $.minimap, sprite width ' + parts.spriteW
        : 'none on screen (menu, or a culled duel)',
      selfU: self ? self.u : '(n/a)',
      selfV: self ? self.v : '(n/a)',
    };
    console.table ? console.table(report) : console.log(report);
    if (party.peers.size) {
      const heardAt = performance.now();
      const rows = [];
      for (const peer of party.peers.values()) {
        rows.push({
          name: peer.name || '(unnamed)',
          handle: peer.handle ? '@' + peer.handle : '(none)',
          health: peer.hp >= 0 ? peer.hp + '%' : '(not sent)',
          animal: peer.art || '(not sent)',
          dotColor: partyDotPreset(peer.color).name,
          lastHeard: Math.round(heardAt - peer.at) + 'ms ago',
        });
      }
      console.table ? console.table(rows) : console.log(rows);
    }
    console.log(TAG, 'party: if a party will not form, compare these two with ' +
      'the other player — relay "' + PARTY_BROKERS[party.broker][0] +
      '" and topicTail "' + (party.topic ? '…' + party.topic.slice(-8) : '(none)') +
      '". Different relays means you are on separate servers and can never see ' +
      'each other; pick the same one under Relay. Different topic tails means ' +
      'the party codes are not actually identical.');
    return report;
  }
  expose('__lumiPartyDebug', partyDebug);

  /* ----- keyboard ----- */

  function partyChatOwnsEvent(e) {
    return !!(partyChat.field && e.target === partyChat.field);
  }

  function partyChatTypingElsewhere() {
    const active = document.activeElement;
    if (!active || active === partyChat.field) return false;
    return active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' ||
      active.tagName === 'SELECT' || active.isContentEditable === true;
  }

  // Keys taken on keydown, so their keyup can be taken too — see below.
  const partyChatSwallow = new Set();

  // Registered on the WINDOW at capture, at document-start.
  //
  // The window part is not a detail, it is the whole fix for 1.7.2. These were
  // on `document` in 1.7.0/1.7.1, and the capture phase visits window BEFORE
  // document — so in a real game mope's own Enter handler ran first, opened its
  // PUBLIC chat box, and by the time this ran the "is mope's chat already
  // open?" guard below saw that very box and stood down. The outcome was the
  // worst one available: Enter opened public chat and the message went to
  // everybody. Nothing sits above the window, and registering at document-start
  // puts this ahead of anything mope later installs on the window itself.
  //
  // It survived testing because a test page only ever had document-level
  // listeners to model the game with, which is precisely the arrangement that
  // cannot reproduce it.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    PAGE.addEventListener(type, (e) => {
      // 1. While the party input has focus, the game must not see a single
      // keystroke. mope reads movement off its own key handlers and has no
      // idea this field exists, so without this, typing "sad" walks you south.
      // Only propagation is stopped, never the default action, or the
      // characters would not be typed.
      if (partyChatOwnsEvent(e)) {
        e.stopImmediatePropagation();
        if (type !== 'keydown') return;
        if (e.key === 'Enter') {
          e.preventDefault();
          const text = partyChat.field.value;
          partyChatCloseInput();
          partyChatSend(text);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          partyChatCloseInput();
        }
        return;
      }

      // 2. The other half of a key already taken on keydown. A handler that
      // acts on RELEASE would otherwise still see the Enter this consumed.
      // Only keyup clears the entry, since keypress arrives first.
      if (type !== 'keydown') {
        if (e.key && partyChatSwallow.has(e.key)) {
          e.stopImmediatePropagation();
          if (type === 'keyup') partyChatSwallow.delete(e.key);
        }
        return;
      }

      // 3. The channel switch, and taking Enter away from mope's chat.
      //
      // Real key presses only. Lumi's Moderator Extras opens mope's chat by
      // DISPATCHING an Enter keydown so it can submit `invisible:1` — if that
      // synthetic Enter were treated as the player asking for the party input,
      // this would swallow it and the moderator command would silently never
      // send. Both scripts share this page, so that is not hypothetical.
      if (!e.isTrusted) return;
      if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
      // mope's own chat box already being open means the player is deliberately
      // talking in PUBLIC. Nothing here may interfere with that. Reached only
      // when mope opened it on some earlier key, never on this one — which is
      // exactly what moving to the window restored.
      if (document.getElementById('chatInput')) return;
      if (partyChatTypingElsewhere()) return;
      if (!inGame()) return;

      if (kbHit('partyChat', e)) {
        // The hotkey follows the feature switch, so someone who does not want
        // P taken can turn the whole thing off in the panel.
        if (!party.chat) return;
        partyChatSwallow.add(e.key);
        e.preventDefault();
        e.stopImmediatePropagation();
        partyChatToggle();
        return;
      }

      // Enter opens OUR input rather than mope's, but ONLY while the party
      // channel is selected. In public chat it is left completely alone — that
      // is the difference between a chat feature and a chat bug.
      // Same reason as the zoom keys: while a bind is being captured this
      // handler must not swallow Enter, or Enter could never be bound.
      if (kbCapturing()) return;
      if (e.key === 'Enter' && partyChat.mode && partyChatOn() && !partyChat.open) {
        partyChatSwallow.add(e.key);
        e.preventDefault();
        e.stopImmediatePropagation();
        partyChatOpenInput();
      }
    }, true);
  }

  /* ----- lifecycle ----- */

  // Deferred rather than immediate: deriving the key runs 200k PBKDF2
  // iterations, and doing that during page start-up competes with the game's
  // own load for no benefit — nobody is on the map yet anyway.
  setTimeout(() => { if (partyActive()) partyConnect(); }, 2000);

  // Reconnect watchdog. The transport rotates to the next broker whenever one
  // fails, so retrying here is what actually walks the list rather than
  // hammering a broker that is down.
  let partyLastRetry = 0;
  setInterval(() => {
    if (!partyActive()) return;
    if (party.transport && party.transport.isReady()) return;
    const now = performance.now();
    if (now - partyLastRetry < 6000) return;
    partyLastRetry = now;
    partyConnect();
  }, 3000);

  // The roster changes every frame but only matters while it is on screen, so
  // it is rebuilt on a slow timer instead of from the render loop.
  setInterval(() => {
    if (!extras || !extras.partyUi || !extras.panel) return;
    if (extras.panel.style.display !== 'block') return;
    // 1.25.0: the party lives in two categories now, so "is the party tab up"
    // became "is either of them up".
    if (extras.current !== 'party') return;
    syncPartyUI();
  }, 750);

  // ------------------------------------------ online name-color registry
  //
  // WHY THIS EXISTS. The invisible suffix near the top of this file carries a
  // color INSIDE the nickname, and the nickname field is 24 UTF-16 units. A tag
  // costs 4 to 8 of them and decorative letters cost 2 units each, so a long
  // fancy name has nothing left to spend and its color is not shared at all.
  // That is a budget problem, not an encoding problem, and no cleverer packing
  // gets around it. The color has to travel beside the name instead.
  //
  // HOW. An MQTT broker with the RETAIN flag set is a key-value store: the
  // broker keeps the last message published to a topic and hands it to anybody
  // who subscribes afterwards, whether or not the publisher is still connected.
  // One topic per name makes that a lookup table.
  //
  //   topic    lumi/name/v1/<sha256(topic salt + nameKey), truncated>
  //   payload  AES-GCM, key = sha256(key salt + nameKey)
  //
  // THE NAME IS THE KEY, in both senses. Somebody subscribed to the broker's
  // whole firehose sees opaque topics and ciphertext; reading an entry requires
  // already knowing the name it belongs to, which anyone who can see that
  // player on screen does. That is a real property rather than obfuscation —
  // but it is only ever as strong as the name is hard to guess, so nothing here
  // is a secret. It keeps names and colors off a public broker in plaintext and
  // no more, and that is all it is claimed to do.
  //
  // LOOKUP IS SUBSCRIBE-ON-SIGHT. A name is only asked for when a sweep
  // actually meets it, so a client receives traffic for the few players on its
  // screen and none for anyone else, no matter how many people run the script.
  // There is no global topic and no roster to keep in step.
  //
  // PUBLISHING GOES TO EVERY BROKER, and so does subscribing. The three in
  // PARTY_BROKERS are unrelated servers with no bridging between them; two
  // people landing on different ones is exactly what silently split a working
  // party (see rotateBroker's note), and here there is no party code for them
  // to coordinate on in the first place. One retained publish per color change
  // is small enough that fanning out across all three costs less than the
  // coordination problem would.

  const NR_KEYS = {
    pub: 'mnc:relay:pub',   // last name published, so it can be cleared later
    id:  'mnc:relay:id',    // this install's id, for spotting rival claims
  };

  const NR_TOPIC_PREFIX = 'lumi/name/v1/';
  const NR_TOPIC_INFO   = 'lumi-name-topic-v1|';
  const NR_KEY_INFO     = 'lumi-name-key-v1|';
  const NR_IV_BYTES     = 12;
  const NR_PAYLOAD_V    = 1;
  const NR_EMPTY        = new Uint8Array(0);

  // A retained message has no expiry in MQTT 3.1.1 — the broker holds it until
  // somebody overwrites or clears it — so the stamp inside the payload is what
  // ages an entry out. Every Play republishes, so an entry only goes stale once
  // its owner has stopped playing entirely.
  const NR_MAX_AGE_MS   = 45 * 24 * 3600 * 1000;
  const NR_FUTURE_MS    = 24 * 3600 * 1000;   // clock skew allowance; see below
  // Nicknames live in a 24-unit field. Longer text is not a name, and asking
  // for it would spend a subscription slot on the scene's other writing.
  const NR_MAX_KEY_LEN  = 24;
  const NR_MAX_SUBS     = 48;    // live subscriptions; the rest are evicted
  const NR_MAX_NAMES    = 240;   // tracked keys, including ones never asked for
  const NR_CONFIRM_MS   = 400;   // a key must still be there this long after first sight
  const NR_FORGET_MS    = 90000; // unseen this long and it is dropped
  // A retained message is handed over the instant a subscription is accepted,
  // so silence for this long means the broker is holding nothing for that name
  // — it is a menu label, a chat line, an animal's HUD readout. Drop it and
  // refuse to ask again for a while. Without this the slots fill with the
  // scene's furniture, which is re-seen on every sweep exactly like a real
  // name and so is never the least-recently-seen thing to evict.
  const NR_ANSWER_MS    = 20000;
  const NR_COLD_MS      = 5 * 60 * 1000;
  const NR_MAX_COLD     = 400;
  const NR_CONFLICT_MS  = 10 * 60 * 1000;
  const NR_TICK_MS      = 250;   // one subscribe per tick, to stay polite
  const NR_RETRY_MS     = 6000;
  const NR_KEEPALIVE_MS = 30000;
  const NR_CONNECT_MS   = 8000;

  const NR_ENC = new TextEncoder();
  const NR_DEC = new TextDecoder();

  // Declared with `var` rather than `let` ON PURPOSE. saveNameColor() sits far
  // above this block and calls nrOnLocalChange(); if anything ever calls it
  // while the module body is still being evaluated, a `let` would be in its
  // temporal dead zone and reading it would throw, killing the whole script
  // before the panel is built. A `var` reads as undefined — falsy — instead.
  var nrStarted = false;

  const nrState = {
    // One record per name the sweeps have met. Keeping seen/subscribed/known
    // in ONE map is what lets nrLookup() be a single Map read: it is called for
    // every text node in the scene graph, several times a second.
    names:   new Map(),   // nameKey -> record (see nrLookup)
    cold:    new Map(),   // nameKey -> when it may be asked for again
    topics:  new Map(),   // topic -> nameKey, for messages arriving
    conns:   [],          // one per entry in PARTY_BROKERS
    derived: new Map(),   // nameKey -> Promise<{topic, key}>
    installId: '',
    lastPublished: '',    // the name whose topic currently holds our entry
    lastSig: '',
    conflicts: 0,
    publishTimer: 0,
    wanted: false,        // last state nrSync() acted on, so it only acts on changes
  };

  nrState.installId = String(store.get(NR_KEYS.id, '') || '');
  if (!/^[a-z0-9]{8}$/.test(nrState.installId)) {
    nrState.installId = Math.random().toString(36).slice(2, 10).padEnd(8, '0').slice(0, 8);
    store.set(NR_KEYS.id, nrState.installId);
  }
  nrState.lastPublished = String(store.get(NR_KEYS.pub, '') || '');

  function nrOn() {
    return settings.masterEnabled && nameColorState.enabled && nameColorState.relay;
  }
  function nrNow() { return performance.now(); }

  function nrHex(bytes) {
    let s = '';
    for (const b of bytes) s += b.toString(16).padStart(2, '0');
    return s;
  }

  // Deliberately NOT PBKDF2, which the party map uses. There it runs once per
  // connection over a ten-character random code; here it would run once per
  // name a sweep meets, and 200k iterations apiece would stall the tab. It
  // would also buy nothing: a nickname is low-entropy and guessable by anyone
  // who cares to guess it, so the cost of a single guess is not what protects
  // an entry — needing to know the name before you can even name the topic is.
  function nrDerive(key) {
    let p = nrState.derived.get(key);
    if (p) return p;
    p = (async () => {
      const subtle = PAGE.crypto && PAGE.crypto.subtle;
      if (!subtle || !key) return null;
      const tHash = await subtle.digest('SHA-256', NR_ENC.encode(NR_TOPIC_INFO + key));
      const kHash = await subtle.digest('SHA-256', NR_ENC.encode(NR_KEY_INFO + key));
      const aes = await subtle.importKey('raw', kHash, {name: 'AES-GCM'}, false,
        ['encrypt', 'decrypt']);
      return {topic: NR_TOPIC_PREFIX + nrHex(new Uint8Array(tHash)).slice(0, 20), key: aes};
    })().catch(() => null);
    // Bounded: a busy server puts a lot of names past this, and each cached
    // entry pins a CryptoKey. Dropping the lot is fine — anything still on
    // screen re-derives on its next lookup.
    if (nrState.derived.size > 512) nrState.derived.clear();
    nrState.derived.set(key, p);
    return p;
  }

  async function nrSeal(aes, value) {
    const iv = PAGE.crypto.getRandomValues(new Uint8Array(NR_IV_BYTES));
    const ct = await PAGE.crypto.subtle.encrypt(
      {name: 'AES-GCM', iv}, aes, NR_ENC.encode(JSON.stringify(value)));
    const out = new Uint8Array(NR_IV_BYTES + ct.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), NR_IV_BYTES);
    return out;
  }

  // null means "not from somebody who knows this name" — a stray message, a
  // cleared entry, or corruption. Always ignored, never surfaced as an error.
  async function nrUnseal(aes, bytes) {
    if (!aes || !bytes || bytes.length <= NR_IV_BYTES) return null;
    try {
      const pt = await PAGE.crypto.subtle.decrypt(
        {name: 'AES-GCM', iv: bytes.subarray(0, NR_IV_BYTES)},
        aes, bytes.subarray(NR_IV_BYTES));
      const parsed = JSON.parse(NR_DEC.decode(pt));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) { return null; }
  }

  /* ----- payload ----- */

  function nrEncodePayload(key) {
    const body = {v: NR_PAYLOAD_V, n: key, i: nrState.installId, t: Date.now()};
    if (nameColorState.mode === 'grad') { body.m = 'g'; body.g = nameColorState.grad; }
    // The exact hex, not the suffix's 4-bits-per-channel quantization: there is
    // no symbol budget to ration here, so a custom color arrives as chosen.
    else { body.m = 's'; body.c = nameColorState.color; }
    return body;
  }

  // Strictly bounded and never throws. `wantKey` is checked against the name in
  // the payload so a message cannot be replayed onto a different topic and
  // color the wrong player.
  function nrDecodePayload(obj, wantKey) {
    if (!obj || typeof obj !== 'object' || obj.v !== NR_PAYLOAD_V) return null;
    if (typeof obj.n !== 'string' || obj.n !== wantKey) return null;
    const t = Number(obj.t);
    if (!Number.isFinite(t)) return null;
    const now = Date.now();
    // A future stamp would win every freshness comparison forever, so it is
    // rejected rather than clamped — an honest publisher never sends one.
    if (t > now + NR_FUTURE_MS || now - t > NR_MAX_AGE_MS) return null;
    let style = null;
    if (obj.m === 'g') {
      const g = Number(obj.g);
      if (Number.isInteger(g) && g >= 0 && g < NAME_GRADIENTS.length) style = {grad: g};
    } else if (obj.m === 's') {
      if (typeof obj.c === 'string' && /^#[0-9a-f]{6}$/i.test(obj.c)) {
        style = {solid: hexToInt(obj.c)};
      }
    }
    if (!style) return null;
    return {style, at: t, id: typeof obj.i === 'string' ? obj.i.slice(0, 16) : ''};
  }

  /* ----- MQTT, one connection per broker ----- */
  // The packet helpers are the party map's — partyMqStr, partyMqConcat,
  // partyMqPacket and partyMakeReader are pure functions of their arguments
  // with no party state in them. The connection handling is NOT shared: the
  // party transport subscribes to exactly one topic at connect time and
  // rotates brokers on failure, and neither behaviour is wanted here.

  // The party map's reader discards the topic, since it only ever listens on
  // one. Here the topic is the entire point: it says which name an entry is for.
  function nrReadPublish(body) {
    if (body.length < 2) return null;
    const tlen = (body[0] << 8) | body[1];
    if (body.length < 2 + tlen) return null;
    let topic;
    try { topic = NR_DEC.decode(body.subarray(2, 2 + tlen)); }
    catch (e) { return null; }
    return {topic, payload: body.subarray(2 + tlen)};
  }

  function nrMakeConn(index) {
    return {
      index, label: PARTY_BROKERS[index][0], url: PARTY_BROKERS[index][1],
      ws: null, ready: false, status: 'off', subs: new Set(),
      pingId: 0, connectTimer: 0, lastTry: -Infinity, packetId: 0, read: null,
    };
  }
  for (let i = 0; i < PARTY_BROKERS.length; i++) nrState.conns.push(nrMakeConn(i));

  function nrNextPacketId(conn) {
    conn.packetId = (conn.packetId % 65535) + 1;   // MQTT forbids 0
    return conn.packetId;
  }

  function nrConnClose(conn, why) {
    const sock = conn.ws;
    conn.ws = null;
    conn.ready = false;
    conn.subs.clear();
    clearInterval(conn.pingId);
    clearTimeout(conn.connectTimer);
    if (sock) {
      try { sock.onopen = sock.onmessage = sock.onerror = sock.onclose = null; } catch (e) {}
      try { sock.close(); } catch (e) {}
    }
    if (conn.status !== why) { conn.status = why; nrStatusChanged(); }
  }

  function nrConnOpen(conn) {
    if (conn.ws) return;
    conn.lastTry = nrNow();
    const WS = PAGE.WebSocket || WebSocket;
    let sock;
    try {
      sock = new WS(conn.url, 'mqtt');   // the subprotocol is required for MQTT-over-WS
      sock.binaryType = 'arraybuffer';
    } catch (e) {
      conn.status = 'blocked';
      nrStatusChanged();
      return;
    }
    conn.ws = sock;
    conn.ready = false;
    conn.status = 'wait';
    conn.read = partyMakeReader();
    conn.subs.clear();
    nrStatusChanged();

    conn.connectTimer = setTimeout(() => {
      if (conn.ws === sock && !conn.ready) { try { sock.close(); } catch (e) {} }
    }, NR_CONNECT_MS);

    sock.onopen = () => {
      try {
        sock.send(partyMqPacket(0x10, partyMqConcat([
          partyMqStr('MQTT'),
          new Uint8Array([4, 0x02, 0x00, 0x3c]), // v3.1.1, clean session, 60s keepalive
          partyMqStr('lumi-nr-' + nrState.installId + '-' +
            Math.random().toString(36).slice(2, 8)),
        ])));
      } catch (e) {}
    };

    sock.onmessage = (ev) => {
      if (conn.ws !== sock) return;
      let res;
      try { res = conn.read(new Uint8Array(ev.data)); }
      catch (e) { return; }
      if (res.fatal) { nrConnClose(conn, 'bad'); return; }
      for (const p of res.packets) {
        if (p.type === 2) {                                  // CONNACK
          if (p.body.length >= 2 && p.body[1] !== 0) {
            nrConnClose(conn, 'refused');
            return;
          }
          conn.ready = true;
          conn.status = 'ok';
          clearTimeout(conn.connectTimer);
          conn.pingId = setInterval(() => {
            try { sock.send(partyMqPacket(0xc0, NR_EMPTY)); } catch (e) {}
          }, NR_KEEPALIVE_MS);
          nrStatusChanged();
          // A clean session keeps nothing across a reconnect, so everything
          // already being watched has to be asked for again — and our own
          // entry republished, because this broker may never have had it.
          for (const rec of nrState.names.values()) {
            if (rec.topic) nrConnSubscribe(conn, rec.topic);
          }
          nrPublishSelf(true);
        } else if (p.type === 3) {                           // PUBLISH (QoS 0)
          const msg = nrReadPublish(p.body);
          if (msg) nrOnMessage(msg.topic, msg.payload);
        }
      }
    };
    sock.onerror = () => { if (conn.ws === sock && !conn.ready) conn.status = 'bad'; };
    sock.onclose = () => {
      if (conn.ws !== sock) return;
      nrConnClose(conn, 'bad');
    };
  }

  function nrConnSubscribe(conn, topic) {
    if (!conn.ready || !conn.ws || conn.subs.has(topic)) return;
    const id = nrNextPacketId(conn);
    try {
      conn.ws.send(partyMqPacket(0x82, partyMqConcat([
        new Uint8Array([(id >> 8) & 255, id & 255]),
        partyMqStr(topic), new Uint8Array([0]),               // QoS 0
      ])));
      conn.subs.add(topic);
    } catch (e) {}
  }

  function nrConnUnsubscribe(conn, topic) {
    conn.subs.delete(topic);
    if (!conn.ready || !conn.ws) return;
    const id = nrNextPacketId(conn);
    try {
      conn.ws.send(partyMqPacket(0xa2, partyMqConcat([
        new Uint8Array([(id >> 8) & 255, id & 255]), partyMqStr(topic),
      ])));
    } catch (e) {}
  }

  // 0x31 is PUBLISH with QoS 0 and the RETAIN bit set — the bit that makes the
  // broker keep this message and hand it to later subscribers. An empty payload
  // published retained is MQTT's way of DELETING a retained message.
  function nrConnPublish(conn, topic, bytes) {
    if (!conn.ready || !conn.ws) return false;
    try {
      conn.ws.send(partyMqPacket(0x31, partyMqConcat([partyMqStr(topic), bytes])));
      return true;
    } catch (e) { return false; }
  }

  /* ----- the registry itself ----- */

  // Called from styleFor() for EVERY text node the sweeps meet, several times a
  // second, so it must be one Map read and nothing more. Everything an unknown
  // name needs — hashing it, spending a subscription slot — is left to the
  // pacer below.
  function nrLookup(key) {
    if (!nrStarted || !key) return null;
    // A name more than one player is wearing on screen right now. The registry
    // is keyed by the name alone, so those players share ONE entry between them
    // and whoever published last wins it — the same colour would go on both
    // nameplates, which is the bug this is here to stop. Ambiguous is
    // ambiguous: say nothing and let each name's own suffix decide, exactly as
    // the conflict state below already does for two brokers disagreeing.
    if (ambiguousNames.has(key)) return null;
    const rec = nrState.names.get(key);
    if (rec) {
      rec.seenAt = nrNow();
      return rec.style;      // null while pending, and null on a disputed name
    }
    if (!nrOn() || key.length > NR_MAX_KEY_LEN) return null;
    if (nrState.cold.has(key)) return null;   // asked once, nobody answered
    if (nrState.names.size < NR_MAX_NAMES) {
      const now = nrNow();
      nrState.names.set(key, {
        key, topic: '', style: null, at: 0, id: '',
        first: now, seenAt: now, subAt: 0, answered: false, state: 'seen',
      });
    }
    return null;
  }

  async function nrRequest(rec) {
    rec.state = 'sub';
    const d = await nrDerive(rec.key);
    // The record can be evicted while the hash is being computed.
    if (nrState.names.get(rec.key) !== rec || !nrOn()) return;
    // No SubtleCrypto at all (an insecure context, a locked-down engine).
    // Drop the record rather than leaving it parked in 'sub' forever, where it
    // would hold a subscription slot it can never use.
    if (!d) { nrDrop(rec); return; }
    rec.topic = d.topic;
    rec.subAt = nrNow();
    nrState.topics.set(d.topic, rec.key);
    for (const conn of nrState.conns) nrConnSubscribe(conn, d.topic);
  }

  function nrCool(rec) {
    // Bounded like everything else here: a long session on a busy server puts a
    // lot of text past this, and the list is only an optimisation — losing it
    // costs one wasted subscription per name, not correctness.
    if (nrState.cold.size >= NR_MAX_COLD) nrState.cold.clear();
    nrState.cold.set(rec.key, nrNow() + NR_COLD_MS);
    nrDrop(rec);
  }

  function nrDrop(rec) {
    nrState.names.delete(rec.key);
    if (rec.topic) {
      nrState.topics.delete(rec.topic);
      for (const conn of nrState.conns) nrConnUnsubscribe(conn, rec.topic);
    }
  }

  function nrForgetAll() {
    for (const rec of [...nrState.names.values()]) nrDrop(rec);
    nrState.names.clear();
    nrState.topics.clear();
  }

  async function nrOnMessage(topic, payload) {
    const key = nrState.topics.get(topic);
    if (!key) return;
    const rec = nrState.names.get(key);
    if (!rec) return;
    // A cleared entry arrives as an empty retained message. Treat it as the
    // owner withdrawing their color rather than as corruption.
    if (!payload || payload.length === 0) {
      // Answered, even so. The topic demonstrably belongs to somebody running
      // this script, so the subscription is kept and the cool-off below does
      // not apply — otherwise switching sharing off and straight back on would
      // leave everyone else blind to the color for the whole cool-off period.
      rec.answered = true;
      rec.subAt = nrNow();
      if (rec.state !== 'conflict') { rec.style = null; rec.at = 0; rec.id = ''; rec.state = 'sub'; }
      return;
    }
    const d = await nrDerive(key);
    if (!d || nrState.names.get(key) !== rec) return;
    const raw = await nrUnseal(d.key, payload);
    const got = nrDecodePayload(raw, key);
    if (!got) return;
    if (nrState.names.get(key) !== rec) return;

    // Two installs claiming one name. Retain means the second publisher simply
    // overwrites the first ON A GIVEN BROKER, so this only ever shows up when
    // they land on different brokers — the check is worth having and is not a
    // guarantee. Ambiguous is ambiguous: color neither, and say so in the
    // panel, rather than picking a winner and getting it wrong half the time.
    if (rec.state === 'known' && rec.id && got.id && got.id !== rec.id &&
        Math.abs(got.at - rec.at) < NR_CONFLICT_MS) {
      nrState.conflicts++;
      rec.state = 'conflict';
      rec.style = null;
      return;
    }
    rec.answered = true;
    if (rec.state === 'conflict') return;
    if (got.at < rec.at) return;               // an older copy from another broker
    rec.style = got.style;
    rec.at = got.at;
    rec.id = got.id;
    rec.state = 'known';
  }

  /* ----- publishing our own entry ----- */

  async function nrPublishSelf(force) {
    if (!nrStarted) return;
    const key = nrOn() ? nameKey() : '';
    // "mope.io" is what the server shows for a nameless player, so it belongs
    // to everybody and to nobody — claiming it would color every one of them.
    const sharing = !!key && key !== 'mope.io' && nameColorState.share;
    const prev = nrState.lastPublished;

    // A rename leaves the OLD topic holding a retained entry that now belongs
    // to no one, and retained entries do not expire. Clear it before claiming
    // the new one, or the old name keeps that color on every client that ever
    // looks it up. Same path when sharing is switched off — that is what makes
    // the toggle a withdrawal rather than just a pause.
    if (prev && (!sharing || prev !== key)) {
      const old = await nrDerive(prev);
      if (old) {
        let cleared = 0;
        for (const conn of nrState.conns) {
          if (nrConnPublish(conn, old.topic, NR_EMPTY)) cleared++;
        }
        // Only forget it once at least one broker has taken the deletion,
        // otherwise the entry is orphaned with nothing left to point at it.
        if (cleared) {
          nrState.lastPublished = '';
          nrState.lastSig = '';
          store.set(NR_KEYS.pub, '');
        }
      }
    }
    if (!sharing) return;

    const body = nrEncodePayload(key);
    const sig = key + '|' + body.m + '|' + (body.m === 'g' ? body.g : body.c);
    if (!force && sig === nrState.lastSig) return;

    const d = await nrDerive(key);
    if (!d) return;
    let bytes;
    try { bytes = await nrSeal(d.key, body); }
    catch (e) { return; }
    let sent = 0;
    for (const conn of nrState.conns) {
      if (nrConnPublish(conn, d.topic, bytes)) sent++;
    }
    if (sent) {
      nrState.lastPublished = key;
      nrState.lastSig = sig;
      store.set(NR_KEYS.pub, key);
      dbg('name registry: published to', sent, 'broker(s)');
    }
  }

  // The picker fires a save on every click, and a drag across the palette
  // fires a lot of them. Coalesce, so one retained publish lands per decision
  // rather than one per pixel.
  function nrPublishSoon() {
    clearTimeout(nrState.publishTimer);
    nrState.publishTimer = setTimeout(() => { nrPublishSelf(false); }, 400);
  }

  /* ----- lifecycle ----- */

  function nrSync() {
    // saveNameColor() calls this on every click in the picker, so a drag across
    // the palette arrives here dozens of times. Only a real change of intent
    // does any work; without this, switching the relay off would re-run the
    // withdrawal — and the SHA-256 behind it — on every subsequent save.
    // Reconnecting is the pacer's job, and only the pacer's: it holds the
    // NR_RETRY_MS backoff, and re-dialling from here would sidestep it once
    // per click on a broker that is down.
    const want = nrOn();
    if (want === nrState.wanted) return;
    nrState.wanted = want;
    if (want) {
      for (const conn of nrState.conns) if (!conn.ws) nrConnOpen(conn);
    } else {
      // Withdraw before hanging up: once the sockets are gone there is no way
      // to clear a retained entry, and it would sit on the broker indefinitely.
      const hadEntry = !!nrState.lastPublished;
      if (hadEntry) nrPublishSelf(false);
      const closeNow = () => {
        for (const conn of nrState.conns) nrConnClose(conn, 'off');
      };
      if (hadEntry) setTimeout(closeNow, 1200); else closeNow();
      nrForgetAll();
    }
    nrStatusChanged();
  }

  function nrOnLocalChange() {
    if (!nrStarted) return;
    nrSync();
    if (nrOn()) nrPublishSoon();
  }

  // Deferred past the party map's own connect, so the two features do not open
  // four sockets into the same moment of page start-up.
  setTimeout(() => {
    nrStarted = true;
    if (nrOn()) nrSync();
  }, 3000);

  // One tick does one piece of work: promote at most one confirmed name to a
  // real subscription, evict what has gone quiet, and reconnect what has
  // dropped. Rate-limited on purpose — these are other people's free brokers.
  setInterval(() => {
    if (!nrStarted) return;
    if (!nrOn()) return;
    const now = nrNow();

    for (const conn of nrState.conns) {
      if (!conn.ws && now - conn.lastTry > NR_RETRY_MS) nrConnOpen(conn);
    }

    for (const [key, until] of nrState.cold) {
      if (now > until) nrState.cold.delete(key);
    }

    let live = 0;
    let candidate = null;
    let evictable = null;   // an unanswered subscription, preferred for eviction
    let oldest = null;      // otherwise, whatever was seen longest ago
    for (const rec of nrState.names.values()) {
      if (now - rec.seenAt > NR_FORGET_MS) { nrDrop(rec); continue; }
      if (rec.state === 'seen') {
        // Asked for only after a name has survived two sweeps a short interval
        // apart. The scene walk visits every text node in the game — HUD
        // readouts, chat lines, a leaderboard caught mid-rebuild — and a slot
        // spent on one of those is a slot a real player does not get.
        if (now - rec.first >= NR_CONFIRM_MS &&
            (!candidate || rec.first < candidate.first)) candidate = rec;
        continue;
      }
      if (rec.state === 'sub' && !rec.answered && rec.subAt &&
          now - rec.subAt > NR_ANSWER_MS) {
        nrCool(rec);
        continue;
      }
      live++;
      if (rec.state === 'sub' && !rec.answered) {
        if (!evictable || rec.subAt < evictable.subAt) evictable = rec;
      } else if (!oldest || rec.seenAt < oldest.seenAt) oldest = rec;
    }

    // Evicting by last-seen alone does not work here: a menu label is re-seen
    // on every sweep just as reliably as a player is, so it never looks stale.
    // A subscription still waiting for an answer is the better thing to give up.
    if (live >= NR_MAX_SUBS) {
      const victim = evictable || oldest;
      if (victim) { nrDrop(victim); live--; }
    }
    if (candidate && live < NR_MAX_SUBS) nrRequest(candidate);
  }, NR_TICK_MS);

  // Republish on the way into a game. injectSuffix() already runs on these
  // events for the nickname tag; this is the same moment for the registry, and
  // it is what keeps a retained entry from ageing out for an active player.
  document.addEventListener('submit', (e) => {
    if (e.target && e.target.id === 'playForm' && nrOn()) nrPublishSelf(true);
  }, true);
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.closest && t.closest('#playButton') && nrOn()) nrPublishSelf(true);
  }, true);

  // A function declaration rather than a reassignable stub, so the connection
  // handlers above can call it without caring whether the panel has been built
  // yet — it simply paints nothing until there is somewhere to paint.
  function nrStatusChanged() {
    if (!extras || !extras.nameUi || !extras.nameUi.relayStatus) return;
    const el = extras.nameUi.relayStatus;
    const s = nrStatusLine();
    const cls = 'qolc-party-status' + s.cls;
    if (el.className !== cls) el.className = cls;
    if (el.textContent !== s.text) el.textContent = s.text;
  }

  // The counts in that line move on their own — names resolve, brokers drop —
  // so it is repainted while it is actually on screen. Cheap, and only the one
  // element: a full syncNameColorUI() rebuilds the preview and the whole
  // gradient picker, which is not something to do twice a second.
  setInterval(() => {
    if (!extras || !extras.panel || extras.panel.style.display !== 'block') return;
    if (extras.current !== 'cosmetics') return;
    nrStatusChanged();
  }, 1200);

  function nrStatusLine() {
    if (!nameColorState.relay) return {cls: '', text: 'Off — colors are only shared as name tags.'};
    if (!settings.masterEnabled || !nameColorState.enabled) {
      return {cls: '', text: 'Idle — name colors are switched off.'};
    }
    if (!nrStarted) return {cls: ' is-wait', text: 'Starting…'};
    const ok = nrState.conns.filter((c) => c.ready).map((c) => c.label);
    const known = [...nrState.names.values()].filter((r) => r.state === 'known').length;
    if (!ok.length) {
      const blocked = nrState.conns.some((c) => c.status === 'blocked');
      return {cls: ' is-bad', text: blocked
        ? 'Cannot reach any relay — the page CSP is blocking it.'
        : 'Connecting to the relays…'};
    }
    let text = ok.join(', ') + ' — ' + known + ' name' + (known === 1 ? '' : 's') + ' known';
    text += nameColorState.share
      ? (nrState.lastPublished ? ', yours is published.' : ', publishing yours…')
      : ', yours is not shared.';
    if (nrState.conflicts) {
      text += ' ' + nrState.conflicts + ' name' + (nrState.conflicts === 1 ? '' : 's') +
        ' claimed twice and left uncolored.';
    }
    return {cls: ' is-ok', text};
  }

  function nrDebug() {
    return {
      on: nrOn(),
      started: nrStarted,
      sharing: nameColorState.share,
      installId: nrState.installId,
      published: nrState.lastPublished || null,
      brokers: nrState.conns.map((c) => ({
        broker: c.label, status: c.status, ready: c.ready, subs: c.subs.size,
      })),
      // Only the names actually being watched. Anything still in 'seen' is
      // noise the sweeps happened to walk past and has not cost anything.
      names: [...nrState.names.values()].filter((r) => r.state !== 'seen').map((r) => ({
        name: r.key,
        state: r.state,
        style: r.style
          ? (r.style.grad !== undefined
              ? 'gradient ' + (r.style.grad + 1) + ' (' + NAME_GRADIENTS[r.style.grad][0] + ')'
              : '#' + r.style.solid.toString(16).padStart(6, '0'))
          : null,
        published: r.at ? Math.round((Date.now() - r.at) / 1000) + 's ago' : null,
        by: r.id || null,
      })),
      seen: [...nrState.names.values()].filter((r) => r.state === 'seen').length,
      cooled: nrState.cold.size,
      conflicts: nrState.conflicts,
    };
  }
  try { PAGE.__lumiNameRelayDebug = nrDebug; }
  catch (e) { window.__lumiNameRelayDebug = nrDebug; }

  // ---------------- DOM coloring (leaderboard / menus, optional) ----------------
  // Every surface this script draws, as one selector list. It used to be a
  // chain of four closest() calls listing only the party map's layers, which
  // was enough while nothing of ours displayed a player's name. 1.16.0's party
  // list does: a miss here would have this repaint a member's name over the
  // dot colour it was just given, AND spend online-registry subscriptions
  // asking about names this script had itself written to the page.
  // 1.0.10 makes this a PREFIX test rather than a hand-maintained list. The
  // list had already drifted twice: #qolc-stats and #qolc-boost are both
  // appended straight to body, and neither was named here — so the script's
  // own fps/ping/boost readouts were fed to styleFor as if they were player
  // names, spending registry subscriptions on our own text and letting a stat
  // that happened to read "67" take a player's colour. That is the same
  // collision the 1.0.8 bar-readout fix chased, arriving by a different door.
  //
  // Every surface this script builds carries an id beginning "qolc-", so an
  // attribute-prefix selector is correct BY CONSTRUCTION for surfaces that do
  // not exist yet. The id convention is now the contract; anything new is
  // covered the moment it is named.

  const domTouched = new Map(); // element -> original inline styles

  // A gradient in the DOM is painted with background-clip:text over a
  // transparent text fill, and a transparent fill takes the colour out of a
  // colour-font emoji too — it comes back as a gradient-filled silhouette.
  // There is no per-glyph escape from that without cutting the game's own text
  // nodes up, which is Svelte-managed and would be rewritten under us, so a
  // name with an emoji in it takes a plain colour from the middle of its own
  // gradient instead. CSS `color` is ignored by colour-font emoji, so they come
  // out untouched — which is the half of this that was asked for. In the game
  // world, where the nodes ARE ours to cut up, the gradient is kept in full.
  function applyDomStyle(el, st) {
    const emojiSafe = st.grad !== undefined && textHasEmoji(el.textContent || '');
    if (st.grad !== undefined && !emojiSafe) {
      if (nameColorState.anim) {
        el.style.backgroundImage = cssGradCyc(st.grad);
        el.style.backgroundSize = '200% 100%';
        // seed the CSS clock from the same origin as the canvas overlay
        // (negative delay = current global phase) so all surfaces flow in
        // sync and rebuilt leaderboard rows resume mid-cycle instead of
        // restarting; only on fresh application — retiming a running
        // animation would make it jump.
        if (el.style.animationName !== 'mnc-flow') {
          el.style.animation = 'mnc-flow ' + (ANIM_PERIOD / 1000) + 's linear infinite';
          el.style.animationDelay = '-' + Math.round(performance.now() % ANIM_PERIOD) + 'ms';
        }
      } else {
        el.style.backgroundImage = cssGrad(st.grad);
        el.style.backgroundSize = '';
        el.style.animation = '';
        el.style.animationDelay = '';
      }
      el.style.webkitBackgroundClip = 'text';
      el.style.backgroundClip = 'text';
      el.style.webkitTextFillColor = 'transparent';
      el.style.color = '';
    } else {
      el.style.backgroundImage = '';
      el.style.backgroundSize = '';
      el.style.animation = '';
      el.style.animationDelay = '';
      el.style.webkitBackgroundClip = '';
      el.style.backgroundClip = '';
      el.style.webkitTextFillColor = '';
      const solid = st.solid !== undefined
        ? st.solid : gradColorAt(gradStopsOf(st.grad), 0.5);
      el.style.color = '#' + solid.toString(16).padStart(6, '0');
    }
  }
  function restoreDomColor(el, orig) {
    el.style.color = orig.color;
    el.style.backgroundImage = orig.bg;
    el.style.backgroundSize = orig.bsize;
    el.style.animation = orig.anim;
    el.style.animationDelay = orig.adelay;
    el.style.webkitBackgroundClip = orig.clip;
    el.style.backgroundClip = orig.bclip;
    el.style.webkitTextFillColor = orig.tfill;
  }
  // WHERE THIS SWEEP IS ALLOWED TO LOOK. 1.0.3, and the whole fix for a class
  // of bug rather than one instance of it.
  //
  // Only semantically marked leaderboard name cells are eligible. Menu text,
  // scores, ranks and server labels never enter colour lookup.
  function domSweepRoots() {
    return Array.from(document.querySelectorAll('#leaderboard .leaderboardEntry > .leaderboardName'));
  }
  // How many text nodes the last sweep actually looked at, reported by
  // __lumiNameDebug: a sweep that has been scoped away from where somebody
  // expected it can then say so, rather than quietly colouring nothing.
  let domSweepScanned = 0;

  function domSweep() {
    if (!document.body) return;
    const active = settings.masterEnabled && nameColorState.enabled && nameColorState.dom;
    domSweepScanned = 0;
    if (active) {
      for (const root of domSweepRoots()) {
      const walker = document.createTreeWalker(root, PAGE.NodeFilter.SHOW_TEXT);
      let t;
      while ((t = walker.nextNode())) {
        const v = t.nodeValue;
        if (!v || v.length > 48) continue;
        domSweepScanned++;
        // Our own UI is skipped BEFORE styleFor, not after. It used to be
        // after, which was harmless while styleFor only ever read from the
        // text handed to it — but the registry lookup inside it now REGISTERS
        // unknown names, and this walk reaches every label in the extras panel.
        // A live test spent fifteen subscriptions on "Reduce menu clutter",
        // "1. Sunset" and "▼" before a single player name was asked for.
        const el = t.parentElement;
        if (!el || el.closest(QOLC_OWN_UI) ||
            el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
        const st = styleFor(v, !!el.closest('#leaderboard .leaderboardEntry.main'));
        if (!st) continue;
        if (!domTouched.has(el)) {
          domTouched.set(el, {
            color: el.style.color, bg: el.style.backgroundImage,
            bsize: el.style.backgroundSize, anim: el.style.animation,
            adelay: el.style.animationDelay,
            clip: el.style.webkitBackgroundClip, bclip: el.style.backgroundClip,
            tfill: el.style.webkitTextFillColor,
          });
        }
        applyDomStyle(el, st);
      }
      }
    }
    for (const [el, orig] of domTouched) {
      const isName = el.matches('#leaderboard .leaderboardEntry > .leaderboardName');
      const st = active && el.isConnected && isName
        ? styleFor(el.textContent || '', !!el.closest('#leaderboard .leaderboardEntry.main')) : null;
      if (!st) {
        if (el.isConnected) restoreDomColor(el, orig);
        domTouched.delete(el);
      } else {
        applyDomStyle(el, st);
      }
    }
  }
  let lastScheduledDomSweep = 0;
  setInterval(() => {
    const now = performance.now();
    const delay = 1000;
    if (now - lastScheduledDomSweep < delay) return;
    lastScheduledDomSweep = now;
    domSweep();
  }, 1000);

  // ---------------- name auto-capture ----------------
  // The game's nickname box is <input id="name">; remember whatever is typed there.
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el && el.tagName === 'INPUT' && el.id === 'name' && el.value.length <= 32) {
      nameColorState.name = stripInvis(el.value);
      saveNameColor();
      syncNameColorUI();
    }
  }, true);

  // ----------------------------------------------------- clutter reduction

  // Each feature gets its own hider so toggling one doesn't restore the
  // other. Original inline styles are recorded for clean restore.
  // The marker is per ELEMENT AND PROPERTY, which it was not until 1.20.0.
  //
  // It used to be one flag per element: `if (el.dataset[flag]) return`. That
  // made the SECOND property ever set on a card a silent no-op, and the game
  // clutter feature sets two different ones — `display: none` on the cards it
  // hides, `translate` on the cards it moves. Whichever call reached a given
  // card first won, and the other did nothing at all.
  //
  // Which one reached it first depended on sweep order, and sweep order is not
  // fixed: the DOM scan is driven by a MutationObserver as well as a timer, so
  // a page with another extension mutating it, or a machine slow enough to
  // interleave the two differently, gets a different winner. That is a bug
  // that reproduces on one machine and not the next, which is exactly the
  // shape of the report this fixes — dash and climb refusing to come back was
  // the visible half of it. The undo list also recorded one entry per
  // element, so restoring gave back only whichever property had won.
  //
  // Now each (element, property) pair is marked and recorded separately, and
  // restore() hands back every one of them.
  // `dataset` keys become `data-*` attributes, so the mark has to be a plain
  // camelCase identifier — punctuation in the key is not reliably accepted and
  // a `-` before a lowercase letter is rejected outright as ambiguous. The
  // property name is folded to letters and capitalised: `qolcGame` + `display`
  // becomes `data-qolc-game-display`.
  function hiderMark(flag, prop) {
    const clean = String(prop).replace(/[^a-z]/gi, '');
    return flag + clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
  }

  function makeHider(flag, name) {
    const undo = [];
    const markOf = (prop) => hiderMark(flag, prop);
    return {
      set(el, prop, value, label) {
        const mark = markOf(prop);
        if (el.dataset[flag] === '1') {
          // Written by a build before 1.20.0, or by an older copy of this
          // script sharing the page. Treated as "display was taken", which is
          // what that flag always meant in practice, so the two cannot both
          // record the same property and restore it twice.
          el.dataset[markOf('display')] = '1';
          delete el.dataset[flag];
        }
        if (el.dataset[mark]) return;
        el.dataset[mark] = '1';
        undo.push({
          el, prop, mark,
          old: el.style.getPropertyValue(prop),
          oldPriority: el.style.getPropertyPriority(prop),
        });
        el.style.setProperty(prop, value, 'important');
        dbg(name + ':', label, '→', prop + ':' + value, el);
      },
      hide(el, label) { this.set(el, 'display', 'none', label); },
      restore() {
        for (const rec of undo) {
          try {
            delete rec.el.dataset[rec.mark];
            if (rec.old) rec.el.style.setProperty(rec.prop, rec.old, rec.oldPriority);
            else rec.el.style.removeProperty(rec.prop);
          } catch (e) { /* element may be gone */ }
        }
        undo.length = 0;
        dbg(name + ': restored');
      },
      // What is still held, for the debug hook. A restore that left something
      // behind is otherwise invisible until somebody notices a missing button.
      held() { return undo.length; },
    };
  }

  const menuHider = makeHider('qolcMenu', 'menu clutter');
  const gameHider = makeHider('qolcGame', 'game clutter');

  // The clutter feature hides things it does not recognise, so everything this
  // script draws has to be recognisable. Sharing one list with the DOM
  // colourer is the point: a surface added to one and forgotten in the other
  // is exactly how our own UI would end up hidden by our own feature.
  function isOurs(el) {
    return !!(el.closest && el.closest(QOLC_OWN_UI));
  }

  // Elements whose OWN text nodes (not descendants') match the regex.
  function findLeavesByText(regex) {
    const out = [];
    const root = document.body;
    if (!root) return out;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode())) {
      if (isOurs(el)) continue;
      for (const n of el.childNodes) {
        if (n.nodeType === 3 && regex.test(n.textContent)) { out.push(el); break; }
      }
    }
    return out;
  }

  function findCommunityPanel(leaf) {
    // Climb to the ancestor that contains the whole panel (it also holds
    // the "More .IO games" / "Report bugs" buttons), but never something
    // page-sized.
    let best = leaf.parentElement || leaf;
    let node = leaf;
    for (let i = 0; i < 8 && node; i++, node = node.parentElement) {
      const text = node.textContent || '';
      if (/More\s+\.?IO\s+games|Report\s+bugs/i.test(text)) {
        const r = node.getBoundingClientRect();
        if (r.width < innerWidth * 0.6 && r.height < innerHeight * 0.8) best = node;
        break;
      }
    }
    return best;
  }

  // One TreeWalker pass gathering every text hit menu-clutter needs
  // (previously five separate full-DOM walks per apply).
  function collectMenuLeaves() {
    const hits = { play: false, community: null, players: [], privacy: [], terms: [] };
    if (!document.body) return hits;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode())) {
      if (isOurs(el)) continue;
      for (const n of el.childNodes) {
        if (n.nodeType !== 3) continue;
        const t = n.textContent;
        if (!hits.play && /^\s*Play\s*$/i.test(t)) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) hits.play = true;
        }
        if (!hits.community && /Community\s*&\s*More/i.test(t)) hits.community = el;
        if (/players?\s+online/i.test(t)) hits.players.push(el);
        if (/^\s*Privacy\s+Policy\s*$/i.test(t)) hits.privacy.push(el);
        if (/^\s*Terms\b/i.test(t)) hits.terms.push(el);
      }
    }
    return hits;
  }

  function applyMenuClutter() {
    if (!document.body) return;
    // The main menu is the only screen with a Play button. Menu-clutter rules
    // must never run in-game: the season-logo corner fallback hides bottom-left
    // images, and in-game that region holds the ability cards' pictures.
    const hits = collectMenuLeaves();
    if (!hits.play) return;

    // Community & More panel (grab its position first so the player count
    // can slide up into its place).
    const panel = hits.community ? findCommunityPanel(hits.community) : null;
    let panelRect = null;
    if (panel && !panel.dataset.qolcMenu) {
      panelRect = panel.getBoundingClientRect();
      menuHider.hide(panel, 'Community & More panel');
    }

    // "N players online" — move up into the freed space if it's positioned.
    if (panelRect) {
      for (const el of hits.players) {
        const target = el.closest('[style]') || el;
        if (target.dataset.qolcMenu) continue;
        const cs = getComputedStyle(target);
        if (cs.position === 'fixed') {
          menuHider.set(target, 'top', panelRect.top + 'px', 'player count (fixed)');
        } else if (cs.position === 'absolute' && target.offsetParent) {
          const rel = panelRect.top - target.offsetParent.getBoundingClientRect().top;
          menuHider.set(target, 'top', rel + 'px', 'player count (absolute)');
        }
        // Normal-flow elements move up automatically once the panel is gone.
        break;
      }
    }

    // Privacy Policy / Terms of Service links.
    for (const el of hits.privacy) {
      menuHider.hide(el.closest('a') || el, 'Privacy Policy link');
    }
    for (const el of hits.terms) {
      menuHider.hide(el.closest('a') || el, 'Terms link');
    }

    // Season logo (S26) in the bottom-left corner. Try attribute matches
    // first, then fall back to "image-ish thing in the corner".
    const logoSelectors = [
      'img[src*="s26" i]', 'img[src*="season" i]',
      '[id*="s26" i]', '[class*="s26" i]',
      '[id*="seasonlogo" i]', '[class*="seasonlogo" i]', '[class*="season-logo" i]',
    ];
    let logoFound = false;
    for (const sel of logoSelectors) {
      let els = [];
      try { els = document.querySelectorAll(sel); } catch (e) { /* selector support */ }
      for (const el of els) {
        if (isOurs(el)) continue;
        menuHider.hide(el, 'season logo (' + sel + ')');
        logoFound = true;
      }
    }
    if (!logoFound) {
      for (const el of document.querySelectorAll('img,svg')) {
        if (isOurs(el) || el.dataset.qolcMenu) continue;
        const r = el.getBoundingClientRect();
        if (r.width >= 40 && r.width <= 340 && r.height >= 20 && r.height <= 180 &&
            r.left < 280 && r.top > innerHeight - 260) {
          menuHider.hide(el, 'season logo (corner fallback)');
        }
      }
    }
  }

  // The ability-box cluster.
  //
  // This used to work purely on position: hide whichever row was on top, keep
  // the bottom one. A game update then swapped the dash box and the animal's
  // own ability box around, and "the top row" became the one row you cannot
  // afford to lose. Position is no longer a safe way to say which box is
  // which, so the boxes are now identified individually.
  //
  // Dash, Climb and Dive are the three whose names never change, whatever
  // animal you are, so they can be named outright. Anything else in the
  // cluster is the animal's OWN ability — called something different for every
  // animal in the game — and is recognised by being none of the three.
  //
  // Ids are tried before labels because the rest of this script already talks
  // to the HUD by id, so if the ids ever move, everything breaks together and
  // visibly rather than one feature at a time. The label is the fallback.
  const GAME_FIXED_BOXES = [
    {key: 'ability1', id: 'ability1Button'},
    {key: 'ability2', id: 'ability2Button'},
    {key: 'drop',     id: 'dropButton'},
    {key: 'dash',  id: 'dashButton',  label: /^\s*Dash\s*$/i},
    {key: 'climb', id: 'climbButton', label: /^\s*Climb\s*$/i},
    {key: 'dive',  id: 'diveButton',  label: /^\s*Dive\s*$/i},
  ];
  // Hidden outright.
  const GAME_HIDE_BOXES = ['dash', 'climb'];
  // Kept, and laid out left to right in this order.
  const GAME_ROW_BOXES = ['ability1', 'ability2', 'dive', 'drop'];

  function findAbilityContainer() {
    if (!document.body) return null;
    const SEED = /^\s*(Dash|Climb|Dive|Spit\s+Water!?|Fly\s+High!?)\s*$/i;
    for (const leaf of findLeavesByText(SEED)) {
      const labelText = (leaf.textContent || '').trim();
      // The button card contains ONLY this label's text; the first ancestor
      // with more text is the container holding every ability button.
      let card = leaf;
      let node = leaf.parentElement;
      for (let i = 0; i < 6 && node && node !== document.body; i++, node = node.parentElement) {
        if ((node.textContent || '').trim() !== labelText) break;
        const r = node.getBoundingClientRect();
        if (r.width > 260 || r.height > 260) break;
        card = node;
      }
      const r = card.getBoundingClientRect();
      if (r.left < innerWidth * 0.55 && r.top > innerHeight * 0.35 && card.parentElement) {
        return card.parentElement;
      }
    }
    return null;
  }

  function classifyAbilityBox(card) {
    for (const box of GAME_FIXED_BOXES) {
      if (card.id === box.id) return box.key;
      try { if (card.querySelector('#' + box.id)) return box.key; } catch (e) { /* odd id */ }
    }
    const text = (card.textContent || '').trim();
    for (const box of GAME_FIXED_BOXES) if (box.label.test(text)) return box.key;
    return 'ability';
  }

  // Everything the cluster is currently showing, sorted into what it is. A
  // card this feature has hidden measures zero and drops out on its own; a
  // card it has only MOVED is still here, because it has to be kept in place
  // on every later sweep.
  function findAbilityBoxes() {
    const container = findAbilityContainer();
    if (!container) return null;
    const out = {spare: []};
    for (const card of container.children) {
      const r = card.getBoundingClientRect();
      if (!(r.width > 10 && r.height > 10)) continue;
      const key = classifyAbilityBox(card);
      // A box this build names in a way we do not recognise is still yours,
      // so it is kept and laid out at the end rather than left where it was.
      if (key === 'ability') out.spare.push(card);
      else if (!out[key]) out[key] = card;
    }
    return out;
  }

  // How far a card has been pushed down, in px, parked on the element so a
  // later sweep can work out where it would sit if this let go of it.
  const GAME_SHIFT_KEY = 'qolcShift';

  // Where a card would sit if this feature let go of it, and where it has been
  // put instead. Moved with `translate` rather than `transform`: they do the
  // same thing here, but `translate` is its own property, so shifting a card
  // cannot overwrite a transform the game is already using on it — and giving
  // the property back later cannot take the game's own one with it.
  function gameRestPlace(card) {
    const done = String(card.dataset[GAME_SHIFT_KEY] || '0,0').split(',');
    const dx = Number(done[0]) || 0, dy = Number(done[1]) || 0;
    const r = card.getBoundingClientRect();
    return {left: r.left - dx, top: r.top - dy, w: r.width, h: r.height, dx, dy};
  }

  function gamePlaceCard(card, rest, wantLeft, wantTop) {
    const dx = Math.round(wantLeft - rest.left);
    const dy = Math.round(wantTop - rest.top);
    if (dx === rest.dx && dy === rest.dy) return;
    const value = dx + 'px ' + dy + 'px';
    if (rest.dx || rest.dy) card.style.setProperty('translate', value, 'important');
    // The first move goes through the hider, so the original value is recorded
    // and handed back when the setting is switched off.
    else gameHider.set(card, 'translate', value, 'ability box placed');
    card.dataset[GAME_SHIFT_KEY] = dx + ',' + dy;
  }

  // Sizes, not positions. A mope update made the animal's OWN ability card
  // bigger than the rest, so the row now reads as ragged and the artwork
  // spills past the card's own edge. Everything here is matched to the Dive
  // box, which is the one card that is the same on every animal.
  //
  // The card is SCALED rather than given a width or height: its artwork, its
  // cooldown ring and its keybind hint are all laid out by the game, and
  // forcing a box size onto that only moves the problem inside the box.
  //
  // `scale` is used for the same reason `translate` is above — it is its own
  // property, so it can never overwrite a transform the game is already using
  // on the card. The origin is pinned to the top-left so a scaled card keeps
  // the left and top that the row maths below measures, and only its width and
  // height change. These two properties are set directly rather than through
  // the hider, which records one property per element; restoreGameClutter
  // clears them explicitly, the same way it clears the shift markers.
  const GAME_SIZE_KEY = 'qolcScale';

  // THE MEASUREMENT, and it is the whole of the "dancing buttons" bug.
  //
  // This used to read `getBoundingClientRect()` and divide by the scale this
  // feature had applied, on the assumption that our own `scale` was the only
  // transform on the card. It is not. mope lays these five buttons out on an
  // ARC, entirely in `transform`:
  //
  //   #ability1Button,#diveButton,#climbButton,#dropButton,#ability2Button {
  //     scale: none;
  //     transform: rotate(…) translateX(var(--arc-radius)) rotate(…)
  //                scale(var(--press-scale, 1));
  //     transition: --press-scale .15s ease-out;
  //     bottom: 2.5dvmin; left: 2.5dvmin;
  //   }
  //
  // `getBoundingClientRect()` includes that transform, `--press-scale` is
  // ANIMATED for 150ms every time an ability is pressed, and the division only
  // ever removed OUR scale. So during a press the card measured small, this
  // computed a larger factor to compensate, wrote it, and on the next sweep
  // the press had ended and the card measured too big — so it wrote a smaller
  // one. A feedback loop with a 150ms period, which is what "dancing around
  // and changing sizes" is.
  //
  // It only spins while abilities are actually being pressed, which is why it
  // showed up for one player in a fight and for nobody standing still.
  //
  // `offsetWidth`/`offsetHeight` are LAYOUT boxes: they ignore `transform` and
  // `scale` completely, so they report the same number whether or not a press
  // is in flight and whether or not this feature has scaled the card. Nothing
  // to divide, nothing to feed back. They are integers, which loses a subpixel
  // of accuracy on a card ~60px tall — worth it several times over for a
  // reading that holds still.
  function gameNaturalSize(card) {
    const w = card.offsetWidth, h = card.offsetHeight;
    if (w > 0 || h > 0) return {w, h};
    // An element with no offset parent (display:contents, or detached) has no
    // layout box to report. Fall back to the old reading rather than treating
    // the card as zero-sized and dropping it out of the row.
    const applied = Number(card.dataset[GAME_SIZE_KEY]) || 1;
    const r = card.getBoundingClientRect();
    return {w: r.width / applied, h: r.height / applied};
  }

  // Whether the game is mid-animation on this card. `--press-scale` is a
  // registered custom property being transitioned, so it shows up as a real
  // animation here; so does anything else mope decides to animate later.
  //
  // A sweep that lands mid-press leaves the row exactly as it is rather than
  // measuring a moving target. This is belt to gameNaturalSize's braces: the
  // sizing no longer cares, but the PLACEMENT below still reads
  // getBoundingClientRect() — positions on an arc cannot be had any other way
  // — and a press moves those too.
  // NOT `{subtree: true}`, deliberately. The cooldown ring is a CHILD of the
  // button and its sweep is a Web Animation that runs for the whole length of
  // a cooldown — seconds at a time. Including the subtree would stand this
  // feature down for as long as any ability was cooling, which is most of a
  // fight. Only the card's own animations move the card.
  function gameCardAnimating(card) {
    if (typeof card.getAnimations !== 'function') return false;
    try {
      for (const anim of card.getAnimations()) {
        if (anim.playState === 'running') return true;
      }
    } catch (e) { /* not supported here; treat as still */ }
    return false;
  }

  // How much a factor has to move before it is worth rewriting. Sizing is
  // quantised to hundredths and given a dead band on top: `offsetHeight` is an
  // integer, so a card that lands one pixel either side of a boundary would
  // otherwise flip between two factors forever at the sweep rate. A percent is
  // half a pixel on a 60px card — far below noticing, and far above the noise.
  const GAME_SIZE_EPSILON = 0.01;

  function gameSizeCard(card, factor) {
    const want = Math.round(factor * 100) / 100;
    const applied = Number(card.dataset[GAME_SIZE_KEY]) || 1;
    if (applied === want) return;
    // Never rewritten for a change too small to see. Without this the dead
    // band above only halves the flapping instead of stopping it.
    if (want !== 1 && Math.abs(applied - want) < GAME_SIZE_EPSILON) return;
    if (want === 1) {
      card.style.removeProperty('scale');
      card.style.removeProperty('transform-origin');
      delete card.dataset[GAME_SIZE_KEY];
      return;
    }
    card.style.setProperty('transform-origin', 'top left', 'important');
    card.style.setProperty('scale', String(want), 'important');
    card.dataset[GAME_SIZE_KEY] = String(want);
  }

  // Dive is the reference. Without one — an animal that cannot dive — the
  // smallest card in the row is used instead, so the row still comes out
  // uniform. Nothing is ever scaled UP: the artwork is a bitmap, and blowing a
  // small card up to match a big one only makes it soft.
  function gameSizeRow(row, dive) {
    const natural = row.map(gameNaturalSize);
    if (natural.some((n) => !(n.h > 8))) return false;      // mid-relayout
    let ref = dive ? gameNaturalSize(dive).h : 0;
    if (!(ref > 8)) ref = Math.min(...natural.map((n) => n.h));
    for (let i = 0; i < row.length; i++) {
      gameSizeCard(row[i], Math.min(1, ref / natural[i].h));
    }
    return true;
  }

  // How far apart the boxes sit once this has arranged them, as a fraction of
  // the shorter screen axis — the same unit the game sizes its own HUD in, so
  // the row keeps its proportions on any display.
  const GAME_ROW_GAP = 0.014;

  // The boxes are the game's own, moved rather than rebuilt. A drawn-from-
  // scratch HUD would have to re-implement the cooldown ring, the ability
  // artwork, the keybind hint and the click handling, and every one of those
  // would be a fresh thing to break on the next update. Repositioning gets the
  // exact spacing without giving any of that up: the boxes stay live, the
  // cooldown numbers still find them by id, and the HP bar still measures them.
  function applyGameClutter() {
    const boxes = findAbilityBoxes();
    if (!boxes) return;
    for (const key of GAME_HIDE_BOXES) {
      if (boxes[key]) gameHider.hide(boxes[key], key + ' box');
    }
    const row = GAME_ROW_BOXES.map((k) => boxes[k]).filter(Boolean).concat(boxes.spare);
    if (!row.length) return;

    // A press is a 150ms transition on `--press-scale`, which is inside the
    // same `transform` that puts these buttons on their arc — so while one is
    // running, every rectangle below is a moving target. The row is left
    // exactly where it is for those few frames rather than laid out from
    // measurements that will be wrong by the time they are written. This is
    // the placement half of the fix; the sizing half is in gameNaturalSize().
    for (const card of row) if (gameCardAnimating(card)) return;
    // Sized BEFORE the row is measured: a card that has just been scaled
    // reports a different width, and the layout below is built from those
    // widths. Doing it the other way round spaces the row for sizes that no
    // longer exist.
    if (!gameSizeRow(row, boxes.dive)) return;
    const places = row.map(gameRestPlace);
    if (places.some((p) => !(p.w > 8 && p.h > 8))) return;   // mid-relayout

    // The row is anchored where the cluster already sits: its leftmost edge,
    // and the LOWEST row of it — which is the line dive was already on, and
    // the one furthest from the middle of the screen.
    const left = Math.min(...places.map((p) => p.left));
    const top = Math.max(...places.map((p) => p.top));
    const vmin = Math.min(innerWidth, innerHeight);
    const gap = Math.max(6, Math.round(vmin * GAME_ROW_GAP));

    // Laid out from the anchor, each box taking its own width. Evenly spaced
    // by construction rather than by whatever the game's grid left behind.
    let x = left;
    for (let i = 0; i < row.length; i++) {
      gamePlaceCard(row[i], places[i], x, top);
      x += places[i].w + gap;
    }
  }

  // Undoing the above needs one thing the generic hider does not know about:
  // the shift markers, which would otherwise make the next sweep think a card
  // is already where it was put.
  function restoreGameClutter() {
    gameHider.restore();
    try {
      for (const el of document.querySelectorAll('[data-qolc-shift]')) {
        delete el.dataset[GAME_SHIFT_KEY];
      }
      // Sizing is set outside the hider (it records one property per element),
      // so it is given back here rather than by gameHider.restore().
      for (const el of document.querySelectorAll('[data-qolc-scale]')) {
        el.style.removeProperty('scale');
        el.style.removeProperty('transform-origin');
        delete el.dataset[GAME_SIZE_KEY];
      }
    } catch (e) { /* nothing left to clear */ }
  }

  function applyCluttersIfEnabled() {
    if (document.hidden || !settings.masterEnabled) return;
    if (settings.menuClutter) {
      try { applyMenuClutter(); } catch (e) { dbg('menu clutter error', e); }
    }
    if (settings.gameClutter) {
      try { applyGameClutter(); } catch (e) { dbg('game clutter error', e); }
    }
  }

  function startClutterLoop() {
    // Backstop re-apply; structural DOM mutations also trigger a prompt pass,
    // so newly rendered ability buttons still vanish quickly.
    setInterval(() => {
      applyCluttersIfEnabled();
    }, 1000);
  }


  /* ======================== ability cooldown timers ========================
   *
   * mope keeps every cooldown in its HUD store:
   *
   *     cooldowns: {ability1, ability2, dive, arena:
   *                 {startsAt, endsAt, active, disabled}}
   *
   * written from the server's `cooldown` packet as performance.now() times.
   * `active` means the ability is running (the green ring) and `endsAt` is
   * then when it stops; otherwise `endsAt` is when it is ready again. An
   * active ability with no end is a hold ability, shown as ∞.
   *
   * 1.0.x measured mope's animated ring instead, and broke every time mope
   * redrew it (1.0.27 was the two-half-disc rewrite). The store does not
   * change shape when the ring does.
   */

  const CD_SLOTS = [
    {id: 'ability1Button', slot: 'ability1'},
    {id: 'ability2Button', slot: 'ability2'},
    {id: 'diveButton', slot: 'dive'},
  ];
  const CD_MIN_MS = 60;           // a sliver this small is not worth drawing
  const CD_DECIMAL_MS = 3000;     // below this, one decimal
  const CD_TICK_MIN_MS = 30;

  const cooldownUI = {
    layer: null,
    badges: new Map(),   // button id -> badge element
    rafId: 0,
    running: false,
    lastAt: -Infinity,
  };

  function cdFormat(ms) {
    if (!Number.isFinite(ms)) return '∞';
    if (ms > CD_DECIMAL_MS) return String(Math.floor(ms / 1000));
    return (Math.floor(ms / 100) / 10).toFixed(1);
  }

  function cdFontScale(text) {
    if (text.length >= 4) return 0.26;
    if (text.length === 3) return 0.30;
    return 0.36;
  }

  function cdLayer() {
    const layer = cooldownUI.layer;
    if (layer && layer.isConnected) return layer;
    const found = qolcOwnLayer('qolc-cd');
    if (!found) return null;
    if (found !== cooldownUI.layer) cooldownUI.badges.clear();
    cooldownUI.layer = found;
    return found;
  }

  function cdBadgeFor(id) {
    let badge = cooldownUI.badges.get(id);
    if (badge && badge.isConnected) return badge;
    const layer = cdLayer();
    if (!layer) return null;
    badge = document.createElement('div');
    badge.className = 'qolc-cd-badge';
    layer.appendChild(badge);
    cooldownUI.badges.set(id, badge);
    return badge;
  }

  function cdHideAll() {
    for (const badge of cooldownUI.badges.values()) badge.style.display = 'none';
    diveReset();
  }

  function cdSetStyle(el, prop, value) {
    if (el.style[prop] !== value) el.style[prop] = value;
  }

  // {left, active} for a slot: milliseconds to show, and whether the ability
  // is running (green) rather than recharging (white).
  function cdReading(slot, now) {
    const hud = bridge.store('hud');
    const cooldowns = hud && hud.cooldowns;
    const entry = cooldowns && cooldowns[slot];
    if (!entry) return null;
    const endsAt = Number(entry.endsAt) || 0;
    const active = entry.active === true;
    if (active && endsAt <= now) return {left: Infinity, active: true};
    if (endsAt > now) return {left: endsAt - now, active};
    return null;
  }

  /* ----- dive air -----
   *
   * While you are under, the Dive card shows the air you have left, in green.
   * mope keeps oxygen as a 0-100 number on $.animalStats and drains it a step
   * at a time, so the time left is predicted from how fast it has been
   * falling. Each new reading may only nudge the prediction a little, and the
   * readout never counts back up — a timer that jumps is worse than one that
   * is a few hundred milliseconds off. The rate is remembered per animal, so
   * the next dive starts with a good guess.
   */
  const DIVE_MAX_SECS = 600;
  const DIVE_MIN_SPAN_MS = 350;
  const DIVE_NUDGE_CAP_MS = 400;
  const DIVE_NUDGE_SHARE = 0.35;

  const diveUI = {
    first: null, last: null,
    endAt: 0, nudgedAt: 0, shownLeft: 0, shownAt: 0,
    seeded: false,
    rate: 0,          // percent per ms, measured
    rateFor: null,    // and the animal it was measured on
  };

  function diveSpecies() {
    const me = myAnimal();
    return me ? artKeyOf(me) : '';
  }

  function diveReset() {
    diveUI.first = null;
    diveUI.last = null;
    diveUI.endAt = 0;
    diveUI.nudgedAt = 0;
    diveUI.shownLeft = 0;
    diveUI.shownAt = 0;
    diveUI.seeded = false;
  }

  function diveRefine(now) {
    const first = diveUI.first, last = diveUI.last;
    if (!first || !last) return;
    const drop = first.pct - last.pct;
    const span = last.t - first.t;
    if (!(drop > 0) || !(span >= DIVE_MIN_SPAN_MS)) return;
    const predicted = last.t + last.pct * (span / drop);
    if (!(predicted > now) || predicted - now > DIVE_MAX_SECS * 1000) return;
    diveUI.rate = drop / span;
    diveUI.rateFor = diveSpecies();
    if (!diveUI.endAt || diveUI.seeded) {
      diveUI.endAt = predicted;
      if (diveUI.seeded) { diveUI.shownAt = 0; diveUI.shownLeft = 0; }
      diveUI.seeded = false;
    } else {
      const since = now - (diveUI.nudgedAt || now);
      const budget = Math.min(DIVE_NUDGE_CAP_MS, Math.max(60, since * DIVE_NUDGE_SHARE));
      const shift = predicted - diveUI.endAt;
      diveUI.endAt += Math.max(-budget, Math.min(budget, shift));
    }
    diveUI.nudgedAt = now;
  }

  function diveSeed(pct, now) {
    if (diveUI.endAt || !(diveUI.rate > 0)) return;
    if (diveUI.rateFor === null || diveUI.rateFor !== diveSpecies()) return;
    const predicted = now + pct / diveUI.rate;
    if (!(predicted > now) || predicted - now > DIVE_MAX_SECS * 1000) return;
    diveUI.endAt = predicted;
    diveUI.seeded = true;
  }

  function diveNote(pct, now) {
    const last = diveUI.last;
    if (!last) { diveUI.last = {t: now, pct}; diveSeed(pct, now); return; }
    if (pct > last.pct + 0.5) {          // surfaced and refilled
      diveReset();
      diveUI.last = {t: now, pct};
      diveSeed(pct, now);
      return;
    }
    if (pct === last.pct) return;
    diveUI.last = {t: now, pct};
    if (!diveUI.first) { diveUI.first = diveUI.last; return; }
    diveRefine(now);
  }

  // Milliseconds of air left while diving, or null when not under water.
  function diveAirLeft(now) {
    const me = myAnimal();
    const game = bridge.game;
    const oxygen = game && game.animalStats && Number(game.animalStats.oxygen);
    if (!me || !me.diving || !Number.isFinite(oxygen)) { diveReset(); return null; }
    diveNote(oxygen, now);
    if (!diveUI.endAt) return null;
    let left = diveUI.endAt - now;
    if (diveUI.shownAt) {
      const ceiling = diveUI.shownLeft - (now - diveUI.shownAt);
      if (left > ceiling) left = ceiling;
    }
    if (!(left > 0)) left = 0;
    diveUI.shownLeft = left;
    diveUI.shownAt = now;
    return left;
  }

  function cdTick(frameNow) {
    cooldownUI.rafId = 0;
    if (!cooldownUI.running) return;
    cooldownUI.rafId = requestAnimationFrame(cdTick);
    if (document.hidden) return;
    const now = Number.isFinite(frameNow) ? frameNow : performance.now();
    if (now - cooldownUI.lastAt < CD_TICK_MIN_MS) return;
    cooldownUI.lastAt = now;
    const air = inGame() ? diveAirLeft(now) : null;
    for (const {id, slot} of CD_SLOTS) {
      const existing = cooldownUI.badges.get(id);
      const btn = inGame() ? document.getElementById(id) : null;
      const hide = () => { if (existing) existing.style.display = 'none'; };
      if (!btn) { hide(); continue; }
      const rect = btn.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) { hide(); continue; }
      const diving = slot === 'dive' && air != null;
      const reading = diving ? {left: air, active: true} : cdReading(slot, now);
      if (!reading || reading.left <= CD_MIN_MS) { hide(); continue; }
      const badge = existing && existing.isConnected ? existing : cdBadgeFor(id);
      if (!badge) continue;
      const text = cdFormat(reading.left);
      if (badge.textContent !== text) badge.textContent = text;
      badge.classList.toggle('qolc-cd-active', reading.active);
      cdSetStyle(badge, 'display', 'block');
      cdSetStyle(badge, 'left', Math.round(rect.left + rect.width / 2) + 'px');
      cdSetStyle(badge, 'top', Math.round(rect.top + rect.height / 2) + 'px');
      cdSetStyle(badge, 'fontSize',
        Math.max(11, Math.round(rect.height * cdFontScale(text))) + 'px');
    }
  }

  // Its own animation frame rather than the game's frame hook: the badges sit
  // over DOM buttons, and a rAF keeps them ticking on the menu-to-game edge
  // and in the frames before mope's renderer exists.
  function applyAbilityCooldown() {
    const on = settings.masterEnabled && settings.abilityCooldown;
    if (on === cooldownUI.running) return;
    cooldownUI.running = on;
    if (on) {
      injectExtrasStyles();
      cooldownUI.lastAt = -Infinity;
      if (!cooldownUI.rafId) cooldownUI.rafId = requestAnimationFrame(cdTick);
    } else {
      cancelAnimationFrame(cooldownUI.rafId);
      cooldownUI.rafId = 0;
      cdHideAll();
    }
  }

  /* ============== health: damage numbers and your own HP bar ==============
   *
   * Everything here reads the game's own numbers, nothing is measured off the
   * screen. An animal's health is `entity.target.health`, the 0-100 byte the
   * server sends (there is no hit-point figure anywhere in the client), its
   * tier is `entity.tier`, and what is hurting it is `entity.effects` —
   * burning, poisoned, bleeding, frozen, aloed, healing — the same flags mope
   * itself colours the animal's outline from. Yours is `$.player`.
   *
   * 1.0.x had none of that: it found health bars by shape, measured their
   * drawn width (which Pixi reports wrongly under a mask), guessed which bar
   * was yours, and read effects off sprite tints. That is the code that kept
   * breaking.
   */

  // Max HP per tier (index 0 is tier 1). Not in the client — these are
  // community figures, which is why "Hit points" mode is labelled approximate.
  const HP_TIER_MAX = [
    2.5, 2.5,                    // tiers 1-2
    3, 3, 3, 3,                  // tiers 3-6
    4, 4, 4, 4, 4, 4, 4,         // tiers 7-13
    5,                           // tier 14
    5.5,                         // tier 15
    7,                           // tier 16
    12,                          // tier 17
  ];

  // Rare variants whose max HP is known. Every other rare gets no figure
  // rather than a wrong one.
  const HP_SUBSPECIES_BONUS = new Map([
    ['toucan/choco', 0],
    ['toucan/keel_billed', 0],
    ['toucan/fiery', 1],
  ]);
  const HP_UNKNOWN_SPECIES = new Set(['king_dragon']);

  // An animal's max HP, or 0 when it is not known.
  function hpMaxOf(entity) {
    if (!entity) return 0;
    const species = speciesOf(entity);
    if (HP_UNKNOWN_SPECIES.has(species)) return 0;
    const tier = Number(entity.tier);
    const base = tier >= 1 ? HP_TIER_MAX[tier - 1] : 0;
    if (!base) return 0;
    if (!isRareRoll(entity)) return base;
    const bonus = HP_SUBSPECIES_BONUS.get(species + '/' + rareOf(entity));
    return bonus === undefined ? 0 : base + bonus;
  }

  function hpActive() {
    return settings.masterEnabled && settings.hpNumbers;
  }

  function hpBarOn() {
    return hpActive() && settings.hpBar;
  }

  function hpUnitsPercent() {
    return settings.hpUnits !== 'hp';
  }

  function hpBarColour(fraction) {
    if (fraction > 0.6) return '#4ad66d';
    if (fraction > 0.3) return '#ffd60a';
    return '#ff4a3d';
  }

  function hpTickColour(fraction) {
    if (fraction > 0.6) return '#bcffd4';
    if (fraction > 0.3) return '#fff6b8';
    return '#ffc7c0';
  }

  // Your resource meter (water, lava or energy) as a percentage. mope keeps
  // the raw value and its maximum on $.animalStats.
  function resourcePercent() {
    const game = bridge.game;
    const resource = game && game.animalStats && game.animalStats.resource;
    if (!resource) return null;
    const value = Number(resource.value), max = Number(resource.max);
    if (!Number.isFinite(value) || !(max > 0)) return null;
    return value / max * 100;
  }

  /* ----- the floating numbers ----- */

  const HP_WORK_MS = 30;           // a check every 30ms is finer than the server ticks
  const HP_FIGHT_FRACTION = 0.42;  // "near you", as a fraction of the shorter screen side
  const HP_STACK_MS = 700;         // hits on one animal within this window stack
  const HP_STACK_PX = 17;
  const HP_STACK_MAX = 4;
  const HP_MAX_LIVE = 40;          // hard ceiling on numbers on screen at once
  const HP_LIFE_MS = 1100;         // must match the qolc-hp-float animation
  const HP_DRY_PERCENT = 1.5;
  const HP_MIN_DAMAGE_FRACTION = 0.005;   // HP mode: half a point of max is the floor

  const hpState = {
    seen: new WeakMap(),   // entity -> {health, shownAt, stack}
    live: 0,
    layer: null,
    workAt: -Infinity,
    recent: [],            // last few hits, for __lumi.health()
  };

  function hpLayer() {
    let layer = hpState.layer;
    if (layer && layer.isConnected) return layer;
    layer = qolcOwnLayer('qolc-hp');
    hpState.layer = layer;
    hpState.live = 0;
    return layer;
  }

  // What hurt it, in the order the colours are meant to win: fire outranks
  // poison outranks bleed. `effects` is mope's own record of the animal's
  // afflictions, the one it tints the outline from.
  function hpDamageKind(entity, isPlayer) {
    const fx = entity && entity.effects;
    if (fx) {
      if (fx.burning) return 'fire';
      if (fx.poisoned) return 'poison';
      if (fx.bleeding) return 'bleed';
    }
    if (isPlayer) {
      const pct = resourcePercent();
      if (pct != null && pct <= HP_DRY_PERCENT) return 'dry';
    }
    return 'basic';
  }

  function hpFormat(damage, percent) {
    if (percent) return Math.round(damage) + '%';
    const rounded = Math.round(damage * 10) / 10;
    return rounded.toFixed(1).replace(/\.0$/, '');
  }

  function hpShowNumber(x, y, text, kind, isPlayer) {
    const layer = hpLayer();
    if (!layer || hpState.live >= HP_MAX_LIVE) return;
    const el = document.createElement('div');
    el.className = 'qolc-hp-num ' +
      (isPlayer ? (kind === 'basic' ? 'qolc-hp-you' : 'qolc-hp-' + kind) + ' qolc-hp-self'
                : 'qolc-hp-' + kind);
    el.textContent = text;
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
    el.style.fontSize =
      Math.max(15, Math.round(Math.min(innerWidth, innerHeight) * 0.029)) + 'px';
    layer.appendChild(el);
    hpState.live++;
    let done = false;
    const drop = () => {
      if (done) return;
      done = true;
      hpState.live = Math.max(0, hpState.live - 1);
      if (el.parentNode) el.parentNode.removeChild(el);
    };
    el.addEventListener('animationend', drop, {once: true});
    setTimeout(drop, HP_LIFE_MS + 400);
  }

  // Which animals get numbers. You, and animals fighting near you — and in a
  // duel only the two fighters, while outside one, nobody else's duel. That
  // is the 1.0.x rule; the difference is that "you" and "a fighter" are now
  // the game's answer rather than an inference.
  function hpWatched(me, now) {
    const out = [];
    if (!me) return out;
    const duel = me.arena;
    if (duel) {
      for (const fighter of [duel.player1, duel.player2]) {
        if (fighter && fighter.container && !fighter.container.destroyed) out.push(fighter);
      }
      if (out.indexOf(me) === -1) out.push(me);
      return out;
    }
    out.push(me);
    const centre = screenPosOf(me.container, now);
    if (!centre) return out;
    const reach = Math.min(innerWidth, innerHeight) * HP_FIGHT_FRACTION;
    for (const animal of liveAnimals()) {
      if (animal === me || animal.arena) continue;
      const at = screenPosOf(animal.container, now);
      if (!at) continue;
      if (Math.hypot(at.x - centre.x, at.y - centre.y) <= reach) out.push(animal);
    }
    return out;
  }

  function hpNumbersTick(now) {
    const me = myAnimal();
    const percent = hpUnitsPercent();
    for (const animal of hpWatched(me, now)) {
      const health = healthOf(animal);
      if (health == null) continue;
      let seen = hpState.seen.get(animal);
      if (!seen) {
        hpState.seen.set(animal, {health, at: now, shownAt: -Infinity, stack: 0});
        continue;
      }
      // Only a reading from the PREVIOUS tick is a baseline. An animal that
      // was out of range (or the feature was off) took its damage unseen,
      // and showing it all at once on its return would be a hit nobody made.
      const fresh = now - seen.at <= 250;
      const before = seen.health;
      seen.health = health;
      seen.at = now;
      if (!fresh) continue;
      if (!(health < before)) continue;
      const lost = before - health;
      let text;
      if (percent) {
        text = hpFormat(lost, true);
      } else {
        const max = hpMaxOf(animal);
        if (!max) continue;
        const damage = lost / 100 * max;
        if (damage < max * HP_MIN_DAMAGE_FRACTION) continue;
        text = hpFormat(damage, false);
      }
      const isPlayer = animal === me;
      const kind = hpDamageKind(animal, isPlayer);
      // Over the health bar when mope is drawing one, else over the animal.
      const anchor = animal.health && animal.health.container && animal.health.container.parent
        ? animal.health.container : animal.container;
      const at = screenPosOf(anchor, now);
      if (!at) continue;
      seen.stack = now - seen.shownAt < HP_STACK_MS ? Math.min(HP_STACK_MAX, seen.stack + 1) : 0;
      seen.shownAt = now;
      hpShowNumber(at.x, at.y - seen.stack * HP_STACK_PX, text, kind, isPlayer);
      hpState.recent.push({on: isPlayer ? 'you' : 'other', from: before, to: health,
        shown: text, kind, tier: animal.tier, species: speciesOf(animal)});
      if (hpState.recent.length > 10) hpState.recent.shift();
    }
  }

  /* ----- your own health, as a live bar ----- */

  const HP_HUD_BUTTONS = [
    'ability1Button', 'ability2Button', 'dashButton',
    'climbButton', 'diveButton', 'dropButton',
  ];
  const HP_BAR_PAD_X = 9;          // must match the padding in the stylesheet
  const HP_TICK_CSS_WIDTH = 2;
  const HP_RATE_WINDOW_MS = 420;
  const HP_RATE_FAST = 14;         // points per second that count as a fast heal
  const HP_NO_HUD_GRACE_MS = 700;

  const hpBarUI = {
    root: null, track: null, fill: null, ticks: null, text: null,
    shown: false, skinAt: 0, tickKey: '', tickColour: '#bcffd4',
    mood: null, noHudAt: 0, rate: [],
  };

  function hpEnsureBar() {
    if (hpBarUI.root && hpBarUI.root.isConnected) return hpBarUI;
    const host = document.body || document.documentElement;
    if (!host) return null;
    const root = document.getElementById('qolc-hpbar') || document.createElement('div');
    root.id = 'qolc-hpbar';
    root.textContent = '';
    const track = document.createElement('div');
    track.className = 'qolc-hpbar-track';
    const fill = document.createElement('div');
    fill.className = 'qolc-hpbar-fill';
    const ticks = document.createElement('div');
    ticks.className = 'qolc-hpbar-ticks';
    const text = document.createElement('div');
    text.className = 'qolc-hpbar-text';
    track.appendChild(fill);
    track.appendChild(ticks);
    root.appendChild(track);
    root.appendChild(text);
    host.appendChild(root);
    Object.assign(hpBarUI, {root, track, fill, ticks, text, tickKey: ''});
    return hpBarUI;
  }

  // The ability cards, as one box: the bar sits on top of it.
  function hpHudCluster() {
    let left = Infinity, top = Infinity, right = -Infinity;
    for (const id of HP_HUD_BUTTONS) {
      const el = document.getElementById(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (!(r.width > 8 && r.height > 8)) continue;   // hidden cards measure zero
      if (r.left < left) left = r.left;
      if (r.top < top) top = r.top;
      if (r.right > right) right = r.right;
    }
    return left < right ? {left, top, right} : null;
  }

  // Borrow the HUD card's own background so the bar matches whatever skin
  // mope is wearing this season.
  function hpMatchHudSkin(ui, now) {
    if (now - hpBarUI.skinAt < 1000) return;
    hpBarUI.skinAt = now;
    let card = null;
    for (const id of HP_HUD_BUTTONS) {
      const el = document.getElementById(id);
      if (el && el.getBoundingClientRect().width > 8) { card = el; break; }
    }
    if (!card) return;
    try {
      const cs = getComputedStyle(card);
      if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
          ui.root.style.background !== cs.backgroundColor) {
        ui.root.style.background = cs.backgroundColor;
      }
    } catch (e) { /* keep the stylesheet default */ }
  }

  // One mark per whole hit point, in Hit points mode.
  function hpDrawTicks(ui, max, width) {
    const dpr = window.devicePixelRatio || 1;
    const key = max + '@' + width + '@' + dpr;
    if (hpBarUI.tickKey === key) return;
    hpBarUI.tickKey = key;
    while (ui.ticks.firstChild) ui.ticks.removeChild(ui.ticks.firstChild);
    const track = width - HP_BAR_PAD_X * 2;
    if (!(max > 1) || !(track > 8)) return;
    const snap = (v) => Math.round(v * dpr) / dpr;
    const lineWidth = Math.max(1, Math.round(HP_TICK_CSS_WIDTH * dpr)) / dpr;
    for (let hp = 1; hp < max; hp++) {
      const x = snap(hp / max * track);
      if (x <= 0 || x >= track) continue;
      const line = document.createElement('div');
      line.className = 'qolc-hpbar-tick';
      line.style.left = x + 'px';
      line.style.width = lineWidth + 'px';
      line.style.background = hpBarUI.tickColour;
      ui.ticks.appendChild(line);
    }
  }

  function hpPaintTicks(ui, colour) {
    if (hpBarUI.tickColour === colour) return;
    hpBarUI.tickColour = colour;
    const lines = ui.ticks.children;
    for (let i = 0; i < lines.length; i++) lines[i].style.background = colour;
  }

  function hpHideBar() {
    if (hpBarUI.root) {
      if (hpBarUI.root.style.display !== 'none') hpBarUI.root.style.display = 'none';
      if (hpBarUI.root.className) hpBarUI.root.className = '';
    }
    hpBarUI.shown = false;
    hpBarUI.mood = null;
    hpBarUI.rate.length = 0;
  }

  // Points per second over the last ~0.4s; positive while healing.
  function hpNoteRate(pct, now) {
    const history = hpBarUI.rate;
    const last = history[history.length - 1];
    if (!last || Math.abs(last.pct - pct) > 0.01 || now - last.t > 80) history.push({t: now, pct});
    while (history.length > 1 && now - history[0].t > HP_RATE_WINDOW_MS) history.shift();
    if (history.length < 2) return 0;
    const first = history[0], newest = history[history.length - 1];
    const seconds = (newest.t - first.t) / 1000;
    if (!(seconds > 0.05)) return 0;
    return (newest.pct - first.pct) / seconds;
  }

  // The bar's glow: what is happening to you right now.
  function hpBarMood(me, rate) {
    const fx = me.effects || {};
    if (fx.burning) return 'fire';
    if (fx.frozen) return 'frost';
    if (fx.poisoned) return 'poison';
    if (fx.aloed) return rate >= HP_RATE_FAST ? 'aloe-strong' : 'aloe';
    if (fx.healing) return 'gem';
    if (rate >= HP_RATE_FAST) return 'aloe-strong';
    return '';
  }

  function hpBarTick(now) {
    const me = myAnimal();
    if (!hpBarOn() || !me || !inGame()) { hpHideBar(); return; }
    const cluster = hpHudCluster();
    if (!cluster) {
      if (!hpBarUI.noHudAt) hpBarUI.noHudAt = now;
      if (now - hpBarUI.noHudAt > HP_NO_HUD_GRACE_MS) hpHideBar();
      return;
    }
    hpBarUI.noHudAt = 0;
    const percentMode = hpUnitsPercent();
    const max = hpMaxOf(me);
    if (!percentMode && !max) { hpHideBar(); return; }
    // The eased value mope draws its own bar with, so ours moves with it;
    // the server value when mope has not drawn one yet.
    const drawn = me.health && Number(me.health.value);
    const pct = Number.isFinite(drawn) ? drawn : healthOf(me);
    if (pct == null) { hpHideBar(); return; }
    const ui = hpEnsureBar();
    if (!ui) return;
    const rate = hpNoteRate(pct, now);
    const fraction = Math.max(0, Math.min(1, pct / 100));
    let label;
    if (percentMode) {
      label = Math.round(pct) + '%';
    } else {
      const shown = (Math.round(fraction * max * 10) / 10).toFixed(1).replace(/\.0$/, '');
      label = shown + ' / ' + max;
    }
    if (ui.text.textContent !== label) ui.text.textContent = label;
    const width = (fraction * 100).toFixed(1) + '%';
    if (ui.fill.style.width !== width) ui.fill.style.width = width;
    const colour = hpBarColour(fraction);
    if (ui.fill.style.background !== colour) ui.fill.style.background = colour;
    hpPaintTicks(ui, hpTickColour(fraction));
    hpMatchHudSkin(ui, now);
    const mood = hpBarMood(me, rate);
    if (hpBarUI.mood !== mood) {
      hpBarUI.mood = mood;
      ui.root.className = mood ? 'qolc-hpbar-' + mood : '';
    }
    const vmin = Math.min(innerWidth, innerHeight);
    const barWidth = Math.max(140, Math.round(vmin * 0.26));
    const gap = Math.max(11, Math.round(vmin * 0.02));
    hpDrawTicks(ui, percentMode ? 0 : max, barWidth);
    layoutStyle(ui.root, 'width', barWidth + 'px');
    if (!hpBarUI.shown) { ui.root.style.display = 'block'; hpBarUI.shown = true; }
    const own = ui.root.offsetHeight || 34;
    layoutPlace(ui.root, {left: Math.round(cluster.left), top: Math.round(cluster.top - own - gap)});
  }

  function hpFrame(now) {
    if (!hpActive()) { hpHideBar(); return; }
    if (now - hpState.workAt < HP_WORK_MS) return;
    hpState.workAt = now;
    if (inGame()) hpNumbersTick(now);
    hpBarTick(now);
  }

  function setHpUnits(mode) {
    const value = mode === 'hp' ? 'hp' : 'percent';
    if (settings.hpUnits === value) return;
    settings.hpUnits = value;
    store.set('hpUnits', value);
    syncHpUnitsRow();
    dbg('HP units', value);
  }

  function applyHpNumbers() {
    if (!hpActive() || !settings.hpBar) hpHideBar();
  }

  function hpDebug() {
    const me = myAnimal();
    const report = {
      version: VERSION,
      enabled: hpActive(),
      units: hpUnitsPercent() ? 'percent' : 'hit points',
      you: me ? {
        species: speciesOf(me) || '(unknown)',
        rare: rareOf(me) || '(none)',
        tier: me.tier,
        serverHealth: healthOf(me),
        drawnHealth: me.health ? Math.round(me.health.value * 10) / 10 : null,
        maxHp: hpMaxOf(me) || '(unknown — no HP figure for this animal)',
        effects: me.effects ? Object.keys(me.effects).filter((k) => me.effects[k] === true) : [],
      } : '(no animal — not in a game)',
      watching: me ? hpWatched(me, performance.now()).length + ' animal(s)' : 0,
      numbersOnScreen: hpState.live,
      lastHits: hpState.recent.slice(),
    };
    console.log(TAG, 'health', report);
    return report;
  }

  /* ============================== camera zoom ==============================
   *
   * Extras' seat at the shared hub. Extras OWNS the camera when its switch is
   * on (zoomPriority 2); Moderator Extras joins at 1 and defers to it.
   */

  const ZOOM_MEMBER_ID = 'extras';
  const ZOOM_PANEL_SOURCE = 'extras-panel';

  const zoomSeat = zoomHub.join(ZOOM_MEMBER_ID, {
    panelSource: ZOOM_PANEL_SOURCE,
    toastPriority: 1,
    zoomPriority: 2,
    onChange(change) {
      store.set('zoomLevel', change.level);
      syncZoomUI();
    },
    showToast: showZoomToast,
    // While the panel is open its keys belong to the panel; the wheel still
    // zooms unless it is over one of our own surfaces.
    ignoreEvent(event) {
      if (extras && extras.panel && extras.panel.style.display === 'block' &&
          event.type !== 'wheel') return true;
      const target = event.target;
      return !!(target && target.closest && target.closest(QOLC_OWN_UI));
    },
  });

  function zoomActive() {
    return !!settings.masterEnabled && !!settings.cameraZoom;
  }

  function syncZoomSeat() {
    zoomSeat.setActive(zoomActive());
  }

  // 1.0.x kept a copy of the level under maut:zoomLevel; the hub's own key is
  // the real one. A level only the old key holds is carried over once.
  (function migrateStoredZoom() {
    const stored = zoomHub.normalize(store.get('zoomLevel', 1));
    if (stored !== 1 && zoomHub.getLevel() === 1) zoomHub.setLevel(stored, 'migrate');
    syncZoomSeat();
  })();

  // mope's own zoom (`rendering.zoom`) is saved, can only zoom in, and is
  // moved by any notch our hub declines (a touchpad pinch is ctrl+wheel). So
  // while this zoom is on it is held at 1 — written through mope's own
  // settings object, exactly as mope's settings UI would. Left alone when off.
  const nativeZoomHold = {resets: 0, lastUndone: null};

  function holdNativeZoom() {
    if (!zoomActive()) return;
    const proxy = mopeSettingsProxy();
    if (!proxy) return;
    try {
      const rendering = proxy.rendering;
      if (!rendering || typeof rendering !== 'object') return;
      const value = rendering.zoom;
      if (value === 1 || typeof value !== 'number') return;
      rendering.zoom = 1;
      nativeZoomHold.resets += 1;
      nativeZoomHold.lastUndone = value;
      dbg('camera zoom: undid mope\'s own zoom (' + value.toFixed(3) + ' -> 1)');
    } catch (e) { /* never let this break the game's settings */ }
  }
  PAGE.addEventListener('wheel', holdNativeZoom, {passive: true});
  setInterval(holdNativeZoom, 1000);

  /* ----- in-game readout ----- */

  let zoomToast = null;
  let zoomToastTimer = 0;

  function zoomStatusSuffix() {
    if (!settings.masterEnabled) return ' (extras off)';
    if (!settings.cameraZoom) return ' (zoom off)';
    if (!zoomHub.hooked()) return ' (not applied)';
    return '';
  }

  function showZoomToast() {
    try {
      if (!zoomToast || !zoomToast.isConnected) {
        if (!document.body) return false;
        zoomToast = document.getElementById('qolc-zoom') || document.createElement('div');
        zoomToast.id = 'qolc-zoom';
        zoomToast.style.cssText = [
          'position:fixed', 'right:10px', 'bottom:10px', 'z-index:2147483647',
          'pointer-events:none', 'font:12px/1.4 monospace', 'color:#fff',
          'background:rgba(0,0,0,.55)', 'padding:3px 7px', 'border-radius:3px',
          'white-space:nowrap',
        ].join(';');
        document.body.appendChild(zoomToast);
      }
      zoomToast.textContent =
        'View: ' + Math.round(zoomHub.getLevel() * 100) + '%' + zoomStatusSuffix();
      zoomToast.style.display = '';
      clearTimeout(zoomToastTimer);
      zoomToastTimer = setTimeout(() => {
        if (zoomToast) zoomToast.style.display = 'none';
      }, 850);
      return true;
    } catch (e) {
      return false;
    }
  }

  function syncZoomUI() {
    syncZoomSeat();
    if (!extras || !extras.zoomUi) return;
    const refs = extras.zoomUi;
    const hooked = zoomHub.hooked();
    refs.hookRow.classList.toggle('qolc-hook-ok', hooked);
    refs.hookRow.classList.toggle('qolc-hook-bad', !hooked);
    refs.hookNote.textContent = hooked
      ? 'Attached to the game camera'
      : 'Waiting for the game to finish loading';
  }

  function zoomDebug() {
    const report = Object.assign({
      version: VERSION,
      featureEnabled: settings.cameraZoom,
      mopeOwnZoomUndone: nativeZoomHold.resets + ' time(s)' +
        (nativeZoomHold.lastUndone !== null
          ? ', last from ' + nativeZoomHold.lastUndone.toFixed(3) : ''),
    }, zoomHub.status());
    console.table ? console.table(report) : console.log(report);
    return report;
  }

  /* ============================== turn speed ==============================
   *
   * How quickly animals rotate toward the angle the server sent. mope turns
   * every animal inside Animal.update(); this wraps that one method on the
   * class the bridge hands over, scales the step it took, and clamps it so
   * it can never pass the server's angle — a rate setting, never a heading
   * the server did not send. Client-side only: nobody else sees a thing.
   *
   * 1.0.x had to wait for an animal to go through a Map.prototype.set trap to
   * learn which prototype to wrap. The class is simply known now.
   */

  const turnState = {wrapped: null, applied: 0};

  function turnMultiplier() {
    if (!settings.masterEnabled || !settings.turnSpeed) return 1;
    return settings.turnSpeedValue / TURN_NEUTRAL;
  }

  function turnWrapAngle(angle) {
    return Math.atan2(Math.sin(angle), Math.cos(angle));
  }

  function turnShapedMultiplier(multiplier, toTarget) {
    const style = settings.turnStyle;
    if (style === 'linear') return multiplier;
    const closeness = Math.min(Math.abs(toTarget) / Math.PI, 1);
    if (style === 'ease-out') return multiplier * (0.5 + closeness);
    if (style === 'ease-in') return multiplier * (1.5 - closeness);
    return multiplier;
  }

  function turnApply(animal, before) {
    const multiplier = turnMultiplier();
    const instant = settings.masterEnabled && settings.turnSpeed &&
      settings.turnStyle === 'instant';
    if (multiplier === 1 && !instant) return;
    const after = animal.angle;
    const target = animal.target && animal.target.angle;
    if (typeof after !== 'number' || typeof target !== 'number' ||
        typeof before !== 'number') return;
    const toTarget = turnWrapAngle(target - before);
    if (!toTarget) return;
    let step = instant
      ? toTarget
      : turnWrapAngle(after - before) * turnShapedMultiplier(multiplier, toTarget);
    if (toTarget > 0) step = Math.min(Math.max(step, 0), toTarget);
    else step = Math.max(Math.min(step, 0), toTarget);
    if (step === after - before) return;
    animal.angle = before + step;
    // Animal.update() copied the angle onto the body before we got here.
    if (animal.body && typeof animal.body.rotation === 'number') {
      animal.body.rotation = animal.angle;
    }
    turnState.applied += 1;
  }

  function turnInstall() {
    const Animal = bridge.Animal;
    const prototype = Animal && Animal.prototype;
    if (!prototype || turnState.wrapped === prototype) return;
    const original = prototype.update;
    if (typeof original !== 'function') return;
    // Another copy of this script got here first: its wrapper already turns
    // every animal, and a second would apply the multiplier twice.
    if (original.__lumiTurnWrapper) { turnState.wrapped = prototype; return; }
    const wrapper = function () {
      const before = this.angle;
      const result = original.apply(this, arguments);
      try { turnApply(this, before); } catch (e) { /* never break a frame */ }
      return result;
    };
    try { Object.defineProperty(wrapper, '__lumiTurnWrapper', {value: true}); } catch (e) { /* cosmetic */ }
    prototype.update = wrapper;
    turnState.wrapped = prototype;
    dbg('turn speed: Animal.prototype.update wrapped');
  }

  function setTurnSpeed(value) {
    const next = normalizeTurnSpeed(value);
    if (next === settings.turnSpeedValue) return;
    settings.turnSpeedValue = next;
    store.set('turnSpeedValue', next);
    syncTurnUI();
  }

  function setTurnStyle(value) {
    const next = normalizeTurnStyle(value);
    if (next === settings.turnStyle) return;
    settings.turnStyle = next;
    store.set('turnStyle', next);
    syncTurnUI();
  }

  function syncTurnUI() {
    if (!extras || !extras.turnUi) return;
    const refs = extras.turnUi;
    const instant = settings.turnStyle === 'instant';
    refs.level.classList.toggle('qolc-row-off', !settings.turnSpeed || instant);
    refs.styleRow.classList.toggle('qolc-row-off', !settings.turnSpeed);
    refs.value.textContent =
      Math.round(100 * settings.turnSpeedValue / TURN_NEUTRAL) + '%';
    refs.minus.disabled = instant || settings.turnSpeedValue <= TURN_MIN;
    refs.plus.disabled = instant || settings.turnSpeedValue >= TURN_MAX;
    for (const button of refs.styles) {
      button.classList.toggle('active', button.dataset.turnStyle === settings.turnStyle);
    }
  }
  const ARENA_SKY_FADE_MS = 260;
  const ARENA_SKY_WORK_MIN_MS = 60;
  // How far the sky reaches. The camera follows you and you can only be as far
  // from the arena's centre as its radius, so half the screen diagonal plus one
  // arena radius is exactly what has to be covered — with a tenth over for the
  // moment after a resize and before the next rebuild. Sized any larger and the
  // stars are spread thinner over ground nobody will ever look at.
  const ARENA_SKY_MARGIN = 1.1;
  const ARENA_SKY_MIN_SPAN = 1.6;   // of the arena radius, for a very small window
  // Star count follows the AREA rather than being fixed, because the field
  // grows with the screen and a fixed count silently thins out on a big one.
  // One star per this many screen pixels squared; 460 over the whole field was
  // the first attempt and put about fifteen of them on screen.
  const ARENA_SKY_STAR_AREA = 2800;
  const ARENA_SKY_STARS_MIN = 220;
  const ARENA_SKY_STARS_MAX = 1600;
  // Rebuilding is cheap but not free, so it happens on a real change of view
  // rather than on drift.
  const ARENA_SKY_REBUILD_AT = 0.15;
  const ARENA_SKY_CLOUDS = 4;
  const ARENA_SKY_CLOUD_BLOBS = 110;
  // High enough to survive 8-bit rounding, which is the whole reason the
  // colours below are muted instead. See arenaSkyPaint().
  const ARENA_SKY_CLOUD_ALPHA = 0.03;
  const ARENA_SKY_GROUND = 0x05060e;
  // Weighted toward white and blue-white, with a few warm ones. Real skies are
  // mostly colourless at this size and a rainbow of stars reads as confetti.
  const ARENA_SKY_STAR_COLORS = [
    0xffffff, 0xffffff, 0xffffff, 0xeaf1ff, 0xdce9ff,
    0xc3d8ff, 0xfff2dc, 0xffd9b8,
  ];
  // Twelve to twenty-six levels above the ground, no more. The 1.17.1 palette
  // sat seventy above it and every ring boundary showed.
  const ARENA_SKY_CLOUD_COLORS = [0x0d0f28, 0x081627, 0x140a24, 0x091a26, 0x110a1e];
  // The milky way: what share of the stars are pulled onto the band, and how
  // far they scatter either side of it as a fraction of the field.
  const ARENA_SKY_BAND_SHARE = 0.55;
  const ARENA_SKY_BAND_SPREAD = 0.16;
  // Fixed, so the sky is the same one every match rather than being reshuffled
  // on every rebuild — and a rebuild happens whenever the camera zooms, which
  // would otherwise make the whole sky jump.
  const ARENA_SKY_CLOUD_SEED = 0x5eed;
  const ARENA_SKY_STAR_SEED = 0x5eed ^ 0x9e37;

  /* ----- arena themes (1.0.5) -----
   *
   * The backdrop used to be one thing called "the starfield", so its palette
   * lived in module constants and the painter read them directly. There are
   * three of them now, so the constants above became the STARFIELD's values
   * and the painter reads whichever theme is selected. Nothing about the
   * geometry changed: the same generators, the same seeds, the same three star
   * sizes and the same scattered-blob clouds. A theme is a palette and four
   * numbers, which is deliberate — it means a new one cannot introduce a new
   * class of rendering bug, only a new set of colours.
   *
   * The colour rule from arenaSkyPaint() carries over and is the thing to
   * respect when adding more: cloud colours sit TWELVE TO TWENTY-SIX LEVELS
   * from the ground, no further. It is what stops the wash banding, and it is
   * a distance rather than a direction — Antimatter's clouds are that far
   * BELOW a light ground, for exactly the same reason Starfield's are that far
   * above a dark one.
   */
  const ARENA_THEMES = [
    {
      id: 'starfield',
      label: 'Starfield',
      note: 'Deep space. The original, and the default.',
      ground: ARENA_SKY_GROUND,
      cloudColors: ARENA_SKY_CLOUD_COLORS,
      cloudAlpha: ARENA_SKY_CLOUD_ALPHA,
      clouds: ARENA_SKY_CLOUDS,
      cloudBlobs: ARENA_SKY_CLOUD_BLOBS,
      starColors: ARENA_SKY_STAR_COLORS,
      bandShare: ARENA_SKY_BAND_SHARE,
      bandSpread: ARENA_SKY_BAND_SPREAD,
      haloAlpha: 0.13,
    },
    {
      id: 'antimatter',
      label: 'Antimatter',
      note: 'The starfield as a negative — pale ground, dark stars.',
      // A cool near-white rather than pure white: #ffffff under mope's own
      // bright HUD reads as a blown highlight, and the arena wall has nothing
      // left to contrast against.
      ground: 0xeef1f6,
      // Twelve to twenty-six levels BELOW the ground, mirroring the rule.
      cloudColors: [0xe2e5ee, 0xe4e0ea, 0xdee7ea, 0xe7e1e4, 0xdfe4ea],
      cloudAlpha: ARENA_SKY_CLOUD_ALPHA,
      clouds: ARENA_SKY_CLOUDS,
      cloudBlobs: ARENA_SKY_CLOUD_BLOBS,
      // Inverted from the star palette above: mostly neutral ink with a couple
      // of cool and warm shades, so it is not a field of identical dots.
      starColors: [
        0x14171f, 0x14171f, 0x14171f, 0x171c2a, 0x1b2233,
        0x232c42, 0x241c15, 0x2b2118,
      ],
      bandShare: ARENA_SKY_BAND_SHARE,
      bandSpread: ARENA_SKY_BAND_SPREAD,
      // A dark halo on a light ground is far more visible than a light one on
      // dark, so it is pulled back or the bright stars read as smudges.
      haloAlpha: 0.07,
    },
    {
      id: 'water',
      label: 'Deep Water',
      note: 'Sunlit depths. Pale motes on blue-green, no star band.',
      ground: 0x04222a,
      // The caustic wash. Same twelve-to-twenty-six rule, biased green-blue.
      cloudColors: [0x0a3138, 0x073540, 0x0d3a3a, 0x06303c, 0x0b3644],
      // Slightly stronger than the starfield's, because a wash IS the theme
      // here rather than a backing texture behind stars.
      cloudAlpha: 0.045,
      clouds: 5,
      cloudBlobs: 130,
      // Suspended particles catching the light, not stars.
      starColors: [
        0xbdf3ea, 0xa6ece2, 0x8fe3da, 0xd6f7f1, 0x9fe8f2,
        0xb8f0e4, 0xcdf5ef, 0x86ddd6,
      ],
      // NO BAND. The milky way is the one piece of the starfield that is
      // unmistakably sky, and a diagonal seam of motes underwater reads as a
      // rendering fault rather than as a feature.
      bandShare: 0,
      bandSpread: 0,
      haloAlpha: 0.10,
    },
  ];

  function arenaThemeOf() {
    const want = String(settings.arenaTheme || '');
    for (const t of ARENA_THEMES) if (t.id === want) return t;
    return ARENA_THEMES[0];
  }

  /* ----- the HUD corner, while the sky is up ----- */

  // A culled arena leaves mope's top-right corner looking abandoned. The
  // minimap is not drawn, but `#minimap` is a real div holding 23 by 21dvmin of
  // nothing, so the settings gear beside it is pushed a whole minimap's width
  // in from the edge and the FPS/ping/players block below it is stranded in
  // mid-air. Neither is wrong exactly; they are just laid out around something
  // that is no longer there.
  //
  // So while the sky is up: the empty minimap box is collapsed, which puts the
  // gear back in the corner on its own, and the stats block is moved to the
  // opposite corner where there is nothing else to argue with.
  //
  // Done with ONE class on <html> and static CSS rather than by writing inline
  // styles onto mope's elements. Svelte rebuilds that corner whenever the HUD
  // changes and would drop anything written onto the nodes; a rule keyed on an
  // ancestor survives every rebuild for free, and taking the class off restores
  // the lot in one assignment with nothing to remember.
  const ARENA_HUD_CLASS = 'qolc-arena-hud';
  const ARENA_STAR_CLASS = 'qolc-arena-star';

  const arenaHud = {
    on: false,
    star: null,      // the third-party button we restyled, if we found one
    starWhy: 'not looked for yet',
    statsLeft: -1,   // where the stats block actually landed, measured
  };

  // `position: fixed` is relative to the viewport UNLESS an ancestor carries a
  // transform, filter or perspective, in which case it is relative to THAT —
  // and mope's HUD is not ours to make promises about. So where the block
  // actually ended up is measured rather than assumed, and reported.
  function arenaHudMeasure() {
    const stats = document.getElementById('gameStats');
    if (!stats) { arenaHud.statsLeft = -1; return; }
    try { arenaHud.statsLeft = Math.round(stats.getBoundingClientRect().left); }
    catch (e) { arenaHud.statsLeft = -1; }
  }

  // The button another extension parks under mope's settings gear. It is put
  // there as an extra child of mope's own `#mapSideButtons`, which makes it
  // findable without guessing at coordinates: it is the child that is not one
  // of the three mope itself puts there.
  //
  // Nothing about what the button DOES is touched — this is a mask and a
  // colour, both on our own class, both gone the moment the class is.
  const ARENA_MOPE_SIDE_BUTTONS = ['settingsButton2', 'chatButton', 'zoomLockButton'];

  function arenaFindExtraButton() {
    const host = document.getElementById('mapSideButtons');
    if (!host) { arenaHud.starWhy = 'no #mapSideButtons in the HUD'; return null; }
    for (const kid of host.children) {
      if (!kid || ARENA_MOPE_SIDE_BUTTONS.indexOf(kid.id) !== -1) continue;
      if (kid.closest && kid.closest(QOLC_OWN_UI)) continue;
      arenaHud.starWhy = 'found: ' + (kid.id || kid.className || kid.tagName);
      return kid;
    }
    arenaHud.starWhy = 'nothing there but mope\'s own buttons';
    return null;
  }

  function arenaHudApply(on) {
    const root = document.documentElement;
    if (!root) return;
    const want = !!on;
    if (arenaHud.on === want && root.classList.contains(ARENA_HUD_CLASS) === want) {
      // Re-found each time it is wanted, because the other extension's button
      // can be added, removed or rebuilt at any point in a session.
      if (want && (!arenaHud.star || !arenaHud.star.isConnected)) arenaHudStar(true);
      return;
    }
    arenaHud.on = want;
    root.classList.toggle(ARENA_HUD_CLASS, want);
    arenaHudStar(want);
    if (want) arenaHudMeasure(); else arenaHud.statsLeft = -1;
  }

  function arenaHudStar(on) {
    // The old one is always cleared first, even when turning on: the button may
    // have been rebuilt underneath us and the class left on a detached node.
    if (arenaHud.star) {
      try { arenaHud.star.classList.remove(ARENA_STAR_CLASS); } catch (e) {}
      arenaHud.star = null;
    }
    if (!on) { arenaHud.starWhy = 'off'; return; }
    const button = arenaFindExtraButton();
    if (!button) return;
    try { button.classList.add(ARENA_STAR_CLASS); arenaHud.star = button; }
    catch (e) { arenaHud.starWhy = 'could not restyle it: ' + e; }
  }

  /* ----- the sky itself ----- */

  // A seeded generator. Two of them are used — see the seeds above for why the
  // sky has to come out the same every time.
  function arenaSkyRandom(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Drawn in the arena's own world units. `unit` is how many of them go into
  // one screen pixel, so anything that should have a fixed apparent size is
  // written in pixels and multiplied by it.
  //
  // Every shape is its own beginPath/fill/closePath, which is the same way mope
  // draws its arena walls — one path per shape is what the engine's batcher
  // wants, and a single path holding two thousand circles would be one fill
  // rule fighting itself.
  //
  // WHY THE NEBULAE ARE A SPRAY. 1.17.1 built them as ten concentric circles
  // at 3.5% each, faking a gradient out of stacked outlines — and those
  // outlines are visible. Measured across a smooth patch of sky, neighbouring
  // pixels stepped six luminance levels at a ring boundary, which is what read
  // as banding.
  //
  // The obvious fix does not work, and it is worth writing down why. Splitting
  // each cloud into forty-eight rings at 0.7% rendered COMPLETELY FLAT: a layer
  // whose alpha times the colour delta lands under one 8-bit level contributes
  // nothing at all, so the clouds did not soften, they ceased to exist. More,
  // fainter steps can never smooth a gradient below the quantisation floor.
  //
  // So it goes the other way round. Each blob stays opaque enough to register
  // (3%), and the COLOUR is pulled close to the ground instead — the whole wash
  // is now about twelve luminance levels deep rather than forty-four, and the
  // worst neighbour step is three, which is one level per channel and cannot be
  // seen. On top of that the blobs are scattered rather than concentric, so
  // there is no ring geometry left to band in the first place.
  function arenaSkyPaint(g, span, unit, stars) {
    const T = arenaThemeOf();
    g.clear();

    // The ground. Opaque, and square rather than circular: it has to cover the
    // corners of the screen, and the arena's own floor is the round part.
    g.beginPath();
    g.rect(-span, -span, span * 2, span * 2);
    g.fill({color: T.ground, alpha: 1});
    g.closePath();

    // Two generators rather than one, seeded exactly as the render that was
    // chosen from was: the clouds and the stars then come out as they did
    // there, and neither can shift the other by consuming a different number
    // of rolls.
    const cloudRnd = arenaSkyRandom(ARENA_SKY_CLOUD_SEED);
    for (let i = 0; i < T.clouds; i++) {
      const cx = (cloudRnd() * 2 - 1) * span * 0.7;
      const cy = (cloudRnd() * 2 - 1) * span * 0.7;
      const r = span * (0.24 + cloudRnd() * 0.26);
      const color = T.cloudColors[
        (cloudRnd() * T.cloudColors.length) | 0];
      for (let k = 0; k < T.cloudBlobs; k++) {
        // Raising the roll to a power pulls the scatter inward, so blobs pile
        // up in the middle and thin out at the rim. THAT is the gradient —
        // made out of how many of them happen to overlap rather than out of
        // stacked outlines, which is why it has no edges to band on.
        const t = Math.pow(cloudRnd(), 1.6);
        const ang = cloudRnd() * Math.PI * 2;
        const d = t * r;
        g.beginPath();
        g.circle(cx + Math.cos(ang) * d, cy + Math.sin(ang) * d,
          r * (0.14 + cloudRnd() * 0.2));
        g.fill({color, alpha: T.cloudAlpha});
        g.closePath();
      }
    }

    // Stars, in three sizes. The faint ones carry the depth, the bright ones
    // carry the character, and there are far more of the first than the last
    // for the same reason there are in a real sky.
    const starRnd = arenaSkyRandom(ARENA_SKY_STAR_SEED);
    for (let i = 0; i < stars; i++) {
      let x = (starRnd() * 2 - 1) * span;
      let y = (starRnd() * 2 - 1) * span;
      // The milky way, and the one piece of this that cannot band by
      // construction: it is made of stars, not of fills. Over half of them are
      // pulled onto a diagonal, and the scatter either side is three rolls
      // added together rather than one — which gives the band a dense core and
      // soft edges instead of straight sides.
      if (T.bandShare > 0 && starRnd() < T.bandShare) {
        const along = (starRnd() * 2 - 1) * span;
        const off = (starRnd() + starRnd() + starRnd() - 1.5) *
          span * T.bandSpread;
        x = along * 0.92 - off * 0.38;
        y = along * 0.38 + off * 0.92;
      }
      const roll = starRnd();
      let px, alpha;
      if (roll < 0.72) {           // faint
        px = 0.7 + starRnd() * 0.4;
        alpha = 0.42 + starRnd() * 0.3;
      } else if (roll < 0.94) {    // middling
        px = 1.2 + starRnd() * 0.6;
        alpha = 0.68 + starRnd() * 0.26;
      } else {                     // bright
        px = 2 + starRnd() * 1;
        alpha = 0.92 + starRnd() * 0.08;
      }
      const color = T.starColors[
        (starRnd() * T.starColors.length) | 0];
      g.beginPath();
      g.circle(x, y, px * unit);
      g.fill({color, alpha});
      g.closePath();
      // The brightest few get a halo, which is what stops them reading as
      // slightly larger dots and starts them reading as stars.
      if (roll >= 0.985) {
        g.beginPath();
        g.circle(x, y, px * 2.6 * unit);
        g.fill({color, alpha: T.haloAlpha});
        g.closePath();
      }
    }
  }


  /* ----- where the arena is -----
   *
   * `$.player.arena` is your duel, set by mope the moment you are one of the
   * two fighters and cleared when it ends. It owns its geometry —
   * container, base (the floor sprite, on the `arenaBase` render layer),
   * walls, the two labels that carry "Bites: N", timer and message — and its
   * two fighters, player1 and player2. 1.0.x found all of this by shape and
   * decided whether you were in it from your nameplate's visibility; none of
   * that is needed now, and a stranger's arena can never be mistaken for
   * yours because the game says which one is yours.
   */

  // The world is drawn in the arena container's frame; its scale on screen
  // and its radius in world units are what the sky is sized from.
  function arenaMine() {
    const me = myAnimal();
    const arena = me && me.arena;
    if (!arena || typeof arena !== 'object') return null;
    const node = arena.container;
    const base = arena.base;
    if (!node || node.destroyed || !node.parent || !base || base.destroyed) return null;
    const wt = node.worldTransform;
    if (!wt) return null;
    const scale = Math.hypot(Number(wt.a) || 0, Number(wt.b) || 0);
    const worldRadius = Number(base.width) / 2;
    if (!(scale > 0) || !(worldRadius > 0)) return null;
    return {
      arena, node, base, walls: arena.walls,
      labels: [arena.textPlayer1, arena.textPlayer2, arena.timer, arena.message],
      fighters: [arena.player1, arena.player2].filter(Boolean),
      scale, worldRadius,
    };
  }

  // In a game as a player — not on the menu, not spectating somebody else.
  function arenaPlaying() {
    return inGame();
  }

  /* ----- mope's own Arena Culling ----- */

  const MOPE_CULL_SHOW = 0;
  const MOPE_CULL_HIDE = 1;

  function mopeCullingValue() {
    const proxy = mopeSettingsProxy();
    try {
      const arena = proxy && proxy.gameplay && proxy.gameplay.arena;
      if (!arena) return -1;
      const value = arena.outsideWorld;
      return value === MOPE_CULL_HIDE ? MOPE_CULL_HIDE
        : value === MOPE_CULL_SHOW ? MOPE_CULL_SHOW : -1;
    } catch (e) { return -1; }
  }

  // Written through mope's settings object and read back, so a write that
  // did not take reports as failed rather than as done. mope persists it.
  function mopeWriteCulling(want) {
    const proxy = mopeSettingsProxy();
    try {
      const arena = proxy && proxy.gameplay && proxy.gameplay.arena;
      if (!arena) return false;
      if (arena.outsideWorld !== want) arena.outsideWorld = want;
    } catch (e) { return false; }
    return mopeCullingValue() === want;
  }

  // The theme needs mope's Arena Culling on (HIDE), or the world is drawn
  // over the sky. It is YOUR mope setting, though, so whatever it was before
  // the theme first changed it is remembered (across reloads) and put back
  // when the theme goes off — by its own switch or the master switch —
  // rather than forced to SHOW.
  function mopeSetCulling(hide) {
    if (hide) {
      if (store.get('cullingBeforeTheme', null) === null) {
        const current = mopeCullingValue();
        if (current === MOPE_CULL_HIDE || current === MOPE_CULL_SHOW) {
          store.set('cullingBeforeTheme', current);
        }
      }
      return mopeWriteCulling(MOPE_CULL_HIDE);
    }
    const saved = store.get('cullingBeforeTheme', null);
    if (saved === null) return true;
    const ok = mopeWriteCulling(saved === MOPE_CULL_HIDE ? MOPE_CULL_HIDE : MOPE_CULL_SHOW);
    if (ok) store.set('cullingBeforeTheme', null);
    return ok;
  }

  /* ----- the sky ----- */

  const arenaSky = {
    node: null,       // our Graphics
    host: null,       // the arena container it hangs off
    layer: null,      // the RenderLayer it is attached to
    shownAt: 0,
    builtSpan: 0,
    builtUnit: 0,
    builtStars: 0,
    alignedFor: null, // the arena whose culling has been set to match
    why: 'off',
  };

  function arenaSkyOn() {
    return settings.masterEnabled && settings.arenaSky;
  }

  function arenaSkyLit() {
    return !!(arenaSky.node && arenaSky.node.parent);
  }

  function arenaSkyDetach(why) {
    arenaHudApply(false);
    hpEdgeClearAll();
    arenaSky.why = why || 'off';
    const node = arenaSky.node;
    const layer = arenaSky.layer;
    Object.assign(arenaSky, {node: null, host: null, layer: null, builtSpan: 0,
      builtUnit: 0, alignedFor: null, shownAt: 0});
    if (!node) return;
    try { if (layer && typeof layer.detach === 'function') layer.detach(node); } catch (e) {}
    try { if (node.parent) node.parent.removeChild(node); } catch (e) {}
    try { if (typeof node.destroy === 'function') node.destroy(); } catch (e) {}
  }

  // Two attachments, both needed: a CHILD of the arena container for its
  // transform, and attached to the floor's RenderLayer for its depth — which
  // puts it above all terrain and below every animal. If the floor is not on
  // a layer there is no safe depth left (the only other one is above the
  // fighters), so it refuses to draw rather than cover them.
  function arenaSkyAttach(mine) {
    const layer = mine.base.parentRenderLayer;
    if (arenaSky.node && !arenaSky.node.destroyed && arenaSky.host === mine.node &&
        arenaSky.node.parent === mine.node && arenaSky.layer === layer &&
        arenaSky.node.parentRenderLayer === layer) {
      return arenaSky.node;
    }
    arenaSkyDetach('re-attaching');
    if (!layer || layer.destroyed || typeof layer.attach !== 'function' ||
        typeof layer.detach !== 'function') {
      arenaSky.why = 'the arena floor is not on a render layer — refusing to ' +
        'draw, since the only other depth available is above the fighters';
      return null;
    }
    const Graphics = mine.walls && mine.walls.constructor;
    let node = null;
    try { if (typeof Graphics === 'function') node = new Graphics(); }
    catch (e) { arenaSky.why = 'could not build a Graphics: ' + e; return null; }
    if (!node) { arenaSky.why = 'could not build a Graphics'; return null; }
    try {
      node.__lumiArenaSky = true;
      node.alpha = 0;
      mine.node.addChild(node);
      layer.attach(node);
    } catch (e) {
      arenaSky.why = 'could not place the sky: ' + e;
      try { layer.detach(node); } catch (e2) {}
      try { if (node.parent) node.parent.removeChild(node); } catch (e2) {}
      try { node.destroy(); } catch (e2) {}
      return null;
    }
    Object.assign(arenaSky, {node, host: mine.node, layer, shownAt: 0});
    return node;
  }

  function arenaSkyTick(mine, now) {
    if (!arenaSkyOn() || !arenaPlaying() || document.hidden) {
      const idle = !arenaSkyOn() ? 'off' : !arenaPlaying() ? 'not playing' : 'tab hidden';
      if (arenaSky.node) arenaSkyDetach(idle); else { arenaHudApply(false); arenaSky.why = idle; }
      return;
    }
    if (!mine) {
      if (arenaSky.node) arenaSkyDetach('not in a duel'); else { arenaHudApply(false); arenaSky.why = 'not in a duel'; }
      return;
    }
    const node = arenaSkyAttach(mine);
    if (!node) { arenaHudApply(false); return; }
    if (arenaSky.alignedFor !== mine.node) {
      arenaSky.alignedFor = mine.node;
      if (mopeCullingValue() !== MOPE_CULL_HIDE) mopeSetCulling(true);
    }
    const view = canvasRect(now);
    const scrW = view ? view.w : innerWidth;
    const scrH = view ? view.h : innerHeight;
    const unit = 1 / mine.scale;
    const halfDiag = Math.hypot(scrW, scrH) / 2;
    const span = Math.max(mine.worldRadius * ARENA_SKY_MIN_SPAN,
      mine.worldRadius + halfDiag * unit * ARENA_SKY_MARGIN);
    const fieldPx = span * 2 * mine.scale;
    const stars = Math.max(ARENA_SKY_STARS_MIN,
      Math.min(ARENA_SKY_STARS_MAX, Math.round((fieldPx * fieldPx) / ARENA_SKY_STAR_AREA)));
    if (!arenaSky.builtSpan ||
        Math.abs(span - arenaSky.builtSpan) > arenaSky.builtSpan * ARENA_SKY_REBUILD_AT ||
        Math.abs(unit - arenaSky.builtUnit) > arenaSky.builtUnit * ARENA_SKY_REBUILD_AT) {
      arenaSkyPaint(node, span, unit, stars);
      arenaSky.builtSpan = span;
      arenaSky.builtUnit = unit;
      arenaSky.builtStars = stars;
    }
    if (!arenaSky.shownAt) arenaSky.shownAt = now;
    const alpha = Math.min(1, (now - arenaSky.shownAt) / ARENA_SKY_FADE_MS);
    if (node.alpha !== alpha) node.alpha = alpha;
    arenaSky.why = 'drawing';
    arenaHudApply(true);
    hpEdgeTick(mine);
  }

  function arenaSkySet(on, source) {
    settings.arenaSky = !!on;
    store.set('arenaSky', settings.arenaSky);
    const culled = mopeSetCulling(settings.arenaSky);
    if (!arenaSkyOn()) arenaSkyDetach('off');
    syncArenaSkyRow();
    if (source === 'hotkey' && arenaPlaying()) {
      qolcToast(
        (settings.arenaSky ? 'Arena starfield on' : 'Arena starfield off') +
          (culled ? '' : ' — Arena Culling unavailable'),
        culled ? 'is-info' : 'is-bad');
    }
    dbg('arena theme', settings.arenaSky ? 'on' : 'off', source);
  }

  /* ----- the missing-health outline -----
   *
   * mope's health bar is a dark plate with a coloured fill. On the starfield
   * the plate disappears, so a fighter at 40% looks like a short bar rather
   * than a bar that is 60% empty. While the sky is drawn, each fighter's bar
   * gets a faint white outline of its full length.
   */
  const hpEdges = new Map();   // fighter entity -> our Graphics

  // mope's bar: a 30 x 7 plate centred on health.container, corners 2.5 when
  // rounded corners are on. Read off the entity rather than assumed.
  function healthBarBox(entity) {
    const health = entity && entity.health;
    if (!health || !health.container || health.container.destroyed) return null;
    const size = health.size;
    const w = size && Number(size.x) > 0 ? Number(size.x) : 30;
    const h = size && Number(size.y) > 0 ? Number(size.y) : 7;
    let rounded = true;
    try { rounded = !!mopeSettingsProxy().rendering.roundedCorners; } catch (e) { /* default */ }
    return {container: health.container, Graphics: health.wrapper && health.wrapper.constructor,
      w, h, r: rounded ? 2.5 : 0};
  }

  function drawBox(g, box, width) {
    if (box.r > 0 && typeof g.roundRect === 'function') g.roundRect(0, 0, width, box.h, box.r);
    else g.rect(0, 0, width, box.h);
  }

  function hpEdgeTick(mine) {
    const live = new Set(mine.fighters);
    for (const [entity, node] of hpEdges) {
      if (live.has(entity) && node.parent && !node.destroyed) continue;
      try { if (node.parent) node.parent.removeChild(node); node.destroy(); } catch (e) {}
      hpEdges.delete(entity);
    }
    for (const fighter of mine.fighters) {
      if (hpEdges.has(fighter)) continue;
      const box = healthBarBox(fighter);
      if (!box || typeof box.Graphics !== 'function') continue;
      let node = null;
      try {
        node = new box.Graphics();
        node.__lumiHpEdge = true;
        node.pivot.set(box.w / 2, box.h / 2);
        drawBox(node, box, box.w);
        node.stroke({color: 0xffffff, alpha: 0.5, width: 0.7});
        box.container.addChild(node);
        hpEdges.set(fighter, node);
      } catch (e) {
        try { if (node) { if (node.parent) node.parent.removeChild(node); node.destroy(); } } catch (e2) {}
      }
    }
  }

  function hpEdgeClearAll() {
    for (const node of hpEdges.values()) {
      try { if (node.parent) node.parent.removeChild(node); node.destroy(); } catch (e) {}
    }
    hpEdges.clear();
  }

  /* ----- draw order -----
   *
   * Moves ONLY your animal onto a dedicated RenderLayer placed just above (or
   * below) the highest (or lowest) layer any animal is drawn on. Nobody
   * else's draw list is touched. Restored with mope's own updateLayer(),
   * which puts the animal back wherever mope wants it right now (diving,
   * flying, in an arena).
   */
  const zorder = {
    mode: settings.zorderMode,   // 0 off, 1 above everything, -1 below everything
    api: '',
    layers: 0,
    home: null,
    homeFor: null,     // the animal entity that home belongs to
    layer: null,       // the one layer this feature owns
    applied: 0,
  };

  function zorderOn() { return settings.masterEnabled && zorder.mode !== 0; }

  function zorderRank(layer) {
    try {
      const kids = layer && layer.parent && layer.parent.children;
      return kids && typeof kids.indexOf === 'function' ? kids.indexOf(layer) : -1;
    } catch (e) { return -1; }
  }

  function zorderMove(obj, to) {
    if (!obj || obj.destroyed || !to || to.destroyed || typeof to.attach !== 'function') return false;
    const from = obj.parentRenderLayer;
    if (from === to) return true;
    if (from && typeof from.detach !== 'function') return false;
    try {
      if (from) from.detach(obj);
      to.attach(obj);
      if (obj.parentRenderLayer !== to) throw Error('layer did not accept the animal');
      return true;
    } catch (e) {
      try { if (typeof to.detach === 'function') to.detach(obj); } catch (ignored) {}
      try { if (from && !from.destroyed) from.attach(obj); } catch (ignored) {}
      frameFailed('draw order move', e);
      return false;
    }
  }

  function zorderApply() {
    if (!zorderOn()) { if (zorder.homeFor || zorder.layer) zorderRestore(); return; }
    const me = myAnimal();
    if (zorder.homeFor && zorder.homeFor !== me) zorderRestore();
    const node = me && me.container;
    if (!node || node.destroyed || !node.parent) {
      zorder.api = 'waiting for your animal'; zorder.applied = 0; return;
    }
    if (node.parentRenderLayer !== zorder.layer) {
      zorder.homeFor = me;
      zorder.home = node.parentRenderLayer;
    }
    const home = zorder.home;
    const parent = home && home.parent;
    if (!parent || typeof parent.addChildAt !== 'function' ||
        typeof parent.setChildIndex !== 'function') {
      zorder.api = 'waiting for an animal render layer'; return;
    }
    // Every layer an animal is drawn on, under the same parent.
    const pool = [];
    const add = (layer) => {
      if (!layer || layer === zorder.layer || layer.destroyed || layer.parent !== parent) return;
      if (typeof layer.attach !== 'function') return;
      if (!pool.some((row) => row.layer === layer)) pool.push({layer, rank: zorderRank(layer)});
    };
    add(home);
    for (const animal of liveAnimals()) add(animal.container.parentRenderLayer);
    const ranked = pool.filter((row) => row.rank >= 0);
    if (!ranked.length) { zorder.api = 'waiting for comparable animal render layers'; return; }
    let target = ranked[0];
    for (const row of ranked) {
      if (zorder.mode > 0 ? row.rank > target.rank : row.rank < target.rank) target = row;
    }
    if (zorder.layer && (zorder.layer.destroyed || zorder.layer.parent !== parent)) {
      zorderRestore();
      zorder.homeFor = me; zorder.home = node.parentRenderLayer;
    }
    if (!zorder.layer) {
      const layer = new home.constructor();
      if (typeof layer.attach !== 'function' || typeof layer.detach !== 'function') {
        if (typeof layer.destroy === 'function') layer.destroy();
        zorder.api = 'render layer constructor unavailable'; return;
      }
      layer.__lumiZOrder = true;
      parent.addChildAt(layer, parent.children.indexOf(target.layer));
      zorder.layer = layer;
    }
    const layer = zorder.layer;
    const without = parent.children.filter((child) => child !== layer);
    const index = without.indexOf(target.layer) + (zorder.mode > 0 ? 1 : 0);
    if (parent.children.indexOf(layer) !== index) parent.setChildIndex(layer, index);
    zorder.applied = zorderMove(node, layer) ? 1 : 0;
    zorder.layers = ranked.length;
    zorder.api = zorder.applied ? 'dedicated layer beside the animal layers'
      : 'layer move failed; restored native layer';
  }

  function zorderRestore() {
    const me = zorder.homeFor;
    const node = me && me.container;
    const layer = zorder.layer;
    if (node && !node.destroyed && node.parent && node.parentRenderLayer === layer) {
      try { if (typeof me.updateLayer === 'function') me.updateLayer(); }
      catch (e) { frameFailed('draw order restore', e); }
      if (node.parentRenderLayer === layer && !zorderMove(node, zorder.home)) return;
    }
    if (layer && !layer.destroyed) {
      try { if (layer.parent) layer.parent.removeChild(layer); layer.destroy(); }
      catch (e) { frameFailed('draw order cleanup', e); return; }
    }
    Object.assign(zorder, {layer: null, home: null, homeFor: null, applied: 0});
  }

  function zorderSet(mode, source) {
    const want = zorder.mode === mode ? 0 : mode;
    zorder.mode = want;
    zorder.api = '';
    settings.zorderMode = want;
    store.set('zorderMode', want);
    syncZorderRows();
    qolcToast(want > 0 ? 'Drawing above other players'
      : want < 0 ? 'Drawing below other players'
      : 'Draw order back to normal', want ? '' : 'quiet');
    dbg('draw order', want, source);
    if (want) zorderApply(); else zorderRestore();
  }

  /* ----- duels: focus mode, the bite indicator, the boost counter ----- */

  const arenaDuel = {
    active: false,
    mine: null,
    since: 0,
  };

  function arenaFocusOn() {
    return settings.masterEnabled && settings.arenaFocus;
  }

  // Focus mode hides party dots, tags, list and chat during your own duel;
  // publishing continues, so the party still sees you.
  function arenaFocusHiding() {
    return arenaFocusOn() && arenaDuel.active;
  }

  function arenaFocusEnter() {
    if (!arenaFocusOn()) return;
    if (partyChat.open) partyChatCloseInput();
  }

  function biteOn() {
    return settings.masterEnabled && settings.biteIndicator;
  }

  function boostOn() {
    return settings.masterEnabled && settings.boostCounter;
  }

  /* The bite indicator. A bitten fighter cannot be bitten again for three
   * seconds (measured: 21 bites, 2026-08-28). mope shows bites only as a
   * running count on the arena labels, so a count going up is matched to the
   * fighter whose health dropped at the same moment, and that fighter's bar
   * gets a purple mark that shrinks away over the three seconds. */
  const BITE_IMMUNE_MS = 3000;
  const BITE_MATCH_MS = 320;
  const BITE_MARK_COLOR = 0x9b30ff;
  const BITE_MARK_STEPS = 60;

  const bite = {
    arena: null,
    score1: -1,
    score2: -1,
    health: new Map(),     // fighter -> last health
    pending: [],           // {at} — counts that went up, awaiting a victim
    marked: new Map(),     // fighter -> {until, node, drawn}
    bites: 0,
    unmatched: 0,
  };

  function biteScoreOf(label) {
    const text = label && typeof label.text === 'string' ? label.text : '';
    const m = /Bites:\s*(\d+)/.exec(text);
    return m ? Number(m[1]) : -1;
  }

  function biteMarkDetach(mark) {
    const node = mark && mark.node;
    if (!node) return;
    mark.node = null;
    try { if (node.parent) node.parent.removeChild(node); } catch (e) {}
    try { node.destroy(); } catch (e) {}
  }

  function biteClearAll() {
    for (const mark of bite.marked.values()) biteMarkDetach(mark);
    bite.marked.clear();
    bite.pending.length = 0;
  }

  function biteMark(fighter, now) {
    bite.bites++;
    const mark = bite.marked.get(fighter);
    if (mark) { mark.until = now + BITE_IMMUNE_MS; mark.drawn = -1; return; }
    bite.marked.set(fighter, {until: now + BITE_IMMUNE_MS, node: null, drawn: -1});
  }

  function bitePaint(now) {
    for (const [fighter, mark] of bite.marked) {
      if (now >= mark.until) { biteMarkDetach(mark); bite.marked.delete(fighter); continue; }
      const box = healthBarBox(fighter);
      if (!box || typeof box.Graphics !== 'function') { biteMarkDetach(mark); continue; }
      if (mark.node && mark.node.parent !== box.container) biteMarkDetach(mark);
      if (!mark.node) {
        try {
          const node = new box.Graphics();
          node.__lumiBiteMark = true;
          node.pivot.set(box.w / 2, box.h / 2);
          box.container.addChild(node);
          mark.node = node;
          mark.drawn = -1;
        } catch (e) { continue; }
      }
      const step = Math.max(0, Math.min(BITE_MARK_STEPS,
        Math.round((mark.until - now) / BITE_IMMUNE_MS * BITE_MARK_STEPS)));
      if (mark.drawn === step) continue;
      mark.drawn = step;
      try {
        mark.node.clear();
        if (step > 0) {
          drawBox(mark.node, box, Math.max(0.01, box.w * step / BITE_MARK_STEPS));
          mark.node.fill({color: BITE_MARK_COLOR, alpha: 1});
        }
      } catch (e) { biteMarkDetach(mark); }
    }
  }

  function biteTick(mine, now) {
    if (bite.arena !== mine.arena) {
      biteClearAll();
      bite.arena = mine.arena;
      bite.score1 = bite.score2 = -1;
      bite.health.clear();
    }
    const s1 = biteScoreOf(mine.arena.textPlayer1);
    const s2 = biteScoreOf(mine.arena.textPlayer2);
    const dropped = [];
    for (const fighter of mine.fighters) {
      const health = healthOf(fighter);
      if (health == null) continue;
      const was = bite.health.get(fighter);
      bite.health.set(fighter, health);
      if (was != null && health < was) dropped.push(fighter);
    }
    if (s1 >= 0 && s2 >= 0) {
      if (bite.score1 >= 0 && bite.score2 >= 0) {
        const bumped = Math.max(0, s1 - bite.score1) + Math.max(0, s2 - bite.score2);
        for (let i = 0; i < bumped; i++) bite.pending.push({at: now});
      }
      bite.score1 = s1;
      bite.score2 = s2;
    }
    for (const fighter of dropped) {
      const idx = bite.pending.findIndex((p) => Math.abs(now - p.at) <= BITE_MATCH_MS);
      if (idx < 0) continue;
      bite.pending.splice(idx, 1);
      biteMark(fighter, now);
    }
    for (let i = bite.pending.length - 1; i >= 0; i--) {
      if (now - bite.pending[i].at > BITE_MATCH_MS) { bite.pending.splice(i, 1); bite.unmatched++; }
    }
    bitePaint(now);
  }

  /* The boost counter: how many boosts your water still pays for, shown over
   * your health bar once you are at 25% or less in your own duel. A boost
   * costs 1.5% of the meter — the server takes 1 and 2 points alternately —
   * and boosting stops working at 15%. Which of the two comes next is read
   * off the last drop (mod 3); until a drop has been seen the count is the
   * conservative one. */
  const WATER_LOW_PCT = 25;
  const BOOST_MIN_PCT = 15;
  const BOOST_PAIR_PTS = 3;

  const water = {pct: null, phase: null};

  function waterTick() {
    const pct = resourcePercent();
    if (pct == null || !inGame()) { water.pct = null; water.phase = null; return; }
    const rounded = Math.round(pct);
    if (water.pct != null && rounded !== water.pct) {
      const delta = rounded - water.pct;
      if (delta > 0) water.phase = null;
      else {
        const r = Math.round(-delta) % BOOST_PAIR_PTS;
        if (r) water.phase = BOOST_PAIR_PTS - r;
      }
    }
    water.pct = rounded;
  }

  function boostCountFrom(pct, phase) {
    if (pct == null || !(pct > BOOST_MIN_PCT)) return 0;
    let count = 0;
    let p = pct;
    let c = phase === 1 ? 1 : 2;
    while (p > BOOST_MIN_PCT && count < 200) {
      count++;
      p -= c;
      c = BOOST_PAIR_PTS - c;
    }
    return count;
  }

  const boostUI = {node: null, shown: false, text: '', mood: null, sized: 0};

  function boostHide() {
    if (boostUI.node && boostUI.shown) {
      boostUI.node.style.display = 'none';
      boostUI.shown = false;
    }
  }

  function boostTick(now) {
    const me = myAnimal();
    if (!boostOn() || !arenaDuel.active || !me || water.pct == null ||
        water.pct > WATER_LOW_PCT) { boostHide(); return; }
    const box = healthBarBox(me);
    const at = screenPosOf(box ? box.container : me.container, now);
    if (!at) { boostHide(); return; }
    if (!boostUI.node || !boostUI.node.isConnected) boostUI.node = qolcOwnLayer('qolc-boost');
    const node = boostUI.node;
    if (!node) return;
    const left = boostCountFrom(water.pct, water.phase);
    const vmin = Math.min(innerWidth, innerHeight);
    const gap = Math.max(16, Math.round(vmin * 0.032));
    const text = left <= 0 ? 'No boost' : left + (left === 1 ? ' boost' : ' boosts');
    if (boostUI.text !== text) { node.textContent = text; boostUI.text = text; }
    const mood = left <= 1 ? 'qolc-boost-none' : left <= 3 ? 'qolc-boost-low' : '';
    if (boostUI.mood !== mood) { node.className = mood; boostUI.mood = mood; }
    if (boostUI.sized !== vmin) {
      boostUI.sized = vmin;
      node.style.fontSize = Math.max(13, Math.round(vmin * 0.024)) + 'px';
    }
    if (!boostUI.shown) { node.style.display = 'block'; boostUI.shown = true; }
    const t = 'translate3d(' + at.x.toFixed(1) + 'px,' + (at.y - gap).toFixed(1) +
      'px,0) translate(-50%,-100%)';
    if (node.style.transform !== t) node.style.transform = t;
  }

  /* ----- one tick for everything that happens in a duel ----- */

  let cullingCheckAt = -Infinity;

  function arenaFrame(now) {
    // Off by the master switch (or any path that skipped arenaSkySet): give
    // mope's Arena Culling back. Checked once a second; it is a storage read.
    if (!arenaSkyOn() && now - cullingCheckAt > 1000) {
      cullingCheckAt = now;
      if (store.get('cullingBeforeTheme', null) !== null) mopeSetCulling(false);
    }
    const mine = arenaPlaying() && !document.hidden ? arenaMine() : null;
    if (mine && !arenaDuel.active) {
      arenaDuel.active = true;
      arenaDuel.since = now;
      arenaFocusEnter();
      dbg('arena: duel started');
    } else if (!mine && arenaDuel.active) {
      arenaDuel.active = false;
      biteClearAll();
      bite.arena = null;
      dbg('arena: duel ended');
    }
    arenaDuel.mine = mine;
    arenaSkyTick(mine, now);
    if (mine && biteOn()) biteTick(mine, now);
    else if (bite.marked.size) biteClearAll();
    waterTick();
    boostTick(now);
    zorderApply();
  }

  /* ----- hotkeys: Z for the sky, ] and [ for draw order ----- */

  PAGE.addEventListener('keydown', (event) => {
    if (!event.isTrusted || event.shiftKey) return;
    if (!arenaPlaying()) return;
    const above = kbHit('zAbove', event);
    const below = !above && kbHit('zBelow', event);
    if (!above && !below) return;
    event.preventDefault();
    event.stopPropagation();
    zorderSet(above ? 1 : -1, 'hotkey');
  }, true);

  PAGE.addEventListener('keydown', (event) => {
    if (!kbHit('arenaTheme', event)) return;
    if (!arenaPlaying()) return;
    if (extras && extras.panel && extras.panel.style.display === 'block') return;
    const target = event.target;
    if (target && target.closest && target.closest(QOLC_OWN_UI)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    arenaSkySet(!settings.arenaSky, 'hotkey');
  }, true);

  function arenaDebug() {
    const mine = arenaMine();
    const report = {
      version: VERSION,
      screen: mopeScreen(),
      inYourOwnDuel: !!mine,
      sky: arenaSky.why,
      skyStars: arenaSky.builtStars || 0,
      arenaCulling: mopeCullingValue() === MOPE_CULL_HIDE ? 'HIDE — world culled'
        : mopeCullingValue() === MOPE_CULL_SHOW ? 'SHOW — world drawn' : 'could not be read',
      fighters: mine ? mine.fighters.map((f) => (f === myAnimal() ? 'you' : 'opponent') +
        ' ' + healthOf(f) + '%') : [],
      bites: {seen: bite.bites, unmatched: bite.unmatched, marked: bite.marked.size,
        labels: mine ? [biteScoreOf(mine.arena.textPlayer1), biteScoreOf(mine.arena.textPlayer2)] : null},
      water: water.pct, nextBoostCosts: water.phase,
      boostsLeft: water.pct == null ? null : boostCountFrom(water.pct, water.phase),
      drawOrder: (zorder.mode > 0 ? 'above' : zorder.mode < 0 ? 'below' : 'off') +
        (zorder.api ? ' — ' + zorder.api : ''),
    };
    console.log(TAG, 'arena', report);
    return report;
  }
  // ------------------------------------------------------------ quick chat
  //
  // 1.33.0. Five messages you write once, on the number row, sent into mope's
  // own public chat.
  //
  // HOW A MESSAGE IS SENT, and why it is done through mope's own UI rather
  // than over the wire. The chat packet is `chatMessage`, and like everything
  // else it goes through `$.network`, which is module-scoped and unreachable —
  // the same wall §5 of the handoff describes for `$.player` and `$.camera`.
  // What IS reachable is the box the player types into, so this drives that:
  //
  //   1. press mope's own chat bind, which opens the box. Read from
  //      `settings.binds.chat` rather than assumed to be Enter, through the
  //      same settings capture mopeBindFor() uses;
  //   2. wait for `#chatInput` to exist. mope creates it on demand and Svelte
  //      renders on its own schedule, so this is polled briefly rather than
  //      assumed to be there on the next line;
  //   3. write the text and fire an `input` event. This is the step that is
  //      easy to get wrong: mope's submit handler sends the value out of
  //      SVELTE'S STATE, not out of the input — `wo(H(c))`, not `input.value`
  //      — so an assignment on its own would send an empty message. Svelte's
  //      `bind_value` listens for `input` and reads `.value` back, which is
  //      what puts the text where the submit handler will look for it;
  //   4. submit the form.
  //
  // NONE OF THAT NEEDS A TRUSTED EVENT. There are exactly three `isTrusted`
  // checks in mope's whole bundle and all three are on mouse events —
  // `mousedown`, `mouseup`, `pointermove`, in the input class. The keyboard
  // path is unguarded, and the Svelte binding never looks. So a synthetic
  // keydown really does open the box; this was checked in the bundle rather
  // than hoped for, because `isTrusted` is unforgeable and finding out
  // otherwise in game would have meant the feature could not exist at all.
  //
  // THE ONE REAL CONFLICT, and it is not in the bind list. mope hardcodes
  // Digit1-Digit9 to pick an animal while the upgrade menu is open:
  //
  //     if (!chatVisible && $.upgrading && ['Digit1', … ].includes(e.code))
  //
  // That is not a rebindable action, so `mopeBindFor()` cannot see it and the
  // usual clash check would report the keys as free. The guard is the upgrade
  // menu's own root, `#upgradeMenu`, which mope renders only while it is up:
  // while that element exists these keys are left entirely alone and the
  // event is not consumed, so upgrading works exactly as it always did. This
  // is the reason the feature ships OFF.
  // CHAT_SLOTS, CHAT_MAX_LEN and chatCleanSlots() are NOT here — they are up
  // beside `settings`, and the comment there says why. Everything below is
  // used only at run time and can live with the rest of the feature.
  const CHAT_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'];
  // One shared cooldown, not one per key. It is here to stop a stuck key or a
  // double-tap turning into a burst that mope's own spam handling would answer
  // for, and a per-key cooldown would not do that — five keys pressed in a
  // row is exactly the case worth slowing down.
  const CHAT_COOLDOWN_MS = 700;
  const CHAT_OPEN_STEP_MS = 16;
  const CHAT_OPEN_TRIES = 15;    // ~240ms, far longer than a Svelte flush

  const chatQuick = {
    // -Infinity, not 0: with 0 the cooldown measures from the page's own
    // origin, so the first press inside the first 700ms of the page is
    // swallowed by a message that was never sent. Same idiom as every other
    // "has this happened yet" clock in this file.
    at: -Infinity,    // when the last message was sent
    sent: 0,
    // Why the last press did nothing, in the words the debug hook prints.
    // Kept because every guard below is a silent one by design: a hotkey that
    // toasts on every refusal in the middle of a fight is worse than one that
    // quietly stands down, so this is where "why did nothing happen" lives.
    lastStandDown: '',
    lastSlot: -1,
    log: [],
  };

  function chatQuickOn() {
    return settings.masterEnabled && settings.quickChat;
  }

  function chatNote(what, slot) {
    chatQuick.lastStandDown = what;
    chatQuick.lastSlot = slot;
    chatQuick.log.push({t: Math.round(performance.now()), slot: slot + 1, what});
    if (chatQuick.log.length > 40) chatQuick.log.shift();
  }

  // The key that opens mope's chat. Read from its own bind list, so a player
  // who has moved chat off Enter still gets a working feature. A pointer bind
  // is skipped rather than faked: a synthetic mouse event could not open it
  // anyway, since the pointer path is the one place mope checks isTrusted.
  function chatOpenCode() {
    const proxy = mopeSettingsProxy();
    try {
      const binds = proxy && proxy.binds && proxy.binds.chat;
      if (Array.isArray(binds)) {
        for (const bind of binds) {
          const code = bind && bind.code;
          if (typeof code === 'string' && code && code.indexOf('Pointer') !== 0) return code;
        }
      }
    } catch (e) { /* never captured, or a shape we do not know */ }
    return 'Enter';
  }

  function chatPressOpen() {
    const code = chatOpenCode();
    // `key` as well as `code`: mope's isBind() matches on either, and its
    // fallback compares the bind's printable VALUE against event.key.
    const key = code === 'Enter' ? 'Enter'
      : code.indexOf('Key') === 0 ? code.slice(3).toLowerCase()
      : code.indexOf('Digit') === 0 ? code.slice(5) : '';
    PAGE.dispatchEvent(new KeyboardEvent('keydown', {
      code, key, bubbles: true, cancelable: true,
    }));
  }

  // Text into the open box, and the box submitted. Returns what happened, so
  // the caller can record it rather than assume it worked.
  function chatFill(input, text) {
    const form = input.form || (input.closest && input.closest('form'));
    if (!form) return 'no form around #chatInput';
    input.value = text;
    // THE LOAD-BEARING LINE. mope sends Svelte's state, not the input's value.
    input.dispatchEvent(new Event('input', {bubbles: true}));
    try {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    } catch (e) { return 'submit threw: ' + (e && e.message); }
    return '';
  }

  function chatSendSlot(index) {
    const text = (settings.chatSlots[index] || '').trim().slice(0, CHAT_MAX_LEN);
    if (!text) return;
    chatQuick.at = performance.now();
    const finish = (problem) => {
      if (problem) { chatNote('send failed — ' + problem, index); return; }
      chatQuick.sent++;
      chatNote('sent', index);
    };
    const open = document.getElementById('chatInput');
    if (open) return finish(chatFill(open, text));
    chatPressOpen();
    let tries = 0;
    const wait = () => {
      const input = document.getElementById('chatInput');
      if (input) return finish(chatFill(input, text));
      if (tries++ >= CHAT_OPEN_TRIES) {
        return finish('the chat box never opened — is chat bound to a mouse button?');
      }
      setTimeout(wait, CHAT_OPEN_STEP_MS);
    };
    setTimeout(wait, 0);
  }

  // On the window at capture, like every other hotkey here — the capture phase
  // visits window before document, and mope's own handlers are on the window.
  PAGE.addEventListener('keydown', (event) => {
    if (!event.isTrusted || event.repeat) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    // Which slot, from the REGISTRY rather than from a fixed digit list, so a
    // quick chat moved off the number row still works and one left on it still
    // clashes with the upgrade menu exactly as it always did.
    let slot = -1;
    for (let i = 0; i < CHAT_KEYS.length; i++) {
      // An unbound slot must not match: kbCode() returns '' for one, and an
      // empty string can never equal a real event.code, but the guard is
      // written out rather than relied upon.
      const want = kbCode('chat' + (i + 1));
      if (want && event.code === want) { slot = i; break; }
    }
    if (slot === -1) return;
    if (!chatQuickOn()) return;
    if (!arenaPlaying()) { chatNote('not in a game', slot); return; }

    // THE UPGRADE MENU AND MOPE'S BIND LIST are both asked through kbHit now,
    // which is what makes override/underride mean anything here. On underride
    // — the default, and what every earlier version did unconditionally — this
    // returns false while the upgrade menu is up or while mope has an action
    // bound to the key, and the event is NOT consumed, so upgrading works
    // exactly as it always has. On override it returns true and the key is
    // ours, which is the choice the panel now offers.
    if (!kbHit('chat' + (slot + 1), event)) {
      chatNote(document.getElementById('upgradeMenu')
        ? 'the upgrade menu has this key — set the bind to Override to take it'
        : 'something else has this key — see Settings, Keybinds', slot);
      return;
    }
    if (extras && extras.panel && extras.panel.style.display === 'block') {
      chatNote('the panel is open', slot);
      return;
    }
    const target = event.target;
    if (target && target.closest && target.closest(QOLC_OWN_UI)) {
      chatNote('the press was inside our own UI', slot);
      return;
    }
    // An empty slot is not a refusal — the key simply is not ours, so it is
    // left alone rather than swallowed. This is what makes the feature safe to
    // leave switched on with two of the five filled in.
    if (!(settings.chatSlots[slot] || '').trim()) {
      chatNote('that slot is empty', slot);
      return;
    }
    const now = performance.now();
    if (now - chatQuick.at < CHAT_COOLDOWN_MS) {
      // Consumed anyway. Letting it through would hand a rejected key to the
      // upgrade menu a moment later, which is the one outcome worse than
      // nothing happening.
      event.preventDefault();
      event.stopImmediatePropagation();
      chatNote('too soon after the last message', slot);
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    chatSendSlot(slot);
  }, true);

  // Type __lumiChatDebug() in the console. Every guard above is silent by
  // design, so this is the only place that says which one fired.
  function chatDebug() {
    const report = {
      version: VERSION,
      enabled: settings.quickChat,
      masterSwitch: settings.masterEnabled,
      inGame: arenaPlaying(),
      slots: settings.chatSlots.map((s, i) => (i + 1) + ': ' + (s ? '"' + s + '"' : '(empty)')),
      filled: settings.chatSlots.filter((s) => s.trim()).length,
      messagesSent: chatQuick.sent,
      // The three things that take the keys away, reported separately because
      // "pressing 1 does nothing" has a different answer for each.
      upgradeMenuOpen: !!document.getElementById('upgradeMenu'),
      chatBoxOpen: !!document.getElementById('chatInput'),
      keysBoundInMope: CHAT_KEYS.map((k) => k + ': ' + (mopeBindFor(k) || 'free')),
      // Which key opens mope's chat, read from its own binds. 'Enter' here
      // with no settings capture means the default was assumed, not read.
      opensChatWith: chatOpenCode(),
      settingsCaptured: !!mopeSettingsProxy(),
      lastPress: chatQuick.lastSlot >= 0
        ? 'key ' + (chatQuick.lastSlot + 1) + ' — ' + chatQuick.lastStandDown
        : '(nothing pressed yet)',
    };
    console.log(TAG, 'quick chat', report);
    console.table ? console.table(chatQuick.log) : console.log(chatQuick.log);
    return report;
  }
  try { PAGE.__lumiChatDebug = chatDebug; }
  catch (e) { window.__lumiChatDebug = chatDebug; }


  /* ========================== keeping current ==========================
   *
   * A Load-unpacked extension never updates itself, so the extension checks
   * GitHub's copy of manifest.json once an hour and says on the menu when a
   * newer release is out. Nothing about you goes with the request. A
   * Tampermonkey copy never checks: Tampermonkey updates it on its own.
   */

  const UPDATE_URL = 'https://raw.githubusercontent.com/Luminosity67/lumis-extras/main/manifest.json';
  const UPDATE_PAGE = 'https://github.com/Luminosity67/lumis-extras/releases/latest';
  const UPDATE_EVERY_MS = 60 * 60 * 1000;
  const menuNotice = {text: '', bad: false};

  // True when version a is newer than version b.
  function qolcVersionNewer(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x > y;
    }
    return false;
  }

  function updateAvailable() {
    const v = store.get('updateLatest', '');
    return v && qolcVersionNewer(v, VERSION) ? v : '';
  }

  // Each release is announced once per page load.
  let updateAnnounced = '';
  function updateAnnounce() {
    const known = updateAvailable();
    if (!known || known === updateAnnounced) return;
    updateAnnounced = known;
    queueMenuNotice('Lumi’s Extras ' + known + ' is out. Get it from the GitHub releases page (Settings → Troubleshooting).');
  }

  function updateCheck() {
    if (QOLC_VIA !== 'extension' || !settings.updateCheck) return;
    const last = Number(store.get('updateCheckedAt', 0)) || 0;
    if (Date.now() - last < UPDATE_EVERY_MS) { updateAnnounce(); return; }
    store.set('updateCheckedAt', Date.now());
    fetch(UPDATE_URL, {cache: 'no-store', credentials: 'omit'})
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        if (!m || typeof m.version !== 'string') return;
        store.set('updateLatest', m.version);
        updateAnnounce();
        syncTroubleshootingUI();
      })
      .catch((e) => dbg('update check failed', e));
  }

  // Once per version, a userscript install is told the extension exists.
  function userscriptNotice() {
    if (QOLC_VIA !== 'userscript') return;
    if (store.get('extensionNoticeFor', '') === VERSION) return;
    store.set('extensionNoticeFor', VERSION);
    queueMenuNotice('Lumi’s Extras works best as a browser extension. ' +
      'Install it from github.com/Luminosity67/lumis-extras.');
  }

  // Held until the menu is on screen, so it is never lost behind a game.
  function queueMenuNotice(text, bad) {
    menuNotice.text = text;
    menuNotice.bad = !!bad;
  }

  function menuNoticeTick() {
    if (!menuNotice.text || !onMenu() || !document.body) return;
    qolcToast(menuNotice.text, menuNotice.bad ? 'is-bad' : '', 9000);
    menuNotice.text = '';
  }

  /* ----- the game connection, in words ----- */

  // One line for the Settings row.
  function bridgeSummary() {
    const s = bridge.status();
    if (!s.game) return 'Not connected yet — ' + s.phase + '.';
    const missing = [];
    if (!s.entityRegistry) missing.push('the animal list');
    if (!s.animalClass) missing.push('the animal class');
    if (!s.animalConfigs) missing.push('the animal table');
    const stores = s.stores.split(', ').filter((x) => /MISSING$/.test(x))
      .map((x) => x.replace(/ MISSING$/, ''));
    if (stores.length) missing.push('HUD data (' + stores.join(', ') + ')');
    const after = s.foundAfterMs != null ? ' in ' + s.foundAfterMs + ' ms' : '';
    return missing.length
      ? 'Connected' + after + ', but could not find ' + missing.join(', ') + '.'
      : 'Connected to mope' + after + '. Everything found.';
  }

  // The whole picture, for pasting to Lumi.
  function lumiReport() {
    const game = bridge.game;
    let mope = '';
    try { mope = game && game.config ? String(game.config.gameVersion) : ''; } catch (e) { mope = ''; }
    return JSON.stringify({
      extras: VERSION,
      via: QOLC_VIA,
      mopeVersion: mope || '(unknown)',
      browser: navigator.userAgent,
      bridge: bridge.status(),
      screen: mopeScreen(),
      frames: frame.frames,
      frameHook: frame.renderer ? 'renderer wrapped' : 'no renderer yet',
      zoom: zoomHub.status(),
      errors: [...featureErrors].map(([name, row]) => ({name, count: row.count, last: row.last})),
      instances: qolcInstances.map((i) => i.version + ' ' + i.via),
    }, null, 2);
  }
  // -------------------------------------- Lumi's Extras button + options menu

  // `extras` itself is declared up with the camera zoom, which calls back into
  // syncZoomUI() long before this point in the file.

  // The gear2.png artwork as deflate-compressed raw RGBA pixels (108x108,
  // 2x the 54px button), painted onto a <canvas> via putImageData. An
  // <img src="data:..."> counts as an image *load*, which the page's CSP
  // can (and does) block — a direct pixel write can't be.
  const GEAR_ICON_W = 108, GEAR_ICON_H = 108;
  const GEAR_ICON_DEFLATE = '7Z1ncB1XlpjXP9ZV69radfbYrvJ6XPNrvXbZs96tnRllSswBIAEGEMw5iCKYg0iKYgZI5JzjQ3rIOecMEACJnMFMiSJFkZQoKhyfc7tv973d/UCA0oxcLt6qU/1Cv36vz9cn3tvAn/3Z6/F6vB6vx+vxerwer8f/PyPt/v2/zJ6c/E+pdyd+nToxgGLcDvw63qFMTPGeY0m+O/5fXyZ831Rhmyp8NksQ/h49Lvzqzr9r/PHHv/il9fpzjIShob/Kvjn+bvbt8SOZk8N2+/hQl3104K59bOApbr9LH+n/Dh+/YFt6Ptqvvjb4Ap+/SEdJG1FeS1MF91Fexy0+17eqpKpifq3PUlKGcSuKo/f58xHlOX89baTvMZ7DzayJoZbsG8OxeXcmdxTcu/E/fmndz2Rk3Bmfm3V7NC5jcuhu7t1JKH50D4q+uAN4HpB3Zxzybo1BPkqBQfTXxtljRUbZ/nm4zb05gjIKObiV5MYIZEsyrEkWySSXIcg0SMbEIBO7Ycsf2y1eS58YgNSxfpQ+tk2j927j77p/A/If3Ab7+CD+rtGOgruTR3Nvj/6XX5qHo5E6MbwmC39nHv7uood3Iff2GOSinvJRh4Wo53zSN+mPzpvOc7QPUkZ6IXm4B2zD1yHJQmzaVtmHJHmkhwl/bjPs70jYPkPXmCRyGeyGBJT4wS5FBlRhz7u1Le2TOIRb/EyC+jxpCH8LHjMFf0sankcK/kY6Xjzuk3pjCArwGs2eHHmSf3siJOfG8G9+aT58JAz2vplxc6SRfl/uvUnImRiCIrSJYhRiQ+cb2tMK3p0NcKm9Bs62VsKnLeXwSXMZnGoqZXKysUQReqw+P6GJ/hp//xTfT5UT0v668OPS448biuE4ysf1uK0vYnKMS10hSpEqhXBUkwI4gnJUek3Zl45zEo93urEMLrZWgR+eX0RvG2NsQ2Zx/Z0QP3wNcj6/iXY+8jTn5tjZsPb2f/ELovpnSWP95+03hyEXbSoL/UDJ7XHGKhF/p393E5xBNscbSuAI6uRIfaFDOUrbBtw2KFvj+4fZtoBtD0tbVVCnh0ySD4dq8+GgIAdq8lByVcmD/erz/dprymOSfdUkObCvShEPTbLBozIb9qJ8VJEFH5VnarIPXztaW8D4ETuyt5i+DohF28z/4jbk3hrtTR/tffNPDepcU/l/sI33l+c/usv8OtkSsSJ/4dlRyxgd5vpuKEIO05RG82tHJCk0i8BUF+RVL3BT5WCtlSAzUWryVJbIrVoRjR0Xgd1exg65VWTCHmS2u9QOu0rs4FGRjbZXCiHXmiEebS2ypw1SbgxC1s2RH9PHBzz+VKzON1b9BlkN5T64xWyq6u4N5veuXK1H31KM17pqM+grLHk0WvNwzMia2WETIwMrgddBLi9hpHGSbExh5VGt29he4iSyEniRfFiWoXArToe9ZZlwtqkcebVDdG8HRKO/JFtLHe3z/WOzutBa998Sxvoms+5PQjayqsacLwFtnWLRIfQD5Pes7GZq/U/N5jBuDxts67CJl8DIipPK6sCUnKxYyX5wL2dFvhAZKXaVBXtEVuUZjBdntrM4DXYUpcKhylwI6mpi/jEMbS0PmaWN9YX8sVidaiz+1zFD1waJVY5qV5H43WRTpB8rRlOzsvBtGp+p2OhiZHRQEpFT/rQYKZxyGCsPI6tKxaY+UllpNlUhcFJZ7S6zK/ZVmg47S9IZs22FKbCnNAO8MV4Qs5DrLcjsFqQO9/j8MXiF9rSVZX2Ovm9sAKrQrsJ72+FwbSHTE8snXspGf27k4ZBLg2xDlrZkYqVwOmBhU/trRUZ5ki2xOFWjxymdV7ZgU6pUyHbFWe3mrDivEoXXDrKx4lTYWpCMtpYGnpiPRKH+iFnug5vEbNfPycqvs+l41hc3IR1rJmIV1d+BeW6h6gMLTTwc2ZGJTYOFvCwmWfq+Atn31RlsivMy2hKTHM2mJFbVRlZZgl2prCpEVnZNdmm2hZxKFFbbi0hSYEuBjflHr7ZqZNYG4ajLjJtD36eMDvzDz8HqXGvV38WMXP8+bXwAKu5MYN15jbGia1fPAQslmxH5HRZ83Mu5cD+nyJScUA7Wy5wOaJJnyWqfxClX93sSI2Wr5RRVMqs9lQqrDyus7Ypx4sJZqby2MUFm+TbYiY99r9ZB6LUWSJhk/YO+tJ6ef/6TbetqY4X93jgU3hiB/BvDWH+WMl9i1PGReqPNFMlcpmFDpphkkUOwPKLeEKNEXpY2lWfiZLKl6mzdniw4fVSZqbKSee0uz5DsaiePWaptbVd5ESdNCpNhU14ifIT7B2OdGoSS9eAG+sXe4z+F1cW26g/iJwcgfayf5RfemLPvq8plupvKPqZnRwWaDXFOum1Z2RHnlm/O/UTbkljlmf2fA7/HxdqmMhVBVsRpJ7Ih4bx2OWAl2xZnlQJbkRfZ2MbcBDhWUwDhPa0Qin4xZbT3Sf74+K9elZfP1YbKlDujUIL1MPXJDtYoPQJ2rU/Fy9JuRClQ+cjb6fg8KzHGqv21FpxqFN9ntivZ9zFWVWbfR9vNJamwsdDG7OJD5LIObWQzMiBe3Afu4KxU29om2BZxYqwKklkcIxvbkmeDy+3VzMZS741R7uH5Kqw+rSv672H9V5ltld0eB7Q15tsPsutb9U8W+uVsHNmK5N+myPUOGfNyXu9O4f+YPRnsSveBOaZYZeJkilM6rw3I6UR1Ply7fxseP/8GHn39DFpujsO+0kxYn5+kxyujHyw2srKpkgSb8XPrc+LBA2tq8ouh/e1gG+p+kDba/tcz5XWpteYs8aa4RbbF65VDIi+RW51oKwKrOjMHEy/xNYdxSRGWowvPdb8n25XIaZ8xn6C6V+D1ERcTK8X/bStNg92Yh3+FnIzj7ldfwqZctDNkYWaVqrLCHEOwq80k+Qov8okbcxLgUkslBHY3QvrdUbCP9LjNlNeVjrrO9FsjUI45oXdnPea0OcL1LfM6KLIQOOh5gVnMn5+uvxOf5wv2lOcwr9DtKUfvUUh2ZWBlsK016LdCWmslTj8Kjy/Xl8KqrFhklMZkm8RK9oGc1SZVNuKx12bFwcGKHAi+1gTxN/ppniZzJqz2V+T/jX9304vsG0MsJzxeX6z4wtp8iZlcozpmo78/dRyS+ajiqJaS6t88nRHP02uMvs+Qowuc9gixSrSr3SRYD7tlx0F0R4PJtvgIaaoCV3uUwEllpfIi29psZIWcSIgX+cStmH/4YH4fhj4xvr/z86r79/9yurxON5Y4x4z3sXlGmtcjVqQH8frm3A4I/srI8gBtJb0X6PvU6mzEx7L9GLjUGoRx4mJtUx4WNsVZ7XFgTyKrXVhbrUTbiWirc8grqKECXNIjVU6KbFV5cT/IeYl2xQR96Qb0h2RjZ7BWCkIbSxzrhZyRgT9Ml9e5popPbHdGoBTzjECMg3QuvI4x+yULMcQcR6LNSxk47TeyMsYoya7yFEZa/Ztrqn+5H9RsygEvpabirHiunsF8XfgU/pDz2srzQJEVt6183bY0VpwXxrA1mTFwGGMO6Tvx5iCkjvTumC6vC61ViakY90puj8G51kp2LlwnWv1p0KfOkJ7r+ue6Fd8/UGt+vr9W7MEaeBj8nblHITPaa/B/H01pUzonxgoZ7cD8fDsJ5nzbMH9wRV2Gtci8xOFfXw5LUsJgI9VUBYpsYvbk2K6IERfyh+74HZTTBHQ1QBzGMNvgtWnPtyCvEvsdzA1vjrDYRefkwXtsms6MeZljG5hyX8vP5MrxyJhD1FjYEedk6iVxTtkGW8rSfV+5st2ENrEG9Ud9vl2YN5BQ32g1xqbIVsf+MLypGlalRcGOghSUZNiOQjnjcnskrEEWnNfGvCTYYGKl8CL72pyTCD4dtRA1fh1i+zrSpsvrfGtlSxbyyp4YgAPVeewcNb1I+nOge0v7kJ8be+T8udGWREZ8/tDSnqxsqtIqp+CssjRWZFPrsR46Wp4DTTdG4d6Tx/Dw2VMmX5A8/Qqefvtc84M/Gnh9/eJb+PKbr7EuQ8EtPb6Px6geG4AduUnglhWDuUWSaldm21rHeMXCOoxh1AeOGOmG6L72sunyOtNc0ZmNvFKx7tpboVyXe6vEa1nRGbvOLfjJfKawFUvJk9jIfJTHxGYb+qsNWItuKCJJhvWFJDZYh7Ien29DX2b0f6JNaawwPm1GG9pD9dU35vrKOKx4TTVuf/kQ1qRHw5rseIWPYFOc1TrMP4nXmowYuNBSAaFDnRDR09Y8XV6nW8q7su+OsTVc5NM5r71qnSnqThTJFix0Lm6N4iGxsRLlO3fjb9mIPDybyiF36DpUjg9C+fgAlIz2QzFK4UgvpPZ2wCe1hbCO+g7UQxd9X4WeT+xS8wnK/+w9HQ75OHrNETcjU8pHnJJDGad1TIiRImuZxLH45ZYexXLEkMGrEH69pWO6vD5pKkNe4xA30MmuP/IhH2kxIcdga9b8ptK9Y0Y5wpb7ulwm9Hg3/o6tWN80oM962fjxxx+hBNltQD9E+YPu++TcbyeKK+Z2VSP9lvoW9e7osfgZK/tL7miCBfGBEieyKeJEefxavF7c0bZWpUXCacwXQgY7ILS76epMeOXeG4dY5LWL8crU8mA+L763KkcSD1EscmnZNvm+jvp6wmeFuET2Uj0+ZNLTVM/zBq7BatTTbm3uQ+2nsx6t0qd1TYuAsMaql10CU46pfOSJ/HRwsoUINqUw4qzIF7pnRMPK1Ag4VVcEwQPt1P+dMa/ovg52PnRNMhtjPZtsWaoc8zO+5mgfD4vPS/USylbMq09W509LP+L47ofvwaPErvfRNU52Za4ej0t5m0tsIPTfvvmTmFmNomtXYU7YFfR3sYrv44yIV6bCinLD1fZoWJ4SDifRjwchr8Duxhnziuprx/NJZ9cln1PQ47eSI4vsdNvLNun7o0o9b9vL11sKW2vRv8c9LwEy+zpfSWfUS6KaV+PE5j3S1d5sGutHrEiJAKcwHwirLIXa/h5oHh6EpuEBaBzqh3p8PnrvjnRM8XoZvHUTKq51QlXvNUV6uiG/sx3O5WXA+0GXYHlquMopjnHijEjID5JtUc2wHGu4E7UFENTfBv5XGzpnzquDndculdeHvL/Ga01Vn471LfZSHb9P9rsJ4xLldRtxu0ONmXo9mwXueG323Jd1RqP/zi2oRZ02oH5rB/uhz8JGqkcHWX+PWO3QWKVjDm8Dt5w4lm+sRl2uxPgxJ9wbPgjyZPJ+4CWYFXARfnvhY/AsynF4PRCX/3XuKLzjdw7e8T3Htm+hzArxghXo4xgf1aY4K4WTIquRF+Uay5PD4OOaAgicIa+TTWWdOcgrEu1rO16DFMN2q/W/wk2vYfYYxaJ/oL+XbXgvGzZgHr4bdRjQXgsJ11shorMRDuJ+a/MTYTOyo+9di7XRtvxkeIZ1jjhuP3oI84Mvw6xgL5gdehneRd3ORT3fe/xI2u/Goy9YjFqL8Y/yldW58cg/Dk6hf7Vdb4M0zA0960thPTJbgbrbiDXT+mzM47LimSyMD4LA2nKH9uVbVQzzY/0lBuT/3Lm/E1gprys2xeyK2ZbCy1XlFTBT+2ou6+T+kPwF+Xwer/X6Ra5nTGzE98vVtUQGzsTEt6USa8uvJF08/fZbqJkYgrOYK21AHZ+uLYLue7dM13XFUC/T5WZkSbIxzwbzY/ygZrjftG/D5AgcKsuCTcjCv7kKrlscb/LRA/ikIo/1AnmPdlO+DZxRj8H1Fab9OTP/mlJYlBhkyNMF/6fZlcpK5bVa4xWFvCKRVyjyykdercirbib+ULOvbcSL1mfx/Ko8Q8iL9b7bh6L9Wb1enimxpTmlSw2lDq9ZPm5ivelohDfXYC4epc07kSzFmB2Jr1uN73/4AR48e+LweDS++/57OFGWw5hR/28TXgNOyCuozsyLj4DaMlicFGyqqUyxSmRl18UNea3C73OxhcJx4tU3M14nG0u7OC/yH4xXWYYmRmZTi5FvFvOB+0oy4Mnz51Pq7mVjX34arEN72Y6xiAnyoji3LzflJx2Xeko7cpJgJeqV+khLUI9W9sVHYH25xkusqWR7Urar1XhFNsVZkS+k2ssFc37Oy6+jvmv6vEpYvkH3xGzF3Ili9E61ZmHMVAa7yjKVHoFoe2WqCDWpJviZrahT6smMPfycnetMejviSO9sgWXJ4YwRzx/oMf1ep4RgyOxsfcUjK2PswWewEnNGinPL0GZPFWU63Pckvkc+c53ISuRlyC0UVlE6K7StlRhflyXpvHw7aqfPS/WH4chrC9YtjBfPhdUaRuIgifwe58zrntV4TvUYS/gQeQ1h/lfRdx1efPedQ920jY/A6YIMWBIXyPzVds6KSRrz35QvLI72h2PZqZgz9jm8KJ5jnCzqvgp9t25Yvl853AdOqENisDjSF67dmDDt0zExBktiApT6KsvIS7ctHqvcDJy4cF7HMAfy72tBXjOwr6ZSlm8wXoUpTA+kk50W3PSaRq9tzK9RHm1nMYvyMHFwVX7+5DG4RgfCG5gPb0wIh/imWrjx4HNtv1bktC/TBnPDfcApMYTN/9Hv4py2lwhrJ9DGqAZejLnIewEXYEdSFNQN9GnHGr57B8Kqy2BNTAj87sqn4IQ55mdfyjklHydKs1luuSwpFJaEeoMNf1cfcrs+OQ7RtRWwGH+Pa0q4ya44KzGn0G1K5ZRGEsFYrcQabRn61GPVeeDX2zIj+zrRVKzw6mll6362cZ9TKopdlXT9PdM+eq1Del2Ov7tydMB8nX/3Ag7kpMCSxGDYkJOI5x8Bc/B6XhYTCIdzU+Fgbhpew4HggrUM5YHbitT8oiTNzIruK1Dn4+lao7n2xWiLVEt9mBoHHvZEWBjmDbOxznJNjsAcPh4WYC6+OzkGvvr6a9NvK+q/BosSglhsImZv+5+HWXhNzcLte8GXWE/CmAda5YBuRlbpAiuUFcQrUeA1o3wD49f9cQgjXgUCL0c8DGzEfbXrH4/hgtdT281xk05immthdrQv0/M2td9Aa8A2oF9bkR4NK+0x+DtSNEa6/xPFuDaJr6NIZbk5XQcueB3QtbAeHyv5up6zvxV0EWzN5jnJhrEhWIR2ynrraj/JjeUJ0UIP0IqXkK9nRGm8rFhxXksTJfuaNi9uX8RrE+OVquqJi24zRkbbTftwPaaBc0oY5PaYe0qN48OwFOP1VvV7TLaj+Tz5O7cgC+oBr8b8xQ1rH6qDWZ1dlCzYWookZHN8q6ytSGZzU26Yu9x4+MD021KvNmONF8hypHU5+twVn7fSe7dCzBJr4QxzbkGsZNtCSSFeQQovjF8+7TXT9ocfNxazfEPhZWN63FbiSIeyT7L2U4rNrMS4uy872TJOBDRVgiueH8/LzcyU7ySbpbW2q7Jj2Vz9+bpiiOioh9iuJra9WF8Cu5DFCry+1+YlyGuVNE6qqDa2COMG+T3j+AHrtR1pcSx+SXOMyIiLyMkUswS7crPLucXKtHAWs1aoQr1D5wSFly/al/cMeJ1oKOri9kVrR9i6H7523/L6V5go61qF94X4T0K6mRflB/nd+twgzzeePP8GdqHPI3vZ5oAX1QIrkdPRimwWB2lNtNWg+qlqbBCOYK3nijqjGLzVyEpdZ0Z9xfNVBZbHsbXWYxz1YX5QsymBl8mupJilczKzitA4MUHbot6hc0IgHFXta0a8BPvaiPrbovLioq01FuOFGDeMz4Vr3D0zDpwj/eDWFw80XpxZy40xWIFxYWuReByFHc2HrER9JHW3wIvvv5f06mi+l/oZSV3NGDcjWF9L46SuY6e1L+74fXcem3PDXszx54ZeZnFqPZ9j5D4wS2e1NlPO293FHpPASeIlcFqBdkW2Rb0oJ+JVpcSvyzP0h7QegHjx8+T6NvEwcJHXTCp5gyhb0IYWk93npDJ/I+qZ1qlswHyNYqbIjK6XFXi9lg73mjhNNV/PR+lQD+aW4cxXiGs3V6O+9+aZeyHPnj+HzYkRsATrbmKl8ZLmGlXb0uZFog2szLxk2wpT7IrzsiGv+ADklTtjXsfRH2q8sI4hf7LFELcZCzV33mZ8vUjPqbcWybzoWO54fW5Ji2W9OnH037vD8jfFf6Vq14cLnnfKtZ/Wr0jpagVn1NNmbW2gDdZiTFqVFAb3H38p7fvls6ewPC4I3NBe1ueIthVvnV9kGu3KkAta+sEwjRX5QuK1BHkdIV59r8DrHueVqPES7czEhHMxMBJjhsIrBRbYguFKbalJpzGtdeCEv1/bn/wn5nxHSrPYegyrMYyMU1oaWO2a0dECkw8+s9yPPn+oyM7mLTepOTzV1PNi/MB+tcW0/8miLJgd58848di11thvyrLIMQTb0mutCBMvza5UX+hqC3llXscaCruy0L7o/vX1tC6ffAj3+4Uyty1WeZcWJ/QtHWMFnt8qPKeT5Tkw/oXcP/wB9bkn2wZuqIfNat5Gn6PY0zxpXl/zPdqmb3kRzA70hHeDLsH7IV7wdsAFmO1/ASJrrXuzTRMjrM/HWKnrN53xuj6KNbnpOvjsHpwozmRzUrS2ifjw+ovXWqY6y8quRFaYEy4XWPG4RUK93iVxAXC4Mhd8kZdXW/WMeYUir3VYd+hrizk3B1wKVClU9tusPqc1rqvx3Gjeqff+bfm6V7d3MeavtIWz9ZQ8vqzF796ZZ4Nvvzf3Ey+XFcA7IZ6ooxjWw9jA5hfj0LeEwx/8zkJ4TbnpMy/wONR3px4+X2tLPs89MYzFLKsxcP8O+NeXMZ0uR/0TL61/kWnVa4oy+UBaR2O0K+YDVVbkC12SQmAx2vPhihzM55tnyKtI4kXXIvf5up3porE0Cl7HxGoDnuP1u+b5QZFXE9bMlIco68wVf0VzW94WfrMd7W12+BW83hOY3nVR1s8Swzkhl2Honnn9gFdNMSxLi1R44b5UA8+P8oHum+Zerjiu37kJ7vg5YibFLLuDHq5mUyKrcMmmFLtSbIt6vYtj/eAQ1io+M+R1XOVF/nBtjnItMh2KdmYSmxbLFX0rOlyKv6/esAbNOL548oTV0ctVPXIhP2S72ixxpeFTVQyLEoMNrPi9BElaXIpsqDJ9V0JHIyxB/RCr9Wq/wgmPtTslBm4J/WWr0TIxitdUIJvDEudGjH1BY59JilfcrmxKzHJRhXq9i5DXwfJX5TXK/rYYzZWS39goXPf6vWc2C056LKd8eSf6n+/VvN047n/5CKLqKsE1MoDlznRvjX6vTRIsRj3mW/SvjhdmsLhm5qXf/+GE+jhflmv6bFpXGyxMDNJY8XpqfpQvzPO7CJcLc2Di/j2HzHZnJcIy1Ptq0bY0TtasVhh9oMCJ/CAJ9Q4Xxfgir6xX4dVJvIKR1xo8nw2q/jZp93HaLCRJXdOvC62bPVJoN53z46+fQQDmCktCrrBcwRVjDulOuRdAl4V4Ldst5h3PIIelVE9ZsNqg8qI54StVRabPJtFaWzzuekN+Tn3aZYkh8IbvWZh1+VO4kGtneb1xHC2wwxK0BXHdhVWv3RSvVD/I/Z8LHoM4kV2RUO/wp/Kie8fc8VzW5+p6YHmVKpuEx0adkb5d8XrbizmfcTSODMI/Xj6N11kYrM2MU/tyyr0A2j02uKU1LH7VJdrnuE/MutYO8+MDtRhkEvz+eZhrFfV1m77bB4/H1sYY699MZU20G/7mJbGB8Ntzx6Brclz+MP6ADzMS2FpdY/9Wzy3MrFyT5TyQM3JRt4wXxu6F0SqvnibwbKt6BV6NbN5U0aPAzIEPMuqN5V5J4aZ5pRHMlZfGBzNfu17reZvFFfOqXelxVDxJn6de45aMOMwbIiRm3EbJ9nZmJ8LX38o5H9Vgu+zxrNeh95XihL6SwozygmWR/vD5V4+lzz9Ge1sZF8zmJ015YKqF/2M+UMgBiZXAaxleNyRkW9Q7XBDtAweQlzfy8pohr8w7oxDQ1cjycFYz5iZI3DYIvkfmpO6n3pO7MMoPBu/KedrTb74B9+QItp5lncQsXt/i62sorkR4w8Adc245dP8urE+LhoV43nQcipW0dnBBUhBjyes7cfTevgHzI30YF+O8Fa+BiRf5u83JUfDDD/J1QmtT54d7Y01lmB9OFe2KswoV8kA5rxA5MUHbckZ/sSBK4eXT82r+UOKl6lS/10xmJN8vyGN5PMxBfdP6W+M4XZzF8vdl1DejXgzVN/ZI/fOqv6K537MF1mtdHj57AlEttbA3PwXzmkTYV5gGce0NLD5ajVP5dliANY5uV4pQDks+knI/Z9zOjfQG30pz7Ksa6IH3w7ykNTISqxQxtwjVcgtXjVWIFqtEVkvpe+MDkJe3yov84avwamA+jc8n8Liy3gEvoz9jvPCasXeY+z3ffvcdTD58AD1Yl1HfIa+vC46XZIEznuM6ob9K1/sszEkaDcylKx/93DeGtb/GUdbTBbOCL7HjibZFtnQCvze35yqrAfvu3YKb+LuMvU0aSa0N8H7EFSXHMNbCFj0LsitXIQ+UWCEjRRRfSL3e+cSrLJPxutRa1T1dXkcbCjszkZd/J/GKZjGZz/2IzNZbMJLvG0T7wLh/vjh7Sl2Ker9YUcBqq/XZ+tyFM+ZtiwI9Yfiu3huZyTq47skxmBfkyWyZr7Ol4y5AHfnUlLz8AOo4lpvG7HNVmiFmpYRbxKsQU32l8VJZOXNBX+iEepofyXk1zzDf0Hmt4ryMzHKMuUK84X40pde2En2HU7gvPHj82HD2P1rqnXwZxTbKLddxn4U55AKsjxb6X4LmYfN6nalGRU83zAu8xNbc8DWAxIt84IaUSPjm26ntko9BvFbmhHixXMTSrpIFVmoeqOftwSbb4py4OOF1MD/yCuxHXt6v5A/HwK+zHlaxdSVxKjNhjtXAbp1pjkj1OagbimEeybHwbBr3B9Mgv0T9CW1NH/Kie3sXRfvDO1c+Ba/C7ClrWhpki2ewhqL7RZyxFhfXbNI5zcNcrM2ij2w17j18CGujg/Azvlp+IeeCoYYek+wDlRwjWM8tBFbkB5mYeE3fvo7WFbL4RbxWYp2xRpufU9eXZAv8TPd2yqxY3yY9Gt7DGOQe7g9pTXXQe3MS7j96iHmief0YH4ltDcyX8uOsycBj2WNYzUZrymb7ngcPWwxE15RD2fUuqBnohXLc0nO6NqhP/16wJ/NVfJ06zSXT75mHOUzK1SaH3/342TO4+/AL6J4Yg+jqclgS6AUfhF22ztmFngXP2RXROS0T8wo1tyBGfEuyBHnNw9i4n/4m8/Um+hu/0+Z1pK6gM+vOKPsfE+TPqLcp5r0iM4mPNi8k3I+hXtNuaVHMp73hfQZt5AzM97sAS4Mvg3uYH7SPWvcXT6n5h8YrQ7mHnvi7YEyj+xbfRi5vow297XdO2eLzuRE+jOvq9CjpvgKSxai7S5XW6zWaMKdxD/WDxQGeMAevh7ewpv+D96dYx/qpMUrv2Zr7thY2lRRk8oGiPXEhVtTrnRdxmfG6cp3lGzPghfHrzgizrxWYC63OVO5nknhI83byulZxK60dR32tSo1k1+RS9FGLYwPg7cAL4BTkBfcs1tdmdLfBXPSLazLjNP5rMpQ5Qtq68/s7kAtdDyTE0t3ASBOMxXMxX20YGTR918Rn92GODzIKuIB+1w/1GMiuCfqtUv1rkQNye5L6FVrOHijbVZxiSyIrIy/vnhnyqi3ozEBe9PeAGS9am6DOIZj4GOxJum/GtNY/hs11SPfSoI5pvormiI3DB2sgug9OPLYo7N63DC4xpmvDitsH6HNorTcNcf2HX1kB/N73jGndklRTOWSl8rKZeTkLuaBoVwonP40X9ebnIq99Kq+LbZXTXi8q8lqO8dWNzZ8aOIj3ClqwMelPPYZRf2QbNJdlvOapd7QjJYbN/7qr/pAJPiYfvQjPn/rBlJMvFB7Pp7hNEu8Prqnhpu+j+vtAZpLp2ii+3gnvhVwycZLrqjCz/2M9JiEHtPCBzglynGKCfEgWq0K93jnhXq/IK/+q/fYw+3t8yzHGUm9ztbr+x91oP1b3y0iPHfgmVWhtK61teWC4x/L+40ewNDpAjZ9q7FLz8HVp0ZDS2QylA9eZz0ztaGT5Qwpu7V2tUNJ/jb2/KT2GxSv9vjiMe6jzZVH+8Oip3Hu/i/mPU5Qfe99kU4ZcXc4rDPHKYFtOTGReiwVOVryuzNAfHqrJ60y/NcT+9hT1NldRL1q8f1OSGAevm9m4CXOx/Dnd4+CRmWi63sv7rsGbQReVeilD6cfSfVhumEdMWPQGrQate1qPNRbNo2lzwcj/jYBzUGfskaE9706PY3ar1b8qJ87KxWBXov9jOaBqW84qKym/UH2hFa9FsVhbYn0xJ8wL41cm43WxtXJGvFJVXi74u1lvk8+jqutWjVzcJDZR0hw5E7thqwrFJ7qfyzhoLn+3Pe5HqsOIE/ll5/gg6HOwrsDRmHjwGbjGB7M8k3zrHNTL+qRwGLh727Tvx/nprO5TOBltKkSqgWWb0n2gyErP1/3ZWhqJFdrTIkEWRnnD7DBP1t8gf3h+prxuDmq8qJ4nZm4iByayzWg8jKzS+VwRF32t12KsGXckR8mXuvC4YrAHtmfEYSz2hobRQct9jMP4XtfNCViEtcSuzATmK8X7AcV9P0yLZf0mV6mmEvtKIqdgQ489UPOBcsxCVvFyHrjIyCrGh/V6RV4XWiumHb+IVwrjVQfLyJ9TTc/nEGi9liDyWhNFjGx0iRLmIZT5c6pn3sf6t1+4x9Gob+oNTzhYVzjdcRfrBaseLv+ukbt3YDbW9NRDt7QpMfcz2JRiV3o/0BivdFZmXsSKfCHnRettqP4631w+bV4Hq/Ku2m4MgHd7LeuRUs7E1tEZdW8XmRjZREpsOB+SVakR0lqvOZhjb4gMhGfCvOZ0+rlXx0ZhbZg/bIgKho3RIWy7JTIIRu6Yfd1Ug3qIW+PCWA/DmEsodZUxpwiS6ivdpgysRLuK47HKDxkRKx+2JVYiryOVOSx+Ia+26fI6UJHdlDDZBwGdDYwXrUFdwfXL1j9GGtjJPHSRuUiPU/X7nlagDdPfg3EL9oZmi7kyq3Xyn3/5JSz0uwi/8/4U3g/2ZELzLv/n0glY5ncJnlrcK2l1DdB9rRuRMX2/tv5FWwcj+z+jTcmsAjRWSwRWi4WYtUi1LZETY4VCvUPidaKmAC4jrzNNpZXT5bWvLKswZrwHInpaWX5IeRGtS10h6l+TSIvXHLDRJFyeh1DXj1OP8Z/Ofwx74iOgdYo+/PNvn8N2tAfqjbC8QOgTuSSFIsPT4JEQBT86WJdFo31kCI6kJMCbnqfgXcxD+Tol47oKKx/IfB8XQx7IWMUFWNqVNStvZlvU25gXfhnON5WD5/VGON1YkjFdXntL02NCR7shcbCLxSJac8DWEXM9pynsdAmX+wJGLhY9A03HybwODWM9P+oDvYnX+j+dPw4eiVHQONAHT549Y+uvn3z9DOr7e9HvBbGeL+2v53JCLYt6/93lT2BHdCh0jAzD18+/YffC0PqL2r7rsCchEn534QS84XeW6VZkJfo947y9syFOaf5PzC3iBLtywGqBwGk+kyuYy3ti/ezPehTnrzXA6YYS/+ny2l2QfOJKXyukjWJulpcMTvg7XXntaMXgZZISrvEW+6XGnoFYjzrFBsAbPmfg96hXJ39PcAvxBacAT3jD6xN4P9RLWW8p7M+Frxej9XxvIY8/XPgYluLn3EN9YTH6yd97noS3kDXrD1rZUaI5l5BsKiHQIgcMkHuBkg/01VnFqKyivDUhVuQL3w+5CGtSI9kap9Od9H+qy3ZOl9fm7FjnT9qr2N/vpb8/tQh/D9NLSqjc90xVReUosbBgY5qDdSRc93jN0xwRreWcE36F9feJg8ZHYhUi5wmqvdA1Owf9zAdYi86L9GHH0zgl6j30ZYlmRqxXm2iYCxYZ8TjlIK+wZqXzIk4kNI/ybuB52FdsB9/OejjeVAoX26vemC4vN3vk33iUZ72IHriKOUc9LGHrYkJYHCNmrvw+GEGsuIjvuaYIfk+ch1DFkpemf+UxZ+SSHCrZl4uJldlu5LpJmD+0EGcH9uRklVPEC5zi9N6SzspHZ0V5BfeBAqu54V4wK/gieDZXsP//fqgy95FPZ9W/nC4vGrsKkjtp3sw21M3mKOgcmC6SQzRbk9mpfRuJ40vsSFzvmsxFec1kL6ro9asFJ1M/z9CHcGhHsj1NxcrISbQpU6yK8ZHydStWlGd8gL7QJT6IrX8/1lwKh6tzi2fCisa23Phzn3TVQMrIdThSkQML8XctU9c7Ml29zKdZsRFsw0WINTMVRyyXOWRlnJN6SYwy5OnOEisLu9L8n5+pDrZiNS9S4UQyF331O4HnYH+x8r9+DzWXwPGaghn/v1j3lMi/21OWAUHIPKqnjeUczuRHNGYhmv5FcTVsFRH2fUVGU4optzPMxSda8NL8njnnk3yfFSsHuTrr24o9i6lYhV9mfnB2qCcT/6v1cLQmH/aWZzw/21j+n2fKi8bmzLiaU5h32Md6YU9ROizE37WU68Kkt1DN7jRGP5mBKsJrUoyawp4c+zyh1n0ZJ1NeESDn6nFWeYWvFqsWOPB/3K6I19sBZ2FnbhL7/3of1ebBvvJM+6uworEmOXyJR10++9+K0b1t+HuVc2LMbLqtSTZn9E+Gx5po+nYkov6t7xGwsqelU7CaMocw9JKk+lfsVRj7FbFCLzDaOq+Q/J/A6oOQS2wOJairEQ5VKP8LYV9F1u9flReNjVlx7cdayiAda7HjVXkwD38X00mSmZelaPrGmsiR37LsJ0x/v1exJSfj3FSCkZEgljblJ9mU2FtaYGJ1ReGksbrMOL3pfwaOlmczX7ijIhN2FaZO+3+mOBqrkoLe3oXHOt9SAZljfbAuIxYWxHC/qHIw+aUQS91bMdBii/B8Kd8Kj6WY9BJG+hxUkIW/I05c+HyHwsWqnhJZmXMKIyezXRk5MUFW7wScg9XJ4RDTfxV2FSt/q3BfWfr//qm8aKxLDY/e31gMIegX4/s7mf4WxwVIHESxek3JxwwsTDWQ1XvGx1PVTIb5QktWU9uRzMjo+/yEnMJsU9OxK/KD7wVdgPn4XiTmcceq8mF7VTb9Hyqfn4MVjbl+p/5qU3b8xP76Qkga7ILgribM75VzNOtYZGKt15f7r2l8JoGvkRDFwEbzcaI9iXNTAYyJJSdjTaXOg5hZeTtkNc/Ctqgufi/oIvi314FnSxVspL+LkW8b8GhM/YufixcNl9gr/7ilIPnFwdoCsI/2gk97LSyg8yE7c6BX8Zpfanis+y3D1mof4/ESxM9Z2JDJ51nlEAEGPoI9ib7PIlYtEPIKvbekiJmVlyaz0K6o7+TVVMnuTaC/77ilMPnrHTm2//lzsuJjZWzgqu2ldjhYnQ9pIz0QgHGSckaKZ85qfWZilWBmIb9n8FumzwTCVPGIM5JYGXOJeEf1k1HMvk+KVcQqxoKVmLNHynZFa54ot6Ca+IMQT/BurUa9NbC/RbGJ/l+ZPdLpj8FKY5YQ9OGO8gzwqMyBhIEujGdX2f8jm4u/ma5nM48gg14d24SjuDNlPDLZUqA5NsXJ8cmKkSlOGTgZ6yrZrrhNCTFLyNnf8P2U9ZvCr7WAF/KitdH0d9RWp4au+2Oy4mNFfPBW+lsO9P80KBcl/3ikPIfV0/PxfJjO+H1ojiTeoGtJ78JrBp6W+xl8nz5n6IgR930W+USMozgl99fnR4n+T6yBFZuinsVb/mfhXfSB+4vsED/QCR9XFbC/rbM2O+67VSkhq/8UrPhYFuU/b2NOwme7MLc5Xl0AtqFrEN3TDrvzU5h/pHXqLJY7YuBQ5zOXJdpWZrVYE85GFYHXIr4GxsgqWhetBmZ1sI+BlZ4DEqf30Z7eCjjL8ootmfEQgrlZKNoVzSOuQZtyz4y5sSou6O0/JSs+Fvmf+fW6jOiS7eXK/4H0aqlmcS3yehscKM1kc/PEjWQB66/5M/3pvirQ8DhQeC3Q9LqTuE9cgL6V+Pib+CyK9dd4KFt/gY/AKVpnpduSUFcxRt5qXXWF2RLZ0azgCxifzjNbWoLH9ihMh9DuFojq7WB+xz0rnv3PHrf0iKz5gZ6/+iVYiWNVcuiOdVlx93bQ/x0qy4QLTRUQh3UaxTdfzCMP42/ekBnH6uhFqNMFGMfnRwsSY3ju6D0W7xUxfobuv5sX5Ui82T3kRpmDetckggT1z4V8GkmYF5vr/CDMk23fRz4k9JzmQWk+dG1aFBwoyQSfthqI7bsKwd3NcLgiF/1eAqxBTqvSIyddk0PW/9KcxPGB16l/vzo98vzazJjPt5bR36XPgMNVeeDdVsuuszhkF43nEnatla27orVynhh7L7VUwkUmVfi4Stni654WQu/T1ksQeZ8q4fUqRVrUz7Yqx2fHULf8Nfp+9juaXy60H33+CrKh8wjHmjeytx1zvkY4XVcMOwtTYW1uIrjnJdIa/FsuSUEn37hw5F/90nwcDeK2Ijlk9+r0iDrk94LqwW30/1Qqstj/cv4Yz+nTpnI4i+d+Fs/9THMFPkehbXM5nMb3TjeWwSdcmpTtqYZSXRppW6I9PylsT+LrJ9X3TtaXSHKCSbHyXN1P2qdBllOq0Hv699HzYjhWWwgHK3PhQ7wuNxfS31W3gXtuAs3ZPl+eHFKxLCFw499fPPzXvzSPmYzZEed/szTef/3ypODw5baQWtek4PEVyaGP8PHTFbbQp7S1lCQuwUxcSRKVrfJayJPlicGarEgMebKCvaa/7poY9JQ/p8cuJAnBT1wSgrR9XNg+9Jqwj7av4XFCID5WBFkwwfceLksMHMPXapcm+Ic4x/uv/SDc69e/tN5/trH17//87cv7/u1vz+79jyT/cGrnr4zytxavie/9rWEfR48dPbc6xnS+m0T73Z4HfkUy6/yRf/NnW7f++S+t1tfj9Xg9Xo/X4/X4f338Xw==';

  function paintGearIcon(canvas) {
    try {
      const bin = atob(GEAR_ICON_DEFLATE);
      const packed = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) packed[i] = bin.charCodeAt(i);
      new Response(new Blob([packed]).stream()
        .pipeThrough(new DecompressionStream('deflate-raw')))
        .arrayBuffer()
        .then((buf) => {
          // View exactly W*H*4 bytes; ImageData demands an exact length.
          const px = new Uint8ClampedArray(buf, 0, GEAR_ICON_W * GEAR_ICON_H * 4);
          canvas.getContext('2d').putImageData(
            new ImageData(px, GEAR_ICON_W, GEAR_ICON_H), 0, 0);
        })
        .catch((e) => dbg('gear icon inflate failed', e));
    } catch (e) {
      dbg('gear icon paint failed', e);
    }
  }

  function injectExtrasStyles() {
    if (document.getElementById('qolc-styles-v41')) return;
    const style = document.createElement('style');
    style.id = 'qolc-styles-v41';
    style.textContent = `
      #qolc-btn {
        position: fixed; left: 24px; bottom: 24px; top: auto; right: auto;
        width: 54px; height: 54px;
        z-index: 2147483646; cursor: pointer; pointer-events: auto;
        border-radius: 10px; overflow: hidden;
        box-shadow: none;
        transition: transform 0.12s ease,
          top 0.25s ease, left 0.25s ease, bottom 0.25s ease, opacity 0.2s ease;
        user-select: none;
      }
      /* Slightly enlarge the artwork inside its clipped frame so the
         frosted/bevel rim baked into gear2.png stays out of view. */
      #qolc-btn canvas {
        display: block; width: 100%; height: 100%;
        border-radius: inherit; pointer-events: none;
        transform: scale(1.30);
      }
      #qolc-btn:hover {
        transform: scale(1.07);
      }
      #qolc-btn:active { transform: scale(0.97); }
      /* ---- the panel shell (menu v2, 1.25.0) ----
         Fixed 884x572 on every category. Nothing about the shell changes when
         the category does: that was the whole point of the redesign, and it is
         why the settings pane is a fixed-height box rather than a thing that
         grows with its contents. */
      #qolc-panel {
        position: fixed; top: 88px; left: 24px;
        width: 884px; height: 572px;
        max-width: calc(100vw - 32px); max-height: calc(100vh - 32px);
        box-sizing: border-box;
        z-index: 2147483646; pointer-events: auto; display: none;
        font-family: Quicksand, "Trebuchet MS", Verdana, sans-serif;
        color: var(--qolc-ink);
        background: var(--qolc-shell);
        backdrop-filter: blur(15px) saturate(1.4);
        -webkit-backdrop-filter: blur(15px) saturate(1.4);
        border: 1px solid var(--qolc-edge-lit); border-radius: 16px;
        box-shadow: 0 14px 40px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.28);
        padding: 0; user-select: none; overflow: hidden;
      }
      /* The panel itself stays a plain block that is shown and hidden with
         style.display, exactly as it has been since 1.1.0 — eight places in
         this script test for that. The column layout lives on a shell INSIDE
         it, so the redesign did not have to touch any of them. */
      .qolc-shell { height: 100%; display: flex; flex-direction: column; }
      #qolc-game-hint {
        position: fixed; left: 50%; top: 50%;
        z-index: 2147483645; pointer-events: none; opacity: 0;
        transform: translate(-50%, -125px) scale(0.97);
        max-width: min(760px, 88vw); box-sizing: border-box;
        color: #78f1df; text-align: center;
        font-family: Quicksand, "Trebuchet MS", Verdana, sans-serif;
        font-size: clamp(15px, 1.45vw, 20px); font-weight: 700;
        line-height: 1.25; letter-spacing: 0.1px;
        text-shadow: 0 2px 3px rgba(0,35,40,0.95),
          0 0 11px rgba(40,220,204,0.72);
      }
      #qolc-game-hint.qolc-show {
        animation: qolc-game-hint 6.5s ease forwards;
      }
      @keyframes qolc-game-hint {
        0%   { opacity: 0; transform: translate(-50%, -115px) scale(0.97); }
        10%  { opacity: 1; transform: translate(-50%, -125px) scale(1); }
        78%  { opacity: 1; transform: translate(-50%, -125px) scale(1); }
        100% { opacity: 0; transform: translate(-50%, -137px) scale(0.99); }
      }
      /* Ability cooldown numbers. Their own layer, sitting above the game
         HUD but below the panel, so the game's DOM is never written to. */
      #qolc-cd {
        position: fixed; inset: 0; z-index: 2147483644;
        pointer-events: none; overflow: hidden;
      }
      .qolc-cd-badge {
        position: absolute; display: none;
        transform: translate(-50%, -50%);
        font-family: Quicksand, "Trebuchet MS", Verdana, sans-serif;
        font-weight: 700; line-height: 1; white-space: nowrap;
        font-variant-numeric: tabular-nums; color: #ffffff;
        text-shadow: 0 2px 4px rgba(0,0,0,0.9), 0 0 10px rgba(0,0,0,0.65);
      }
      /* Green while the ability is still firing, matching the game's own
         green cooldown ring; white once it is only recharging. */
      .qolc-cd-badge.qolc-cd-active {
        color: #5ff096;
        text-shadow: 0 2px 4px rgba(0,40,20,0.9), 0 0 10px rgba(0,80,40,0.7);
      }
      /* HP damage numbers. Same idea as the cooldown numbers: their own
         layer, so nothing is ever written into the game's own DOM. */
      #qolc-hp {
        position: fixed; inset: 0; z-index: 2147483644;
        pointer-events: none; overflow: hidden;
      }
      /* 1.35.0's boost counter. Its own fixed element rather than a child of
         the damage layer: that layer is cleared and rebuilt as numbers come
         and go, and this one has to sit still. Centred on its anchor with a
         transform, so the number stays over the health bar as its width
         changes from "9 boosts" to "10 boosts". */
      #qolc-boost {
        /* Pinned at the origin and moved entirely by a transform, which is
           composited rather than laid out and takes fractional pixels — see
           boostPlace(). The centring translate is folded into that same
           transform, because an element cannot have two. */
        position: fixed; left: 0; top: 0; display: none; z-index: 2147483644;
        pointer-events: none; will-change: transform;
        font-family: Quicksand, "Trebuchet MS", Verdana, sans-serif;
        font-weight: 800; line-height: 1; white-space: nowrap;
        font-variant-numeric: tabular-nums; color: #7fd4ff;
        -webkit-text-stroke: 0.6px rgba(0,0,0,0.55);
        text-shadow: 0 2px 5px rgba(0,0,0,0.95), 0 0 12px rgba(0,0,0,0.6);
      }
      /* Water's own colour is mope's #4E66E4, which is too dark to read over a
         night sky; these are the same hue opened up. The two warning bands are
         the point of the feature, so they are loud. */
      #qolc-boost.qolc-boost-low  { color: #ffd60a; }
      #qolc-boost.qolc-boost-none { color: #ff4a3d; }
      .qolc-hp-num {
        position: absolute; will-change: transform, opacity;
        font-family: Quicksand, "Trebuchet MS", Verdana, sans-serif;
        font-weight: 800; line-height: 1; white-space: nowrap;
        font-variant-numeric: tabular-nums;
        -webkit-text-stroke: 0.6px rgba(0,0,0,0.55);
        text-shadow: 0 2px 5px rgba(0,0,0,0.95), 0 0 12px rgba(0,0,0,0.6);
        animation: qolc-hp-float 1100ms cubic-bezier(0.16,0.84,0.44,1) forwards;
      }
      /* Plain damage to another animal. */
      .qolc-hp-basic  { color: #ff4a3d; }
      /* Plain damage to YOU. */
      .qolc-hp-you    { color: #ffd60a; }
      /* One tick of fire. */
      .qolc-hp-fire   { color: #ff8c17; }
      /* One tick of poison. */
      .qolc-hp-poison { color: #b45cff; }
      /* One tick of bleeding — deliberately darker than plain damage, since
         those two sit closest together and are the likeliest to be confused. */
      .qolc-hp-bleed  { color: #b8121f; }
      /* Your resource has run dry and it is costing you health. */
      .qolc-hp-dry    { color: #a5dcff; }
      /* Your own live HP, sitting above the ability cards. No border of its
         own: the background is copied from the game's cards at runtime, and an
         outline none of them have would give it away as something bolted on. */
      #qolc-hpbar {
        position: fixed; display: none; z-index: 2147483644;
        pointer-events: none; box-sizing: border-box;
        padding: 6px ${HP_BAR_PAD_X}px 7px; border-radius: 12px;
        background: rgba(0,0,0,0.28);
      }
      .qolc-hpbar-track {
        position: relative; height: 7px; border-radius: 4px; overflow: hidden;
        background: rgba(0,0,0,0.42);
      }
      .qolc-hpbar-fill {
        position: absolute; inset: 0 auto 0 0; width: 100%;
        border-radius: 4px; background: #4ad66d;
        transition: width 0.12s linear, background 0.25s linear;
      }
      /* One line per whole point of HP, drawn over the fill. Each line is
         painted directly rather than inheriting, so the colour cannot go
         missing on the way down. */
      .qolc-hpbar-ticks { position: absolute; inset: 0; }
      .qolc-hpbar-tick {
        position: absolute; top: 0; bottom: 0;
        background: #bcffd4; opacity: 0.92;
      }

      /* ---- what is currently being done to you, said with the bar ----
         Each state is a pulse rather than a flat colour, because a bar that
         merely changed shade would be competing with the green-amber-red it
         already uses to say how much health is left. Movement says "something
         is happening"; the colour says what. */
      /* Each one lights the panel from outside AND washes it from inside, so
         the state is unmistakable at a glance in a busy fight rather than
         being a halo you have to go looking for. */
      /* Healing off a gem: magenta, unhurried and pleased with itself. */
      .qolc-hpbar-gem { animation: qolc-hp-gem 1.35s ease-in-out infinite; }
      @keyframes qolc-hp-gem {
        0%, 100% { box-shadow: 0 0 8px 1px rgba(255,64,196,0.45),
                               inset 0 0 8px rgba(255,64,196,0.3); }
        50%      { box-shadow: 0 0 26px 8px rgba(255,64,196,0.95),
                               inset 0 0 20px rgba(255,80,205,0.75); }
      }
      /* An aloe leaf: the same idea in plain white, gentler. */
      .qolc-hpbar-aloe { animation: qolc-hp-aloe 1.5s ease-in-out infinite; }
      @keyframes qolc-hp-aloe {
        0%, 100% { box-shadow: 0 0 7px 1px rgba(255,255,255,0.35),
                               inset 0 0 7px rgba(255,255,255,0.22); }
        50%      { box-shadow: 0 0 22px 6px rgba(255,255,255,0.85),
                               inset 0 0 17px rgba(255,255,255,0.6); }
      }
      /* A whole aloe plant: brighter and twice as quick, because the healing
         it gives is on another scale entirely. */
      .qolc-hpbar-aloe-strong {
        animation: qolc-hp-aloe-strong 0.55s ease-in-out infinite;
      }
      @keyframes qolc-hp-aloe-strong {
        0%, 100% { box-shadow: 0 0 12px 3px rgba(255,255,255,0.6),
                               inset 0 0 12px rgba(255,255,255,0.45); }
        50%      { box-shadow: 0 0 34px 12px rgba(255,255,255,1),
                               inset 0 0 26px rgba(255,255,255,0.95); }
      }
      /* Poison: violet, and unlike the healing pulses it breathes rather than
         flashes — deeper, slower, and never fully letting go. */
      .qolc-hpbar-poison { animation: qolc-hp-poison 1.1s ease-in-out infinite; }
      @keyframes qolc-hp-poison {
        0%, 100% { box-shadow: 0 0 10px 2px rgba(150,60,255,0.55),
                               inset 0 0 10px rgba(150,60,255,0.4); }
        50%      { box-shadow: 0 0 26px 8px rgba(178,95,255,1),
                               inset 0 0 22px rgba(178,95,255,0.85); }
      }
      /* Fire: fast and uneven, the way a flame actually behaves. */
      .qolc-hpbar-fire { animation: qolc-hp-fire 0.4s ease-in-out infinite; }
      @keyframes qolc-hp-fire {
        0%   { box-shadow: 0 0 11px 2px rgba(255,120,20,0.8),
                           inset 0 0 10px rgba(255,120,20,0.5); }
        35%  { box-shadow: 0 0 30px 10px rgba(255,175,45,1),
                           inset 0 0 24px rgba(255,160,40,0.9); }
        60%  { box-shadow: 0 0 15px 3px rgba(255,96,10,0.85),
                           inset 0 0 13px rgba(255,96,10,0.6); }
        100% { box-shadow: 0 0 25px 7px rgba(255,140,25,1),
                           inset 0 0 20px rgba(255,140,25,0.8); }
      }
      /* Frozen by an aqua yeti: pale blue, and deliberately almost still — a
         slow crawl, to read as being held in place. */
      .qolc-hpbar-frost { animation: qolc-hp-frost 2.2s ease-in-out infinite; }
      @keyframes qolc-hp-frost {
        0%, 100% { box-shadow: 0 0 12px 3px rgba(150,220,255,0.6),
                               inset 0 0 12px rgba(150,220,255,0.45); }
        50%      { box-shadow: 0 0 28px 9px rgba(215,245,255,1),
                               inset 0 0 24px rgba(215,245,255,0.9); }
      }
      .qolc-hpbar-text {
        margin-top: 4px; text-align: center;
        font: 700 11.5px/1.1 Quicksand, "Trebuchet MS", Verdana, sans-serif;
        font-variant-numeric: tabular-nums; color: #ffffff;
        text-shadow: 0 1px 3px rgba(0,0,0,0.95);
      }
      /* Anything happening to YOU rather than to what you are fighting. The
         glow is drawn from the number's own colour, so each kind keeps its
         identity while still reading as yours at a glance. */
      .qolc-hp-self {
        text-shadow:
          0 0 7px currentColor, 0 0 16px currentColor,
          0 2px 5px rgba(0,0,0,0.95), 0 0 12px rgba(0,0,0,0.6);
      }
      @keyframes qolc-hp-float {
        0%   { opacity: 0; transform: translate(-50%,-50%) translateY(7px) scale(0.7); }
        14%  { opacity: 1; transform: translate(-50%,-50%) translateY(-7px) scale(1.14); }
        32%  { opacity: 1; transform: translate(-50%,-50%) translateY(-17px) scale(1); }
        100% { opacity: 0; transform: translate(-50%,-50%) translateY(-48px) scale(0.94); }
      }
      /* ---- design tokens (menu v2) ----
         Declared on the panel rather than :root so nothing leaks into mope's
         own page, which this script shares. */
      #qolc-panel {
        --qolc-ink: #eafffb;
        --qolc-dim: rgba(234,255,251,0.68);
        --qolc-faint: rgba(234,255,251,0.46);
        --qolc-accent: #35c9b6;
        --qolc-accent-lit: #7ff0e3;
        --qolc-accent-ink: #04241f;
        --qolc-card: rgba(183,255,247,0.13);
        --qolc-edge: rgba(203,255,250,0.16);
        --qolc-edge-lit: rgba(203,255,250,0.34);
        --qolc-inset: rgba(0,48,42,0.34);
        --qolc-nav: rgba(0,52,46,0.26);
        --qolc-nav-active: rgba(53,201,182,0.26);
        --qolc-field: rgba(0,55,45,0.42);
        --qolc-switch-off: rgba(0,40,34,0.42);
        --qolc-row-pad: 14px;
        /* The panel's own gradient, a property since 1.0.7 so a theme can
           reach it. Without this a theme recolours every control and leaves
           the shell teal, which reads as a bug rather than as a theme. */
        --qolc-shell: linear-gradient(155deg, rgba(54,207,194,0.34), rgba(9,74,84,0.56));
      }

      /* ---- header ---- */
      .qolc-head {
        display: flex; align-items: center; gap: 14px;
        padding: 13px 18px; flex-shrink: 0;
        border-bottom: 1px solid var(--qolc-edge);
      }
      .qolc-head-text { flex: 1; min-width: 0; }
      .qolc-title {
        font-size: 19px; font-weight: 700; letter-spacing: 0.1px;
        text-shadow: 0 2px 4px rgba(0,45,40,0.45);
      }
      .qolc-sub {
        margin-top: 1px; font-size: 10px; font-weight: 700;
        letter-spacing: 1.5px; color: var(--qolc-faint);
      }
      .qolc-head-div {
        width: 1px; height: 24px; flex-shrink: 0;
        background: var(--qolc-edge);
      }
      .qolc-close {
        width: 26px; height: 26px; flex-shrink: 0; border: 0; padding: 0;
        border-radius: 8px; background: transparent; cursor: pointer;
        color: var(--qolc-dim); font: 14px/1 system-ui, sans-serif;
        display: flex; align-items: center; justify-content: center;
        transition: background 0.14s ease;
      }
      .qolc-close:hover { background: var(--qolc-card); color: var(--qolc-ink); }

      /* ---- body: sidebar + content ---- */
      .qolc-body {
        flex: 1; min-height: 0;
        display: grid; grid-template-columns: 208px minmax(0, 1fr);
      }
      .qolc-side {
        padding: 10px; box-sizing: border-box; overflow-y: auto; min-height: 0;
        background: var(--qolc-nav);
        border-right: 1px solid var(--qolc-edge);
        display: flex; flex-direction: column; gap: 2px;
      }
      .qolc-side-label {
        margin: 8px 8px 4px; font-size: 9.5px; font-weight: 700;
        letter-spacing: 1.3px; text-transform: uppercase; color: var(--qolc-faint);
      }
      .qolc-side-label:first-child { margin-top: 0; }
      .qolc-side-item {
        position: relative; padding: 8px 11px; border-radius: 10px;
        font-size: 13px; font-weight: 600; cursor: pointer;
        color: var(--qolc-dim); background: transparent;
        transition: background 0.14s ease, color 0.14s ease;
      }
      .qolc-side-item:hover { background: var(--qolc-card); }
      .qolc-side-item.active {
        background: var(--qolc-nav-active); color: #ffffff;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.22);
      }
      /* The active mark is ALWAYS in the DOM and merely transparent when the
         item is idle, so selecting an item cannot shift its text sideways. */
      .qolc-side-mark {
        position: absolute; left: 4px; top: 50%; margin-top: -7px;
        width: 2px; height: 14px; border-radius: 1px; background: transparent;
      }
      .qolc-side-item.active .qolc-side-mark { background: var(--qolc-accent-lit); }

      .qolc-content {
        /* min-height:0 matters: a grid item defaults to min-height:auto, so
           without it the content column grows to fit its tallest pane and
           pushes straight out of the panel — the pane's own overflow:hidden
           never gets the chance to clip anything. */
        min-width: 0; min-height: 0; display: flex; flex-direction: column;
      }
      /* Hidden unless its category is the one on screen. This is a CLASS and
         not an inline style on purpose: the panel is built with none of them
         showing, so a build that somehow never selects a category shows an
         empty pane rather than all four titles stacked on top of each other —
         which is exactly what 1.26.0 did on first open. */
      .qolc-cat-title {
        padding: 14px 20px 10px; font-size: 15px; font-weight: 700; flex-shrink: 0;
        display: none;
      }
      .qolc-cat-title.active { display: block; }
      /* The pane is a FIXED box, not a growing one — overflow hidden rather
         than auto, because the six categories were sized so that nothing needs
         to scroll. If a future row overflows it will be clipped, which is a
         loud failure rather than a quiet one, and the right answer then is a
         new category rather than a scrollbar. */
      /* The pane scrolls now. 1.25.0 clipped instead, on the argument that a
         row which does not fit should fail loudly — but merging six categories
         into four put Cosmetics and Party legitimately over the 376px budget,
         and losing a control is not a better outcome than a scrollbar. The
         SHELL is still fixed: the pane scrolls inside a panel whose size never
         changes, which is the property that mattered. */
      .qolc-pane {
        flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;
        padding: 0 20px; display: none; flex-direction: column; gap: 7px;
        scrollbar-width: thin;
        scrollbar-color: rgba(127,240,227,0.42) transparent;
      }
      /* Themed rather than left to the browser: a default scrollbar is a grey
         slab against turquoise glass and reads as a piece of the page showing
         through the panel. Sized to sit inside the pane's own 20px gutter. */
      #qolc-panel .qolc-pane::-webkit-scrollbar { width: 8px; }
      #qolc-panel .qolc-pane::-webkit-scrollbar-track { background: transparent; }
      #qolc-panel .qolc-pane::-webkit-scrollbar-thumb {
        border-radius: 8px;
        background: linear-gradient(180deg, rgba(127,240,227,0.5), rgba(53,201,182,0.38));
        border: 1px solid rgba(203,255,250,0.22);
      }
      #qolc-panel .qolc-pane::-webkit-scrollbar-thumb:hover {
        background: linear-gradient(180deg, rgba(127,240,227,0.7), rgba(53,201,182,0.55));
      }
      .qolc-pane.active { display: flex; }
      /* A caption over a few related rows. Sits in the pane's flex flow, so
         its own margin is what separates one group from the next — the first
         one loses that margin because the category title already provides it. */
      .qolc-sec {
        margin: 9px 2px 1px; font-size: 9.5px; font-weight: 700;
        letter-spacing: 1.3px; text-transform: uppercase; color: var(--qolc-faint);
        flex-shrink: 0;
      }
      .qolc-pane > .qolc-sec:first-child { margin-top: 0; }
      /* A run of rows that has to keep its place in a pane built in two passes.
         Same 7px rhythm as the pane itself, so nesting is invisible. */
      .qolc-stack { display: flex; flex-direction: column; gap: 7px; flex-shrink: 0; }
      .qolc-stack + .qolc-stack { margin-top: 0; }

      /* The hover description. Its space is always reserved, so showing and
         hiding it cannot change the panel's shape. */
      .qolc-info {
        margin: 12px 20px 16px; min-height: 58px; box-sizing: border-box;
        padding: 11px 14px; border-radius: 12px; flex-shrink: 0;
        border: 1px solid rgba(203,255,250,0.14);
        background: rgba(0,48,42,0.3);
        font-size: 12.5px; line-height: 1.45; color: var(--qolc-dim);
        opacity: 0; transition: opacity 0.14s ease;
      }
      .qolc-info.show { opacity: 1; }

      #qolc-panel.qolc-off .qolc-content { opacity: 0.5; }

      /* ---- rows ---- */
      .qolc-row {
        display: flex; align-items: center; gap: 14px;
        padding: var(--qolc-row-pad) 15px; border-radius: 12px;
        border: 1px solid var(--qolc-edge); background: var(--qolc-card);
        font-size: 14px; font-weight: 600; flex-shrink: 0;
        transition: border-color 0.14s ease;
      }
      .qolc-row:hover { border-color: var(--qolc-edge-lit); }
      .qolc-row-name { flex: 1; min-width: 0; }
      /* Descriptions live in the info bar now. The class is kept because rows
         that carry live STATUS text still use it — the camera hook and the
         registry — but it is no longer where a setting is explained. */
      .qolc-row-note { font-size: 12px; font-weight: 600; color: var(--qolc-dim); }

      /* A parent and its dependent settings are ONE card: the parent is its
         header, the children sit inside on a darker inset. Nesting carries the
         relationship, so there is no branch to draw and nothing to line up. */
      .qolc-card {
        border-radius: 12px; border: 1px solid var(--qolc-edge);
        background: var(--qolc-card); flex-shrink: 0;
        transition: border-color 0.14s ease;
      }
      .qolc-card:hover { border-color: var(--qolc-edge-lit); }
      .qolc-card > .qolc-row {
        border: 0; background: none; border-radius: 0; padding-bottom: 0;
      }
      .qolc-card > .qolc-row:hover { border-color: transparent; }
      .qolc-kids {
        padding: 12px 12px 12px; display: flex; flex-direction: column; gap: 5px;
      }
      .qolc-subrow {
        display: flex; align-items: center; gap: 14px;
        padding: 10px 13px; border-radius: 9px;
        background: var(--qolc-inset); font-size: 13px; font-weight: 600;
      }
      .qolc-subrow .qolc-row-name { flex: 1; min-width: 0; }
      .qolc-row-off { opacity: 0.42; pointer-events: none; }
      /* A block of related controls inside a card — the relay picker, the
         roster, the dot palette, the handle field. Same inset as a sub-row,
         but it lays out down the page instead of across it. */
      .qolc-subblock {
        padding: 10px 13px; border-radius: 9px; background: var(--qolc-inset);
      }
      .qolc-subblock > :first-child { margin-top: 0; }
      /* A status line that sits inside a card rather than under a section. */
      .qolc-sub-status { margin-top: 0; padding: 0 3px; font-size: 12px; }
      /* The party code field, made to sit as a sub-row. */
      .qolc-subrow.qolc-party-field { display: flex; align-items: center; }
      .qolc-tagprev { gap: 12px; }
      /* Dot palette and handle sit on one line each, control right-aligned. */
      .qolc-row > .qolc-party-palette, .qolc-subrow > .qolc-party-palette {
        margin-top: 0; flex: 0 0 auto; justify-content: flex-end;
      }
      /* Label, then the account status, then the override field — all on one
         line. The status is the only part allowed to give way, because it is
         the only part that is a sentence. */
      .qolc-handle-row > .qolc-row-name { flex: 0 0 auto; white-space: nowrap; }
      .qolc-handle-row .qolc-row-note {
        flex: 1 1 auto; min-width: 0; font-size: 11.5px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .qolc-handle-row > .qolc-party-field { margin-top: 0; flex: 1 1 200px; min-width: 0; }
      .qolc-subrow > .qolc-party-relays { margin-top: 0; flex: 0 0 auto; justify-content: flex-end; }
      /* 1.31.0's units picker sits on one line, control right, the same shape
         the relay picker takes. The mode tabs are built to stack UNDER a
         heading everywhere else, so both the top margin and the growth have to
         be taken back off here. A width rather than a flex basis: two equal
         buttons that do not resize as the label beside them changes. */
      .qolc-units-row > .qolc-mode-tabs { margin-top: 0; flex: 0 0 186px; }
      /* 1.33.0's quick-chat slots. The number is a fixed, centred gutter so
         all five fields start on the same column — a flexed label would set
         its width from its own text, and "1" through "5" are not all the same
         width in Quicksand. */
      .qolc-chat-row > .qolc-row-name {
        flex: 0 0 18px; text-align: center; opacity: 0.75;
      }
      .qolc-chat-row > .qolc-chat-field { margin-top: 0; flex: 1 1 auto; min-width: 0; }
      .qolc-row.qolc-handle-row > .qolc-party-field { margin-top: 0; flex: 1 1 200px; min-width: 0; }
      /* The roster is the only thing in the panel whose height depends on other
         people. Everything else is a fixed list of settings, so this is the one
         place a scrollbar belongs — without it a party of six would push the
         card past a pane that cannot grow. */
      .qolc-party-roster {
        max-height: 104px; overflow-y: auto; margin-top: 0;
        scrollbar-width: thin;
        scrollbar-color: rgba(73,225,211,0.7) rgba(4,48,57,0.28);
      }
      .qolc-tagprev-name {
        font-size: 15px; font-weight: 700; min-width: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }

      /* ---- controls ---- */
      .qolc-switch {
        position: relative; width: 40px; height: 22px; border-radius: 11px;
        background: var(--qolc-switch-off); cursor: pointer; flex-shrink: 0;
        box-shadow: inset 0 1px 2px rgba(0,40,34,0.4);
        transition: background 0.15s ease;
      }
      .qolc-switch::after {
        content: ""; position: absolute; top: 3px; left: 3px;
        width: 16px; height: 16px; border-radius: 50%; background: #fff;
        box-shadow: 0 1px 3px rgba(0,40,34,0.35);
        transition: left 0.15s ease;
      }
      .qolc-switch.on { background: var(--qolc-accent); }
      .qolc-switch.on::after { left: 21px; }
      .qolc-master { width: 46px; height: 24px; border-radius: 12px; }
      .qolc-master::after { width: 18px; height: 18px; }
      .qolc-master.on::after { left: 25px; }

      .qolc-pill {
        padding: 6px 11px; border-radius: 8px; cursor: pointer;
        border: 1px solid var(--qolc-edge); background: rgba(0,48,42,0.3);
        color: var(--qolc-dim); font: 700 12px/1 Quicksand, system-ui, sans-serif;
        transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
      }
      .qolc-pill:hover { background: var(--qolc-card); }
      .qolc-pill.on {
        background: var(--qolc-accent); border-color: rgba(255,255,255,0.5);
        color: var(--qolc-accent-ink);
      }
      /* 1.29.0 gave these room. At 5px/12px around a 12px face the text sat
         hard against the border on every one of them — New, Copy, Re-hook,
         Reset all — and read as cramped rather than as a button. The line-height
         is the other half of it: font: 700 12px/1 means the box is exactly
         the cap height, so the vertical padding was doing all the work on its
         own. A min-width keeps the two-letter labels from coming out narrower
         than the ones beside them. */
      .qolc-obtn {
        padding: 8px 16px; min-width: 62px; border-radius: 9px; cursor: pointer;
        border: 1px solid var(--qolc-edge); background: transparent;
        color: var(--qolc-ink); font: 700 12px/1.25 Quicksand, system-ui, sans-serif;
        transition: background 0.14s ease;
      }
      .qolc-obtn.qolc-obtn-key { border-color: rgba(203,255,250,0.3); }
      /* Small enough that three fit on a subrow beside their label. */
      .qolc-obtn-sm { padding: 5px 10px; min-width: 0; font-size: 11px; border-radius: 7px; }
      .qolc-obtn:hover { background: var(--qolc-card); }
      /* The zoom stepper reuses the row shell, and its buttons deliberately
         borrow the switch's colours so the panel reads as one control set. */
      .qolc-zoom-steps {
        display: flex; align-items: center; gap: 6px;
        flex-shrink: 0; margin-left: 10px;
      }
      .qolc-zoom-step {
        width: 24px; height: 24px; border-radius: 8px; cursor: pointer; padding: 0;
        border: 1px solid rgba(203,255,250,0.22); background: rgba(0,40,20,0.35);
        color: #eafffb; font: bold 14px/1 monospace;
        transition: background 0.15s ease, opacity 0.15s ease;
      }
      .qolc-zoom-step:hover:not(:disabled) { background: rgba(183,255,247,0.25); }
      .qolc-zoom-step:disabled { opacity: 0.35; cursor: default; }
      .qolc-zoom-value {
        min-width: 42px; text-align: center; font-size: 12px; font-weight: bold;
        font-variant-numeric: tabular-nums; color: #ffffff;
      }
      /* The re-hook control. Deliberately NOT given .qolc-row-off when the
         camera is unhooked: greying out the one button that fixes an unhooked
         camera, precisely when the camera is unhooked, is the mistake this row
         exists to avoid. It is also unaffected by whether Lumi's Moderator
         Extras is on the page — there is one shared hook now, so there is
         nothing to defer to. */
      .qolc-hook-btn {
        flex-shrink: 0; margin-left: 10px; padding: 4px 10px;
        border-radius: 8px; cursor: pointer;
        border: 1px solid rgba(203,255,250,0.22); background: rgba(0,40,20,0.35);
        color: #eafffb; font: bold 11px/1.4 Quicksand, "Trebuchet MS", sans-serif;
        transition: background 0.15s ease, opacity 0.15s ease;
      }
      .qolc-hook-btn:hover:not(:disabled) { background: rgba(183,255,247,0.25); }
      .qolc-hook-btn:disabled { opacity: 0.5; cursor: default; }
      .qolc-hook-ok .qolc-row-note { color: #b7fff2; }
      .qolc-hook-bad .qolc-row-note { color: #ffd9a0; }
      /* Party map. The name tags are their own fixed layer rather than panel
         children, because they track the minimap on the game canvas. */
      #qolc-party {
        position: fixed; left: 0; top: 0; width: 0; height: 0;
        pointer-events: none; z-index: 2147483000;
      }
      .qolc-party-tag {
        position: fixed; transform: translate(-50%, -165%);
        pointer-events: none; white-space: nowrap;
        font: bold 10px/1 system-ui, -apple-system, sans-serif; color: #fff;
        text-shadow: 0 1px 2px rgba(0,0,0,0.95), 0 0 4px rgba(0,0,0,0.85);
      }
      /* Party chat. The stack has one fixed viewport-space anchor above the
         screen centre, with the lines laid out inside it — newest nearest the
         player, the way chat reads. Camera zoom and Pixi animation cannot
         move it because neither participates in this layout. */
      #qolc-party-chat {
        position: fixed; display: none; pointer-events: none;
        left: 50%; top: calc(50% - ${PARTY_CHAT_FIXED_RISE}px);
        transform: translate(-50%, -100%);
        flex-direction: column; align-items: center; gap: 4px;
      }
      /* A message is a BOX, the way mope draws its own chat above a head,
         rather than bare text floating on the map. Bare text was unreadable
         over light terrain however heavy its shadow, and it read as an
         overlay rather than as part of the game.
         1.16.0 split the colour off the line and onto the handle in front of
         it. The box is a dark indigo and the message is plain white against
         it, which is the highest-contrast thing the box can hold; the handle
         keeps the dot colour, and keeps the paired outline as a halo, because
         the darker presets — Ultramarine and Azure especially — are the whole
         reason that pairing exists. */
      .qolc-party-line {
        font: 700 21px/1.25 Quicksand, "Trebuchet MS", Verdana, sans-serif;
        white-space: nowrap; max-width: 46vw; overflow: hidden;
        text-overflow: ellipsis;
        padding: 5px 13px; border-radius: 13px;
        background: rgba(22,24,28,0.76);
        box-shadow: 0 2px 7px rgba(0,0,0,0.35);
        color: #ffffff;
      }
      /* The gap after the colon is a margin rather than a space in the text,
         so it cannot be collapsed, trimmed or wrapped away from the handle it
         belongs to. */
      .qolc-party-said { margin-left: 0.32em; color: #ffffff; }
      .qolc-party-who { font-weight: 800; }
      /* The party list, under mope's leaderboard.

         Deliberately WITHOUT a box. The leaderboard already sits on a .HUDBox
         (a #00000040 scrim with a large radius) and a second dark panel hung
         underneath it would read as an overlay bolted onto the HUD rather than
         as more of it. What holds the text up over grass, sand and snow is the
         same thing that holds mope's own canvas text up: a heavy shadow.

         Everything is sized in dvmin, which is what mope sizes the leaderboard
         in — 1.5dvmin is #leaderboardContent's own font-size, so a row here is
         the same height as a row up there on every screen and at every zoom,
         including the 1.35 mope applies on mobile. The layer's left, top and
         width are the only things written from script, and they come from the
         leaderboard's measured rectangle. */
      #qolc-party-list {
        box-sizing: border-box;
        position: fixed; display: none; flex-direction: column;
        gap: 0.55dvmin; pointer-events: none; z-index: 2147482000;
        font-family: Rubik, Quicksand, "Trebuchet MS", Verdana, sans-serif;
        font-size: 1.5dvmin; font-weight: 500; line-height: 1.15;
        color: #ffffff;
        text-shadow: 0 1px 2px rgba(0,0,0,0.95), 0 0 5px rgba(0,0,0,0.8);
      }
      .qolc-pl-row {
        display: flex; align-items: center; gap: 0.6dvmin;
        min-width: 0; white-space: nowrap;
      }
      /* A member who has gone quiet fades on the same timer their dot does, so
         the list and the map never disagree about who is still there. */
      .qolc-pl-row.is-stale { opacity: 0.42; }
      /* Sized in em so it tracks the row's own font rather than the viewport
         twice over. The slot keeps its width whether or not a picture loaded,
         which is what stops the names jittering as members change animal. */
      .qolc-pl-art {
        width: 2.1em; height: 2.1em; flex-shrink: 0;
        object-fit: contain; object-position: center;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,0.75));
      }
      /* 1.22.0. Two lines: name + health, then handle + XP. See the row
         builder for why a second line beats every attempt to fit four things
         across one. The tight line-height is what keeps both inside the height
         the 2.1em animal picture was already setting. */
      .qolc-pl-col {
        flex: 1 1 auto; min-width: 0;
        display: flex; flex-direction: column; line-height: 1.14;
      }
      .qolc-pl-l1, .qolc-pl-l2 {
        display: flex; align-items: baseline; gap: 0.5dvmin; min-width: 0;
      }
      /* The name takes the whole of its own line, so it is the thing that
         grows and the number beside it is fixed. */
      .qolc-pl-name {
        flex: 1 1 auto; min-width: 0; font-weight: 700;
        overflow: hidden; text-overflow: ellipsis;
      }
      .qolc-pl-hp {
        flex: 0 0 auto; font-weight: 700; font-size: 0.84em;
        font-variant-numeric: tabular-nums;
      }
      /* The second line is the quiet one: smaller and dimmer as a whole, so
         neither of the two things on it competes with the name above. */
      .qolc-pl-l2 { font-size: 0.74em; opacity: 0.62; }
      /* No flex-shrink: 20 any more. That existed to make the handle collapse
         before the name when they shared a line; with only XP beside it,
         ordinary ellipsis does the job. */
      .qolc-pl-handle {
        flex: 1 1 auto; min-width: 0;
        overflow: hidden; text-overflow: ellipsis;
      }
      .qolc-pl-xp {
        flex: 0 0 auto; font-variant-numeric: tabular-nums;
      }

      /* mope's own HUD corner, rearranged while the arena sky is up. Keyed on
         one class on <html> so that Svelte rebuilding that corner — which it
         does whenever the HUD changes — cannot drop it, and so that taking the
         class off restores everything in a single assignment.

         mope builds it as
           #mapContainer > [ #mapSideButtons > #settingsButton2 , #minimap ]
           #gameStats    > .gameStatsRow x2
         and #minimap is a real 23 by 21dvmin div even when nothing is drawn in
         it, which is what strands the gear and the stats mid-screen. */
      html.qolc-arena-hud #minimap { display: none !important; }
      /* With the minimap collapsed the buttons are the only thing left in the
         row, so this is what puts them at its right-hand end rather than its
         left. No positioning games — they stay exactly where mope's own layout
         chose to put that row. */
      html.qolc-arena-hud #mapSideButtons { margin-left: auto !important; }
      /* The stats block has to cross the screen, so this one is positioned.
         Where it actually lands is measured afterwards and reported by
         __lumiArenaDebug(), because "fixed" answers to a transformed ancestor
         rather than the viewport and mope's HUD is not ours to promise about. */
      html.qolc-arena-hud #gameStats {
        position: fixed !important;
        top: 1.5dvmin !important; left: 1.5dvmin !important;
        right: auto !important; bottom: auto !important;
        align-items: flex-start !important;
      }
      /* mope right-aligns these rows with "margin-left: auto", which reads
         backwards once the block is on the left. */
      html.qolc-arena-hud #gameStats .gameStatsRow {
        margin-left: 0 !important; margin-right: auto !important;
        justify-content: flex-start !important;
      }
      /* A button another extension parks under the settings gear, dressed as a
         star for as long as the sky is up.

         MASKED rather than clipped, deliberately: clip-path clips hit-testing
         too, so a clipped button loses every click that lands on the corners it
         used to fill. A mask paints the star and leaves the button's own box
         exactly as clickable as it was. Nothing here touches what it does.

         Its own contents are hidden rather than removed — including whatever
         count it was carrying, which is the one thing this costs. */
      html.qolc-arena-hud .qolc-arena-star {
        --qolc-star: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cpolygon points='50,1 62,35 98,35 69,57 81,93 50,71 19,93 31,57 2,35 38,35' fill='%23fff'/%3E%3C/svg%3E");
        background: radial-gradient(circle at 50% 40%,
          #f2ffe2 0%, #9dfb66 18%, #7ef05c 40%, #35c246 72%, #14892c 100%) !important;
        border: 0 !important;
        border-radius: 0 !important;
        box-shadow: none !important;
        -webkit-mask-image: var(--qolc-star);
        mask-image: var(--qolc-star);
        -webkit-mask-size: 100% 100%;
        mask-size: 100% 100%;
        -webkit-mask-repeat: no-repeat;
        mask-repeat: no-repeat;
        filter: drop-shadow(0 0 7px rgba(126, 240, 92, 0.55));
        transform: scale(1.22);
      }
      html.qolc-arena-hud .qolc-arena-star > * { visibility: hidden !important; }
      /* The channel message, deliberately matched to #qolc-game-hint above:
         same place on screen, same family, size and weight, so a channel
         switch reads as the same KIND of announcement the game-entering hint
         does. Pink rather than teal because it is saying something different.
         Its first home was a small line above the HUD, which put it straight
         through the oxygen bar and was too small to notice. */
      #qolc-party-toast {
        position: fixed; left: 50%; top: 50%;
        transform: translate(-50%, -125px);
        z-index: 2147483645; pointer-events: none; display: none;
        max-width: min(760px, 88vw); box-sizing: border-box; text-align: center;
        font-family: Quicksand, "Trebuchet MS", Verdana, sans-serif;
        font-size: clamp(15px, 1.45vw, 20px); font-weight: 700;
        line-height: 1.25; letter-spacing: 0.1px;
        color: #ff5ec4;
        text-shadow: 0 2px 3px rgba(40,0,25,0.95), 0 0 11px rgba(255,94,196,0.62);
      }
      #qolc-party-toast.is-bad {
        color: #ff8a8a;
        text-shadow: 0 2px 3px rgba(45,0,0,0.95), 0 0 11px rgba(255,120,120,0.62);
      }
      /* Neutral, for anything that is not party chat saying which channel you
         are on. Teal-blue rather than pink, matching #qolc-game-hint, because
         it is the same kind of announcement that one makes. */
      #qolc-party-toast.is-info {
        color: #9ad9ff;
        text-shadow: 0 2px 3px rgba(0,25,45,0.95), 0 0 11px rgba(120,200,255,0.55);
      }
      /* The party input rides INSIDE the message stack, as its last child, so
         it sits directly above your own animal with anything already said
         stacked above it — you type where the message will appear. It was
         originally pinned to the bottom of the screen, which landed it on top
         of the XP and oxygen bars. Laid out in flow rather than positioned;
         the stack is what gets placed each frame.
         Built to look like mope's own chat box, down to the placeholder, with
         the border colour as the ONE difference: pink where mope's is green.
         That is deliberate and was asked for — but it does mean the outline is
         now the only thing telling the two apart, so it is a real border
         width rather than a hairline. */
      #qolc-party-input {
        display: none; align-items: center; justify-content: center;
        border-radius: 11px; pointer-events: auto;
        background: rgba(22,24,28,0.76);
        border: 3px solid #ff5ec4;
        box-shadow: 0 2px 10px rgba(0,0,0,0.35);
      }
      #qolc-party-input input {
        width: 250px; max-width: 46vw; padding: 8px 14px; border: 0;
        background: transparent; outline: none; color: #ffffff;
        text-align: center;
        font: 500 17px/1.3 Quicksand, "Trebuchet MS", Verdana, sans-serif;
      }
      #qolc-party-input input::placeholder { color: rgba(222,228,244,0.75); }
      .qolc-party-field { display: flex; gap: 6px; margin-top: 9px; }
      .qolc-party-field input {
        flex: 1; min-width: 0; padding: 7px 9px; border-radius: 9px;
        border: 1px solid rgba(203,255,250,0.2); background: rgba(0,40,20,0.3);
        color: #fff; font: bold 12px/1.2 monospace; letter-spacing: 1px;
        box-sizing: border-box;
      }
      .qolc-party-field input::placeholder { color: rgba(255,255,255,0.38); letter-spacing: 0; }
      .qolc-party-btn {
        padding: 0 10px; border-radius: 9px; cursor: pointer;
        border: 1px solid rgba(203,255,250,0.22); background: rgba(0,40,20,0.35);
        color: #eafffb; font: bold 11px/1 system-ui, sans-serif;
        transition: background 0.15s ease;
      }
      .qolc-party-btn:hover { background: rgba(183,255,247,0.25); }
      .qolc-party-status {
        margin-top: 9px; font-size: 10.5px; line-height: 1.4;
        color: rgba(255,255,255,0.82);
      }
      .qolc-party-status::before {
        content: ""; display: inline-block; width: 7px; height: 7px;
        border-radius: 50%; margin-right: 6px; vertical-align: 1px;
        background: rgba(255,255,255,0.35);
      }
      .qolc-party-status.is-ok::before { background: #6adb41; }
      .qolc-party-status.is-wait::before { background: #ffd166; }
      .qolc-party-status.is-bad::before { background: #e4384c; }
      /* The dot palette borrows .qolc-color from the name picker so the panel's
         two colour choosers read as one control; only the layout is new, since
         six swatches do not want the name palette's eight-column grid. */
      .qolc-party-label { margin-top: 11px; font-size: 12px; font-weight: bold; }
      .qolc-party-palette { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 8px; }
      /* Relay picker. Two buttons can be lit at once and that is deliberate:
         on Auto, the Auto button shows the MODE and the relay button shows
         where you actually are — which is the thing two people have to
         compare. */
      .qolc-party-relays { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
      .qolc-party-relay {
        padding: 5px 9px; border-radius: 9px; cursor: pointer;
        border: 1px solid rgba(203,255,250,0.22); background: rgba(0,40,20,0.35);
        color: #eafffb; font: bold 10.5px/1 system-ui, sans-serif;
        transition: background 0.15s ease, border-color 0.15s ease;
      }
      .qolc-party-relay:hover { background: rgba(183,255,247,0.25); }
      .qolc-party-relay.is-on {
        background: var(--qolc-accent); border-color: var(--qolc-accent-lit); color: var(--qolc-accent-ink);
      }
      /* ---- keybinds (1.0.7) ---- */
      .qolc-kb-list { display: grid; gap: 5px; margin-top: 8px; }
      .qolc-kb-row {
        display: flex; align-items: center; gap: 9px;
        padding: 7px 10px; border-radius: 9px; font-size: 12px;
        background: var(--qolc-card); border: 1px solid var(--qolc-edge);
      }
      .qolc-kb-row.has-clash { border-color: rgba(255,196,90,0.5); }
      .qolc-kb-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      /* Fixed width so the caps line up down the column and the eye can run
         the list without re-finding the key each row. */
      .qolc-kb-cap {
        flex: 0 0 auto; min-width: 74px; text-align: center;
        padding: 5px 10px; border-radius: 8px; cursor: pointer;
        border: 1px solid var(--qolc-edge-lit); background: var(--qolc-field);
        color: var(--qolc-ink); font: bold 11px/1 "Consolas", ui-monospace, monospace;
        transition: background 0.15s ease, border-color 0.15s ease;
      }
      .qolc-kb-cap:hover { background: var(--qolc-nav-active); }
      .qolc-kb-cap.is-armed {
        background: var(--qolc-accent); border-color: var(--qolc-accent-lit);
        color: var(--qolc-accent-ink); min-width: 96px;
      }
      /* An unbound cap should read as deliberately empty rather than as a
         control that failed to render, so it says so in words and is dimmed
         instead of being left blank. */
      .qolc-kb-cap.is-unbound {
        color: var(--qolc-faint); font-style: italic;
        font-weight: normal; letter-spacing: 0.02em;
      }
      /* Always in the row, so clearing or setting a bind never reflows the
         line — only its visibility changes. */
      .qolc-kb-clear {
        flex: 0 0 auto; width: 22px; height: 22px; padding: 0;
        display: flex; align-items: center; justify-content: center;
        border-radius: 7px; cursor: pointer;
        border: 1px solid var(--qolc-edge); background: var(--qolc-inset);
        color: var(--qolc-dim); font: bold 13px/1 system-ui, sans-serif;
        transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
      }
      .qolc-kb-clear:hover {
        background: #ff6b5e; border-color: #ff6b5e; color: #fff;
      }
      .qolc-kb-clear.is-idle { visibility: hidden; pointer-events: none; }
      .qolc-kb-prio {
        flex: 0 0 auto; min-width: 78px; text-align: center;
        padding: 5px 9px; border-radius: 8px; cursor: pointer;
        border: 1px solid var(--qolc-edge); background: var(--qolc-inset);
        color: var(--qolc-dim); font: bold 10px/1 system-ui, sans-serif;
        letter-spacing: 0.03em;
        transition: background 0.15s ease, color 0.15s ease;
      }
      .qolc-kb-prio.is-over {
        background: var(--qolc-accent); border-color: var(--qolc-accent-lit);
        color: var(--qolc-accent-ink);
      }
      /* Always in the row and empty when there is nothing wrong, so a clash
         appearing does not shift the whole line sideways. */
      .qolc-kb-haz {
        flex: 0 0 auto; width: 20px; text-align: center;
        font: bold 12px/1 system-ui, sans-serif; color: transparent;
      }
      .qolc-kb-haz.is-bound, .qolc-kb-haz.is-fixed { color: #ffc45a; }
      .qolc-kb-haz.is-ours { color: #ff6b5e; }
      .qolc-kb-foot {
        display: flex; align-items: center; gap: 10px; margin-top: 9px;
      }
      .qolc-kb-note {
        flex: 1; min-width: 0; font-size: 10.5px; line-height: 1.4;
        color: var(--qolc-faint);
      }
      .qolc-kb-note.is-bound, .qolc-kb-note.is-fixed { color: #ffc45a; }
      .qolc-kb-note.is-ours { color: #ff6b5e; }

      /* ---- panel themes (1.0.7) ----
         Every control already reads its colour from these properties, so a
         theme is this block and nothing else. --qolc-shell is the panel's own
         gradient, lifted out of the rule above so a theme can reach it. */
      #qolc-panel[data-qolc-theme="ember"] {
        --qolc-ink: #fff1e6;
        --qolc-dim: rgba(255,241,230,0.68);
        --qolc-faint: rgba(255,241,230,0.46);
        --qolc-accent: #e2703a;
        --qolc-accent-lit: #ffb27a;
        --qolc-accent-ink: #2b1004;
        --qolc-card: rgba(255,214,184,0.13);
        --qolc-edge: rgba(255,214,184,0.18);
        --qolc-edge-lit: rgba(255,214,184,0.36);
        --qolc-inset: rgba(56,20,6,0.38);
        --qolc-nav: rgba(58,22,8,0.3);
        --qolc-nav-active: rgba(226,112,58,0.28);
        --qolc-field: rgba(58,22,8,0.46);
        --qolc-switch-off: rgba(48,18,6,0.46);
        --qolc-shell: linear-gradient(155deg, rgba(214,106,54,0.34), rgba(74,26,9,0.6));
      }
      #qolc-panel[data-qolc-theme="violet"] {
        --qolc-ink: #f3ecff;
        --qolc-dim: rgba(243,236,255,0.68);
        --qolc-faint: rgba(243,236,255,0.46);
        --qolc-accent: #8b6ce0;
        --qolc-accent-lit: #c3aaff;
        --qolc-accent-ink: #17092e;
        --qolc-card: rgba(219,204,255,0.13);
        --qolc-edge: rgba(219,204,255,0.18);
        --qolc-edge-lit: rgba(219,204,255,0.36);
        --qolc-inset: rgba(30,14,58,0.4);
        --qolc-nav: rgba(32,15,60,0.3);
        --qolc-nav-active: rgba(139,108,224,0.28);
        --qolc-field: rgba(32,15,60,0.48);
        --qolc-switch-off: rgba(26,12,50,0.48);
        --qolc-shell: linear-gradient(155deg, rgba(128,98,214,0.34), rgba(38,18,72,0.6));
      }
      #qolc-panel[data-qolc-theme="slate"] {
        --qolc-ink: #eef2f6;
        --qolc-dim: rgba(238,242,246,0.68);
        --qolc-faint: rgba(238,242,246,0.46);
        --qolc-accent: #5b8bb5;
        --qolc-accent-lit: #a9cbe6;
        --qolc-accent-ink: #0b1720;
        --qolc-card: rgba(214,230,242,0.12);
        --qolc-edge: rgba(214,230,242,0.17);
        --qolc-edge-lit: rgba(214,230,242,0.34);
        --qolc-inset: rgba(14,26,36,0.4);
        --qolc-nav: rgba(16,28,38,0.3);
        --qolc-nav-active: rgba(91,139,181,0.28);
        --qolc-field: rgba(16,28,38,0.48);
        --qolc-switch-off: rgba(12,22,30,0.48);
        --qolc-shell: linear-gradient(155deg, rgba(96,134,168,0.3), rgba(18,32,44,0.62));
      }
      /* 1.0.5. The arena theme picker. Same shape as the relay chooser one
         card down — both are "pick exactly one of a short list", and giving
         them two different appearances would say they were different kinds of
         choice when they are not.

         1.0.10: this comment used to be TORN IN HALF. Its opening sat above
         the keybinds block and its tail landed here, at CSS top level, where
         the parser ate it as a garbage prelude and discarded the rule below —
         so both theme pickers lost their flex container. The comment-open and
         comment-close counts still BALANCED, which is why a token-counting
         guard cannot catch this variant: only a real parse or a computed-style
         probe can. Never write a comment delimiter inside a comment. */
      .qolc-theme-picks { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
      .qolc-subrow > .qolc-theme-picks { margin-top: 0; flex: 0 0 auto; justify-content: flex-end; }
      .qolc-theme-pick {
        padding: 5px 9px; border-radius: 9px; cursor: pointer;
        border: 1px solid var(--qolc-edge); background: var(--qolc-inset);
        color: var(--qolc-ink); font: bold 10.5px/1 system-ui, sans-serif;
        transition: background 0.15s ease, border-color 0.15s ease;
      }
      .qolc-theme-pick:hover { background: var(--qolc-nav-active); }
      .qolc-theme-pick.is-on {
        background: var(--qolc-accent); border-color: var(--qolc-accent-lit); color: var(--qolc-accent-ink);
      }
      .qolc-party-roster { margin-top: 9px; display: grid; gap: 5px; }
      .qolc-party-member {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 9px; border-radius: 9px; font-size: 11px;
        background: rgba(183,255,247,0.1); border: 1px solid rgba(203,255,250,0.1);
      }
      .qolc-party-member.is-stale { opacity: 0.45; }
      .qolc-party-swatch {
        width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0;
        background: #cba6ff; box-shadow: 0 0 0 1.5px rgba(0,0,0,0.55);
      }
      .qolc-party-member-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      /* 1.0.2. The leader star and the kick button. Both are BUILT on every
         row and shown by class, never added and removed as leadership moves:
         a button that materialises under the pointer between two passes of the
         750ms roster timer is a button somebody clicks by accident. */
      .qolc-party-crown { display: none; flex-shrink: 0; color: #ffd166; font-size: 11px; }
      .qolc-party-member.is-leader .qolc-party-crown { display: inline; }
      .qolc-party-kick { display: none; flex-shrink: 0; }
      /* can-kick is written only when YOU are the leader, and the roster holds
         nobody but other people, so there is no row this could offer against
         yourself. */
      .qolc-party-member.can-kick .qolc-party-kick { display: inline-block; }
      .qolc-party-kick:hover { background: rgba(255,90,90,0.25); border-color: rgba(255,120,120,0.5); }
      .qolc-party-empty { font-size: 10.5px; opacity: 0.62; margin-top: 9px; }
      .qolc-party-note {
        margin-top: 10px; font-size: 9.5px; line-height: 1.45;
        opacity: 0.6;
      }
      .qolc-name-card {
        margin-top: 10px; padding: 11px; border-radius: 12px;
        background: rgba(255,255,255,0.14);
      }
      #qolc-name-preview {
        min-height: 24px; padding: 7px 8px; border-radius: 9px;
        display: flex; align-items: center; justify-content: center;
        font-size: 17px; font-weight: bold; text-align: center;
        background: rgba(0,45,35,0.22); text-shadow: 0 1px 3px rgba(0,45,35,0.55);
      }
      .qolc-mode-tabs {
        display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin-top: 9px;
      }
      .qolc-mode {
        padding: 6px; border-radius: 8px; cursor: pointer; text-align: center;
        font-size: 11px; font-weight: bold; background: rgba(0,45,35,0.25);
        color: rgba(255,255,255,0.72);
      }
      .qolc-mode.active { color: #fff; background: #35c9b6; }
      .qolc-palette {
        display: grid; grid-template-columns: repeat(8, 1fr); gap: 7px; margin-top: 10px;
      }
      .qolc-color {
        width: 25px; height: 25px; padding: 0; border-radius: 50%; cursor: pointer;
        border: 2px solid rgba(255,255,255,0.38); box-sizing: border-box;
        box-shadow: 0 1px 3px rgba(0,40,30,0.35);
      }
      .qolc-color.active {
        border-color: #fff; box-shadow: 0 0 0 2px #35c9b6, 0 2px 5px rgba(0,40,30,0.4);
      }
      .qolc-control-row {
        display: flex; align-items: center; justify-content: space-between;
        gap: 10px; margin-top: 9px; font-size: 11px; font-weight: bold;
      }
      #qolc-custom-color {
        width: 40px; height: 28px; padding: 0; border: 0;
        border-radius: 7px; background: transparent; cursor: pointer;
      }
      #qolc-name-input {
        width: 100%; box-sizing: border-box; color: #fff;
        background: rgba(0,55,45,0.52); border: 1px solid rgba(255,255,255,0.3);
        border-radius: 9px; outline: none; font: inherit;
      }
      .qolc-gradient-picker { margin-top: 10px; }
      .qolc-gradient-trigger {
        width: 100%; min-height: 39px; display: grid;
        grid-template-columns: 22px 1fr 18px; align-items: center; gap: 9px;
        padding: 6px 9px; box-sizing: border-box; color: #fff;
        background: rgba(5,64,70,0.68); border: 1px solid rgba(191,255,248,0.36);
        border-radius: 10px; cursor: pointer; font: inherit; text-align: left;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
      }
      .qolc-gradient-trigger:hover { background: rgba(8,81,84,0.76); }
      .qolc-gradient-swatch, .qolc-gradient-option-swatch {
        width: 20px; height: 20px; border-radius: 50%;
        border: 1px solid rgba(255,255,255,0.42);
        box-shadow: 0 1px 3px rgba(0,35,40,0.36);
        box-sizing: border-box; background-origin: border-box;
      }
      .qolc-gradient-name { font-size: 13px; font-weight: bold; }
      .qolc-gradient-chevron {
        font-size: 12px; text-align: center; transition: transform 0.15s ease;
      }
      .qolc-gradient-picker.open .qolc-gradient-chevron { transform: rotate(180deg); }
      .qolc-gradient-menu {
        display: none; max-height: 190px; overflow-y: auto; margin-top: 6px;
        padding: 5px; border-radius: 10px;
        background: linear-gradient(160deg, rgba(17,104,106,0.96), rgba(6,59,69,0.97));
        border: 1px solid rgba(196,255,249,0.42);
        box-shadow: 0 8px 18px rgba(0,35,42,0.42), inset 0 1px 0 rgba(255,255,255,0.1);
        scrollbar-width: thin;
        scrollbar-color: rgba(76,229,215,0.9) rgba(2,42,50,0.42);
      }
      .qolc-gradient-picker.open .qolc-gradient-menu { display: block; }
      #qolc-panel .qolc-gradient-menu::-webkit-scrollbar { width: 9px !important; }
      #qolc-panel .qolc-gradient-menu::-webkit-scrollbar-track {
        background: linear-gradient(180deg, rgba(3,58,65,0.3), rgba(1,35,44,0.44)) !important;
        border: 1px solid rgba(199,255,250,0.13) !important;
        border-radius: 9px !important;
        box-shadow: inset 0 0 5px rgba(0,24,31,0.36) !important;
      }
      #qolc-panel .qolc-gradient-menu::-webkit-scrollbar-thumb {
        background: linear-gradient(180deg, rgba(117,244,230,0.68), rgba(29,181,187,0.54)) !important;
        border: 1px solid rgba(224,255,252,0.58) !important;
        border-radius: 9px !important;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.5),
          inset 0 -1px 0 rgba(0,84,94,0.28), 0 1px 4px rgba(0,31,39,0.32) !important;
        backdrop-filter: blur(3px) saturate(1.3);
        -webkit-backdrop-filter: blur(3px) saturate(1.3);
      }
      .qolc-gradient-option {
        width: 100%; display: grid; grid-template-columns: 24px 1fr;
        align-items: center; gap: 9px; padding: 6px 7px; box-sizing: border-box;
        color: rgba(255,255,255,0.84); background: transparent; border: 0;
        border-radius: 8px; cursor: pointer; font: inherit; text-align: left;
      }
      .qolc-gradient-option:hover { background: rgba(111,239,225,0.14); color: #fff; }
      .qolc-gradient-option.active {
        color: #fff; background: rgba(53,201,182,0.34);
        box-shadow: inset 0 0 0 1px rgba(194,255,249,0.2);
      }
      .qolc-gradient-option-swatch { width: 20px; height: 20px; }
      #qolc-gradient-strip {
        height: 24px; margin-top: 7px; border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.35);
        /* The gradient is sized to the BORDER box. At the default padding-box
           origin it tiles under the 1px border, so the left edge showed the
           end of the previous tile and the right edge the start of the next —
           the gradient's own colours, inverted, as a sliver down each side. */
        background-origin: border-box;
      }
      #qolc-name-input { margin-top: 10px; padding: 8px 9px; }
      .qolc-name-warn {
        display: none; margin: 9px 2px 0; padding: 8px 10px; border-radius: 10px;
        font-size: 10px; line-height: 1.45; font-weight: bold;
        color: #ffd19a; background: rgba(61,32,9,0.52);
        border: 1px solid rgba(255,174,88,0.42);
      }
      .qolc-cosmetic-note {
        margin: 8px 4px 2px; font-size: 9.5px; line-height: 1.35;
        text-align: center; opacity: 0.72;
      }
      @keyframes mnc-flow {
        0% { background-position: 0% 50%; }
        100% { background-position: 200% 50%; }
      }

    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---------------- menu v2 (1.25.0) ----------------

  // Every setting's description, keyed by the `data-hint` its row carries.
  //
  // The descriptions left the rows in 1.25.0 and live here instead, shown one
  // at a time in the bar at the foot of the panel while a row is hovered. That
  // is what let the rows become single lines: a row that has to carry two lines
  // of 10px explanation is a row that cannot be scanned, and eighteen of them
  // is a wall. It also buys the description room to be a proper sentence at
  // 12.5px instead of a clipped fragment at 10px.
  //
  // Verbatim from the notes the rows used to carry, extended only where the
  // note was too terse to stand on its own away from the row.
  const QOLC_HINTS = {
    menuClutter: 'Reduce menu clutter — hides the season logo, the legal links and the Community & More tab on the main menu.',
    gameClutter: 'Reduce in-game clutter — hides dash and climb, and moves your ability down beside dive.',
    abilityCooldown: 'Ability cooldown timers — seconds left on each ability box, dive air included.',
    hpNumbers: 'Damage indicator — how much health a hit took, coloured by what caused it: plain, fire, poison, bleed.',
    hpBar: 'HP bar — your health, live, healing included, above the ability cards.',
    boostCounter: "Boost counter — how many boosts your water will still pay for, over your health bar, once you are at 25% or less in a 1v1. Boosting stops working at 15%, so only the water above that is counted, at mope's cost of 1.5% per boost.",
    quickChat: 'Quick chat — keys 1 to 5 send a message you have written into mope\'s public chat. While the upgrade menu is open those keys go back to picking an animal, so upgrading is never affected.',
    quickChatSlot: 'The message this key sends. Up to 35 characters, mope\'s own limit. An empty slot leaves the key alone entirely.',
    hpUnits: 'Show as — the unit for both rows above. Percentage is exactly what the game sends and works on every animal. Hit points multiplies it by a maximum this script works out itself: the figures are approximate, and most rares and King Dragon get no number at all.',
    arenaSky: 'Arena theme — a backdrop behind your own 1v1 duels. Z toggles it in game.',
    arenaTheme: 'Which backdrop. Starfield is deep space and the original; Antimatter is the same sky as a negative, pale with dark stars; Deep Water is pale motes on blue-green with no star band.',
    panelTheme: 'Panel theme — recolours the Extras panel itself. It changes nothing about the game.',
    debugLogging: 'Debug logging — writes what the script is doing to the browser console (F12). Only useful when reporting a problem; leave it off otherwise.',
    gameLink: "Game connection — whether the script has reached mope's game, its animals and its HUD. It reads them straight from mope's own code, so this should say Connected within a second of the page loading. Copy report puts the details on the clipboard to send to Lumi.",
    updateCheck: 'Check for updates — once an hour, reads the version number from this mod\'s GitHub page and tells you on the menu when a newer one is out. Nothing about you is sent.',
    zorderAbove: 'Draw above other players — forces your animal to be painted over every other one. mope decides this inconsistently on its own. Toggled in game with the ] key.',
    zorderBelow: 'Draw below other players — the opposite: everyone else is painted over you. Toggled in game with the [ key.',
    biteIndicator: 'Bite indicator — a bitten fighter cannot be bitten again for three seconds. A purple mark on their health bar counts that down, so you can see when they are worth biting again.',
    arenaFocus: "Focus mode — hides party dots, tags, the list and chat while you are in a 1v1 of your own. You keep sending, so the party still sees you; P and Enter go back to the game until the duel ends.",
    cameraZoom: "Camera zoom — scroll, or the − and = keys, in place of mope's own wheel zoom.",
    hook: "Camera hook — whether the zoom is attached to mope's camera. It attaches on its own as soon as the game has loaded; the button is only a backstop.",
    turnSpeed: 'Turn speed — how quickly animals rotate toward the angle the server sent.',
    rate: "Rate — a multiple of mope's own turning rate, so 100% is off. It dims while Curve is Instant, which skips the turn entirely.",
    curve: 'Curve — where in the turn the extra speed is spent. Instant skips the turn entirely.',
    nameColor: 'Player name color — client-side solid colours and gradients on your own name.',
    palette: 'Pick a preset or any custom colour. Gradient mode flows the preset across the name.',
    gradient: 'Gradient preset — the colours the name flows through. The strip below is the whole run.',
    animate: 'Animate gradient — flows the gradient across the name continuously.',
    share: 'Share with script users — sends your colour as a name tag, and to the registry if that is on.',
    registry: 'Online color registry — refreshes shared colours for players carrying a color tag.',
    dom: 'Leaderboard and menus — also colours matching HTML name labels outside the game world.',
    party: 'Party — joins the party and connects to the relay. The map, chat and the party list are separate switches under it, and any of them works on its own.',
    code: 'Party code — everyone in the party holds the same one, and everything sent is encrypted with a key derived from it, so the relay cannot read any of it. Anyone with the code can, so treat it like a password and use a generated one.',
    relay: 'Relay — everyone in the party must be on the same one. Auto moves between them on its own.',
    roster: 'Who is on your code right now, and how much health each of them has left. Stale members fade. The star marks the party leader — the earliest to join — who can remove members.',
    dots: 'Party map — party members as coloured dots on your minimap.',
    tags: 'Show names — their in-game name above each dot.',
    chat: 'Party chat — press P in game to switch between public and party chat.',
    list: "Party list — each member's animal, health and XP, under the leaderboard.",
    listSelf: 'Include yourself — show your own row in the list as well as everyone else.',
    listBox: "Box around the list — draw it in mope's own HUD box, like the leaderboard above it.",
    dotColor: 'Your dot color — how the rest of the party sees you. Your own marker is unchanged.',
    handle: 'Your handle — read from your account. Override it here if your account has none.',
  };

  // Tag any element as the thing a hint describes. The bar is driven by ONE
  // delegated listener on the panel rather than a pair per row: ~30 rows would
  // otherwise mean 60 listeners, and a delegated `closest()` also means a hint
  // keeps showing while the pointer is over a switch or a button INSIDE the
  // row, which per-row listeners would have to special-case.
  function hinted(el, key) {
    if (el && key) el.dataset.hint = key;
    return el;
  }

  // A card holding a parent row and the settings that depend on it. The
  // relationship is carried by NESTING — the children are inside the parent's
  // own card, on a darker inset — which is what let 1.24.0's branch spine and
  // its markSubRows() bookkeeping be deleted outright rather than fixed again.
  function makeCard(parentRow, kids) {
    const card = document.createElement('div');
    card.className = 'qolc-card';
    card.appendChild(parentRow);
    const box = document.createElement('div');
    box.className = 'qolc-kids';
    for (const kid of kids) if (kid) box.appendChild(kid);
    card.appendChild(box);
    card.kids = box;
    return card;
  }

  // One dependent setting, inside a card. Shares makeRow's switch behaviour but
  // not its shell.
  function makeSubRow(name, hintKey, initialOn, onToggle) {
    const row = document.createElement('div');
    row.className = 'qolc-subrow';
    hinted(row, hintKey);
    const nameEl = document.createElement('div');
    nameEl.className = 'qolc-row-name';
    nameEl.textContent = name;
    row.appendChild(nameEl);
    const sw = document.createElement('div');
    sw.className = 'qolc-switch' + (initialOn ? ' on' : '');
    sw.addEventListener('click', (e) => {
      e.stopPropagation();
      const on = !sw.classList.contains('on');
      sw.classList.toggle('on', on);
      onToggle(on);
    });
    row.appendChild(sw);
    return { row, sw };
  }

  // A sub-row that carries a control other than a switch — a stepper, a set of
  // pills, a field. The caller supplies the control.
  function makeSubSlot(name, hintKey, control) {
    const row = document.createElement('div');
    row.className = 'qolc-subrow';
    hinted(row, hintKey);
    const nameEl = document.createElement('div');
    nameEl.className = 'qolc-row-name';
    nameEl.textContent = name;
    row.appendChild(nameEl);
    if (control) row.appendChild(control);
    return row;
  }

  // A category: its sidebar entry and its pane, kept together so the two can
  // never drift apart.
  function makeCategory(key, label, side, content) {
    const item = document.createElement('div');
    item.className = 'qolc-side-item';
    const mark = document.createElement('div');
    mark.className = 'qolc-side-mark';
    item.appendChild(mark);
    const text = document.createElement('span');
    text.textContent = label;
    item.appendChild(text);
    side.appendChild(item);

    const title = document.createElement('div');
    title.className = 'qolc-cat-title';
    title.textContent = label;
    const pane = document.createElement('div');
    pane.className = 'qolc-pane';
    item.addEventListener('click', (e) => { e.stopPropagation(); setExtrasTab(key); });
    return { key, item, pane, title };
  }

  // A caption over a handful of related rows inside a pane.
  //
  // This replaced the sidebar's group separators. Those captioned one or two
  // categories each, which is not a group; captioning rows inside a pane is,
  // and it is the level at which "these three are the same kind of thing" is
  // actually worth saying.
  function makeSecLabel(text) {
    const el = document.createElement('div');
    el.className = 'qolc-sec';
    el.textContent = text;
    return el;
  }

  // A row. The `note` argument is kept in the signature and is now the HINT
  // KEY rather than text to draw — every caller already passed a description
  // here, so this is where the description naturally became a lookup.
  function makeRow(name, hintKey, initialOn, onToggle) {
    const row = document.createElement('div');
    row.className = 'qolc-row';
    hinted(row, hintKey);

    const nameEl = document.createElement('div');
    nameEl.className = 'qolc-row-name';
    nameEl.textContent = name;

    const sw = document.createElement('div');
    sw.className = 'qolc-switch' + (initialOn ? ' on' : '');
    sw.addEventListener('click', (e) => {
      e.stopPropagation();
      const on = !sw.classList.contains('on');
      sw.classList.toggle('on', on);
      onToggle(on);
    });

    row.appendChild(nameEl);
    row.appendChild(sw);
    return { row, sw };
  }

  // Which category is on screen. The three names the rest of the script uses —
  // 'qol', 'cosmetics', 'party' — are still accepted and land on that group's
  // first category, so openExtrasTab(), the N hotkey and every existing caller
  // keep working against six categories without knowing there are six.
  const QOLC_TAB_ALIAS = {qol: 'general', cosmetics: 'cosmetics', party: 'party'};

  function setExtrasTab(tabName) {
    if (!extras) return;
    const wanted = QOLC_TAB_ALIAS[tabName] || tabName;
    const selected = extras.cats[wanted] ? wanted : 'general';
    for (const [key, cat] of Object.entries(extras.cats)) {
      const on = key === selected;
      cat.item.classList.toggle('active', on);
      cat.pane.classList.toggle('active', on);
      cat.title.classList.toggle('active', on);
    }
    extras.current = selected;
    // Switching categories clears the hint: the bar describes what the pointer
    // is on, and after a click the pointer is on the sidebar.
    qolcSetHint(null);
    // The roster is only refreshed while its category is up, so bring it
    // current the moment it is opened rather than waiting for the next sweep.
    if (selected === 'party') syncPartyUI();
    if (selected === 'settings') syncTroubleshootingUI();
  }

  function qolcSetHint(key) {
    if (!extras || !extras.info) return;
    const text = key ? QOLC_HINTS[key] : null;
    if (text) {
      extras.info.textContent = text;
      extras.info.classList.add('show');
    } else {
      extras.info.classList.remove('show');
    }
  }


  function positionExtrasPanel() {
    if (!extras) return;
    const panel = extras.panel;
    if (inGame()) {
      panel.style.top = '50%';
      panel.style.left = '50%';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.transform = 'translate(-50%, -50%)';
      return;
    }
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.transform = '';
    const r = extras.btn.getBoundingClientRect();
    const wasHidden = panel.style.display !== 'block';
    if (wasHidden) {
      panel.style.visibility = 'hidden';
      panel.style.display = 'block';
    }
    const panelHeight = panel.offsetHeight;
    const panelWidth = panel.offsetWidth;
    // The button is in the bottom-left corner, so the panel opens UPWARD out
    // of it; dropping below is the fallback for a window too short to hold it
    // above, and the clamp is what keeps it on screen either way.
    const above = r.top - 10 - panelHeight;
    const top = above >= 8
      ? above
      : Math.max(8, Math.min(r.bottom + 10, innerHeight - panelHeight - 8));
    panel.style.top = Math.round(top) + 'px';
    panel.style.left =
      Math.round(Math.max(8, Math.min(r.left, innerWidth - panelWidth - 8))) + 'px';
    if (wasHidden) {
      panel.style.display = 'none';
      panel.style.visibility = '';
    }
  }

  function openExtrasTab(tabName) {
    const current = ensureExtrasUI();
    if (!current) return;
    setExtrasTab(tabName);
    positionExtrasPanel();
    current.panel.style.display = 'block';
  }

  function syncNameColorUI() {
    if (!extras || !extras.nameUi) return;
    const refs = extras.nameUi;
    const solid = nameColorState.mode === 'solid';
    refs.enabled.classList.toggle('on', nameColorState.enabled);
    refs.solidMode.classList.toggle('active', solid);
    refs.gradientMode.classList.toggle('active', !solid);
    refs.solidPane.style.display = solid ? 'block' : 'none';
    refs.gradientPane.style.display = solid ? 'none' : 'block';
    refs.custom.value = /^#[0-9a-f]{6}$/i.test(nameColorState.color)
      ? nameColorState.color : '#ffffff';
    for (const item of refs.colors) {
      item.classList.toggle('active',
        solid && item.dataset.hex.toLowerCase() === nameColorState.color.toLowerCase());
    }
    refs.gradientName.textContent =
      NAME_GRADIENTS[nameColorState.grad][0];
    refs.gradientSwatch.style.backgroundImage = cssGrad(nameColorState.grad);
    for (const option of refs.gradientOptions) {
      const idx = Number(option.dataset.grad);
      option.style.display = gradientLocked(idx) ? 'none' : '';
      option.classList.toggle('active', idx === nameColorState.grad);
    }
    refs.gradientStrip.style.backgroundImage = cssGrad(nameColorState.grad);
    refs.animate.classList.toggle('on', nameColorState.anim);
    refs.share.classList.toggle('on', nameColorState.share);
    refs.relay.classList.toggle('on', nameColorState.relay);
    refs.dom.classList.toggle('on', nameColorState.dom);
    nrStatusChanged();

    // A name-only registry record cannot establish which player opted in.
    // Leave room for the tag; never silently shorten the player's name.
    const shareBase = stripInvis(nameColorState.name);
    const shareLimit = nameFieldLimit(document.getElementById('name'));
    const shareTag = encodeSuffix(true);
    const shareOver = shareBase.length + shareTag.length - shareLimit;
    if (shareTag && shareBase.trim() && shareOver > 0) {
      refs.shareWarn.style.display = 'block';
      refs.shareWarn.textContent = 'Shorten your name by ' + shareOver +
        ' character' + (shareOver === 1 ? '' : 's') + ' to share its colour. ' +
        'The color tag needs that space; your own colour still works locally. ' +
        'Decorative letters can use two spaces each.';
    } else {
      refs.shareWarn.style.display = 'none';
    }
    // 1.25.0 removed the "Your in-game name (auto-detected)" field. The name
    // is read from the page and was only ever editable to fix a detection
    // failure; the box spent its life showing a value nobody had to change.
    // nameColorState.name is still read and written by everything else.

    // Painted onto two elements now: the big preview in the picker, and the
    // small "what other script users see" line under Sharing. Factored rather
    // than duplicated, because the gradient path here is eight properties that
    // have to be set AND cleared in the same order to switch modes cleanly.
    const paintName = (el) => {
      if (!el) return;
      el.textContent = nameColorState.name || 'Luminosity';
      el.style.backgroundImage = '';
      el.style.backgroundSize = '';
      el.style.animation = '';
      el.style.animationDelay = '';
      el.style.webkitBackgroundClip = '';
      el.style.backgroundClip = '';
      el.style.webkitTextFillColor = '';
      el.style.color = nameColorState.enabled ? nameColorState.color : 'rgba(255,255,255,0.62)';
      if (nameColorState.enabled && !solid) {
        el.style.color = '';
        el.style.backgroundImage = nameColorState.anim
          ? cssGradCyc(nameColorState.grad) : cssGrad(nameColorState.grad);
        if (nameColorState.anim) {
          el.style.backgroundSize = '200% 100%';
          el.style.animation = 'mnc-flow ' + (ANIM_PERIOD / 1000) + 's linear infinite';
          el.style.animationDelay = '-' + Math.round(performance.now() % ANIM_PERIOD) + 'ms';
        }
        el.style.webkitBackgroundClip = 'text';
        el.style.backgroundClip = 'text';
        el.style.webkitTextFillColor = 'transparent';
      }
    };
    paintName(refs.preview);
    paintName(refs.tagPreview);
  }

  function partyStatusText() {
    if (!settings.masterEnabled) return 'Extras are switched off';
    if (!party.enabled) return 'Off';
    if (party.status === 'ok') {
      const n = party.peers.size;
      // Said here because YOU are not in the roster below — every row in it is
      // somebody else, so there is nowhere else the panel could tell you that
      // the kick buttons are yours.
      const lead = partyIsLeader() ? " — you are the party leader" : "";
      const who = n
        ? n + ' member' + (n === 1 ? '' : 's') + ' on the map'
        : 'waiting for members';
      if (!party.minimapSeen) return "Connected via " + party.statusInfo + " — join a game to see the map" + lead;
      return "Connected via " + party.statusInfo + " — " + who + lead;
    }
    if (party.status === 'wait') return party.statusInfo || 'Connecting…';
    if (party.status === 'bad') return party.statusInfo || 'Disconnected';
    return 'Off';
  }

  // The one line under the handle field, and it is the whole diagnostic for
  // this feature: it says which of the three sources answered, and it says so
  // in the form the answer will actually appear in. "No handle found" and
  // "that is not a usable handle" are different problems with different fixes,
  // and a field that just sat there empty could not tell them apart.
  function partyHandleNoteText() {
    const typed = String(party.handle || '').trim();
    if (typed) {
      const clean = partyCleanHandle(typed);
      return clean
        ? 'Party chat will show you as @' + clean + '.'
        : 'Not a usable handle — letters, numbers, dot, dash and underscore, ' +
          'between 2 and 24 of them. Your in-game name is being used instead.';
    }
    const found = partySelfHandle();
    return found
      ? 'Read from your account: @' + found + '. Type one here to override it.'
      : 'No handle found for this account, so party chat will show your ' +
        'in-game name. Type one here to use a handle instead.';
  }

  // Safe to call before the panel exists — the settle/status paths do.
  // id -> {root, swatch, name, crown, kick} for the panel roster. Rows outlive
  // a sync pass; see the note in syncPartyUI for why that matters.
  const partyRosterRows = new Map();

  function syncPartyUI() {
    if (!extras || !extras.partyUi) return;
    const refs = extras.partyUi;
    refs.enabled.classList.toggle('on', party.enabled);
    refs.dots.classList.toggle('on', party.dots);
    refs.tags.classList.toggle('on', party.tags);
    refs.chat.classList.toggle('on', party.chat);
    refs.dotsRow.classList.toggle('qolc-row-off', !party.enabled);
    // Names are a sub-option of the dots now, so they are inert when the dots
    // are off as well as when the party is.
    refs.tagsRow.classList.toggle('qolc-row-off', !party.enabled || !party.dots);
    refs.chatRow.classList.toggle('qolc-row-off', !party.enabled);
    refs.colorBlock.classList.toggle('qolc-row-off', !party.enabled);
    refs.list.classList.toggle('on', party.list);
    refs.listRow.classList.toggle('qolc-row-off', !party.enabled);
    refs.handleBlock.classList.toggle('qolc-row-off', !party.enabled);
    // The list's two sub-options grey out on the same pass.
    syncPartyListSubRows();
    if (document.activeElement !== refs.handle) refs.handle.value = party.handle;
    refs.handleNote.textContent = partyHandleNoteText();
    for (const swatch of refs.colors) {
      swatch.classList.toggle('active', Number(swatch.dataset.idx) === party.color);
    }
    // Auto lights the Auto button AND whichever relay it currently landed on,
    // because "which one am I actually on" is the question a member has to
    // answer to match somebody else. A pin lights only itself.
    for (const btn of refs.relays) {
      const value = Number(btn.dataset.relay);
      btn.classList.toggle('is-on',
        value < 0 ? party.pin < 0 : value === party.broker);
    }
    if (document.activeElement !== refs.code) refs.code.value = party.code;

    const cls = party.status === 'ok' ? ' is-ok'
      : party.status === 'wait' ? ' is-wait'
      : party.status === 'bad' ? ' is-bad' : '';
    refs.status.className = 'qolc-party-status' + cls;
    refs.status.textContent = partyStatusText();

    const now = performance.now();
    const members = [...party.peers.values()]
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    const leaderId = partyLeaderId();
    const iLead = partyIsLeader();

    // 1.0.2 PATCHES ROWS BY ID RATHER THAN REBUILDING THEM, and the kick
    // button is the whole reason. This runs on a 750ms timer while the party
    // tab is open; with `textContent = ''` and a fresh set of elements every
    // pass, a button lives at most three quarters of a second and a click that
    // lands just as the roster is rebuilt hits an element already detached
    // from the document. Nothing appears to happen and nothing says why.
    //
    // So the row is created once per member and only its mutable parts are
    // written afterwards. That also keeps hover and focus, which a rebuild
    // drops on every pass.
    for (const [id, row] of partyRosterRows) {
      if (party.peers.has(id)) continue;
      try { row.root.remove(); } catch (e) {}
      partyRosterRows.delete(id);
    }
    let rosterIndex = 0;
    for (const peer of members) {
      let row = partyRosterRows.get(peer.id);
      if (!row) {
        const root = document.createElement('div');
        root.className = 'qolc-party-member';
        // The roster swatch shows the member's own colour AND its outline, so
        // a name can be matched to a dot on the map without guessing.
        const swatch = document.createElement('div');
        swatch.className = 'qolc-party-swatch';
        const name = document.createElement('div');
        name.className = 'qolc-party-member-name';
        // Always built and hidden by CSS rather than added and removed as
        // leadership changes: a button that appears under the pointer between
        // two frames is a button you click by accident.
        const crown = document.createElement('span');
        crown.className = 'qolc-party-crown';
        crown.textContent = '★';
        crown.title = 'Party leader';
        const kick = document.createElement('button');
        kick.type = 'button';
        kick.className = 'qolc-obtn qolc-obtn-sm qolc-party-kick';
        kick.textContent = 'Kick';
        // Captured per row rather than read off a dataset at click time: the
        // id is fixed for the life of the row, and this cannot be confused by
        // a row that has been reused for somebody else.
        const targetId = peer.id;
        kick.addEventListener('click', (e) => {
          e.stopPropagation();
          partyKick(targetId);
          syncPartyUI();
        });
        root.appendChild(swatch);
        root.appendChild(name);
        root.appendChild(crown);
        root.appendChild(kick);
        row = {root, swatch, name, crown, kick};
        partyRosterRows.set(peer.id, row);
      }
      const preset = partyDotPreset(peer.color);
      const stale = now - peer.at > PARTY_STALE_MS;
      const cls = 'qolc-party-member' + (stale ? ' is-stale' : '') +
        (peer.id === leaderId ? ' is-leader' : '') + (iLead ? ' can-kick' : '');
      if (row.root.className !== cls) row.root.className = cls;
      const label = peer.name || '(unnamed)';
      if (row.name.textContent !== label) row.name.textContent = label;
      if (row.swatch.style.background !== preset.fill) {
        row.swatch.style.background = preset.fill;
        row.swatch.style.boxShadow = '0 0 0 1.5px ' + preset.line;
      }
      // Placed in roster order, but ONLY when it is not already there (1.0.10).
      //
      // The old comment claimed "moving a node that is already in the right
      // place is a no-op in every engine". It is not: appendChild always
      // removes and re-inserts, even when the node lands back in the same
      // position. This runs every 750ms over every member, so every row in the
      // list was being detached and re-attached four times a second — which
      // BLURS a focused Kick button (removal from the document drops focus),
      // fires mutation observers, and is exactly the "a click landing mid
      // rebuild hits a detached element" hazard the patch-don't-rebuild design
      // was written to avoid.
      //
      // Comparing against the node that should follow it keeps the sort
      // correct as names arrive, and touches the DOM only when the order has
      // actually changed.
      // `children`, not `childNodes`: element positions are what the sort is
      // about, and a stray text node would offset every comparison by one and
      // reintroduce the churn this replaces.
      const want = refs.roster.children[rosterIndex++];
      if (want !== row.root) refs.roster.insertBefore(row.root, want || null);
    }
    refs.empty.style.display = members.length ? 'none' : 'block';
    // Collapsed when there is nobody in it, so the inset does not sit there as
    // an empty box beside the line that explains why it is empty.
    refs.roster.style.display = members.length ? '' : 'none';
  }

  function ensureExtrasUI() {
    if (extras) return extras;
    const host = document.body || document.documentElement;
    if (!host) return null;
    injectExtrasStyles();

    const btn = document.createElement('div');
    btn.id = 'qolc-btn';
    btn.title = "Lumi's Extras";
    const icon = document.createElement('canvas');
    icon.width = GEAR_ICON_W;
    icon.height = GEAR_ICON_H;
    paintGearIcon(icon);
    btn.appendChild(icon);

    const panel = document.createElement('div');
    panel.id = 'qolc-panel';

    const hint = document.createElement('div');
    hint.id = 'qolc-game-hint';
    hint.textContent = "Press N to configure Lumi's Extras while in game.";

    const head = document.createElement('div');
    head.className = 'qolc-head';
    const titleWrap = document.createElement('div');
    titleWrap.className = 'qolc-head-text';
    const title = document.createElement('div');
    title.className = 'qolc-title';
    title.textContent = "Lumi's Extras";
    const sub = document.createElement('div');
    sub.className = 'qolc-sub';
    // The version moved off the title line and into the subtitle in 1.25.0.
    // It is still on screen — every bug report quotes it — just not competing
    // with the name for the largest type in the panel.
    sub.textContent = 'QOL & COSMETICS · V' + String(VERSION).toUpperCase();
    titleWrap.appendChild(title);
    titleWrap.appendChild(sub);

    const master = document.createElement('div');
    master.className = 'qolc-switch qolc-master' + (settings.masterEnabled ? ' on' : '');
    master.title = 'Enable/disable all extras';
    master.addEventListener('click', (e) => {
      e.stopPropagation();
      const on = !master.classList.contains('on');
      master.classList.toggle('on', on);
      settings.masterEnabled = on;
      store.set('masterEnabled', on);
      panel.classList.toggle('qolc-off', !on);
      if (on) {
        applyCluttersIfEnabled();
        if (party.enabled) partyConnect();
      } else {
        menuHider.restore();
        restoreGameClutter();
        partyDisconnect('master switch off');
        partySetStatus('off', '');
      }
      applyAbilityCooldown();
      applyHpNumbers();
      domSweep();
      syncNameColorUI();
      // Draw order stays armed and the animal stays on the layer it was
      // promoted to unless told otherwise. mope's own re-attach churn heals it
      // within seconds, but "off" should mean off now.
      if (!on) zorderRestore();
      // Nothing to re-apply: the zoom hub already collapses its factor to 1
      // while the master switch is off, and the camera reads it on its next
      // frame. The turn multiplier collapses the same way.
      syncZoomUI();
      syncTurnUI();
      syncPartyUI();
      dbg('master switch', on ? 'ON' : 'OFF');
    });

    const headDiv = document.createElement('div');
    headDiv.className = 'qolc-head-div';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'qolc-close';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.style.display = 'none';
    });

    head.appendChild(titleWrap);
    head.appendChild(master);
    head.appendChild(headDiv);
    head.appendChild(closeBtn);
    const shell = document.createElement('div');
    shell.className = 'qolc-shell';
    shell.appendChild(head);
    panel.appendChild(shell);
    panel.classList.toggle('qolc-off', !settings.masterEnabled);

    // ---- body: sidebar of categories, then one pane each ----
    const body = document.createElement('div');
    body.className = 'qolc-body';
    const side = document.createElement('div');
    side.className = 'qolc-side';
    const content = document.createElement('div');
    content.className = 'qolc-content';
    body.appendChild(side);
    body.appendChild(content);
    shell.appendChild(body);

    // Six categories in three groups. They are sized so that no pane scrolls
    // and none is half empty — that balance is the reason there are six rather
    // than three, and it is what a new row has to be checked against.
    // Four categories, no group separators. The six of 1.25.0 split things
    // that belong together — name colour from the sharing that carries it, the
    // party from its own overlays — and the separators were three labels
    // standing over one or two items each. Grouping moved INSIDE the panes,
    // where it can caption a handful of related rows instead.
    const catGeneral = makeCategory('general', 'General', side, content);
    const catArena = makeCategory('arena', 'Arena', side, content);
    const catCosmetics = makeCategory('cosmetics', 'Cosmetics', side, content);
    const catParty = makeCategory('party', 'Party', side, content);
    // 1.0.23 removed Customization, which sat between Party and Settings.
    // 1.0.7. Last: it is about the MOD rather than about the game, so it sits
    // below everything that changes what you see while playing.
    const catSettings = makeCategory('settings', 'Settings', side, content);
    const cats = {
      general: catGeneral, arena: catArena,
      cosmetics: catCosmetics, party: catParty,
      settings: catSettings,
    };
    for (const key of Object.keys(cats)) {
      content.appendChild(cats[key].title);
      content.appendChild(cats[key].pane);
    }

    // The hover description, below every pane and outside all of them: one bar
    // for the whole panel, so its height is reserved once and switching
    // category cannot move it.
    const info = document.createElement('div');
    info.className = 'qolc-info';
    content.appendChild(info);

    // One delegated listener for every hint in the panel. `mouseover` bubbles
    // (`mouseenter` does not), so this sees rows the pointer moves onto
    // without a listener per row; `closest()` then keeps the hint up while the
    // pointer is over a switch or button INSIDE the row rather than blanking
    // it, which is what a naive per-element handler gets wrong.
    panel.addEventListener('mouseover', (e) => {
      const el = e.target && e.target.closest ? e.target.closest('[data-hint]') : null;
      qolcSetHint(el ? el.dataset.hint : null);
    });
    panel.addEventListener('mouseleave', () => qolcSetHint(null));

    // Short names for where things get appended, so the assignments below read
    // as a table of contents rather than as plumbing.
    const generalPane = catGeneral.pane, arenaPane = catArena.pane;
    const cosmeticsPane = catCosmetics.pane, partyPane = catParty.pane;
    const settingsPane = catSettings.pane;
    // General is built out of order too — the camera zoom card is constructed
    // before the HP rows are — so its three sections are pinned here.
    const genDetail = document.createElement('div');
    genDetail.className = 'qolc-stack';
    const genInfo = document.createElement('div');
    genInfo.className = 'qolc-stack';
    const genMisc = document.createElement('div');
    genMisc.className = 'qolc-stack';
    const genSocial = document.createElement('div');
    genSocial.className = 'qolc-stack';
    generalPane.appendChild(genDetail);
    generalPane.appendChild(genInfo);
    // Social sits BEFORE Misc, not after it. Misc is the leftovers bucket and
    // a leftovers bucket that is not last stops reading as one.
    generalPane.appendChild(genSocial);
    generalPane.appendChild(genMisc);

    // The party pane is built in two passes — the overlay rows are constructed
    // before the connection card is — so its ORDER is fixed here rather than
    // left to whichever piece happens to be finished first.
    const partyTop = document.createElement('div');
    partyTop.className = 'qolc-stack';
    const partyOverlays = document.createElement('div');
    partyOverlays.className = 'qolc-stack';
    partyPane.appendChild(partyTop);
    partyPane.appendChild(partyOverlays);

    const menuClutterRow = makeRow(
      'Reduce menu clutter',
      'menuClutter',
      settings.menuClutter,
      (on) => {
        settings.menuClutter = on;
        store.set('menuClutter', on);
        if (on) applyMenuClutter();
        else menuHider.restore();
        dbg('reduce menu clutter', on ? 'enabled' : 'disabled');
      }
    );
    genDetail.appendChild(makeSecLabel('Detail'));
    genDetail.appendChild(menuClutterRow.row);

    const gameClutterRow = makeRow(
      'Reduce in-game clutter',
      'gameClutter',
      settings.gameClutter,
      (on) => {
        settings.gameClutter = on;
        store.set('gameClutter', on);
        if (on) applyGameClutter();
        else restoreGameClutter();
        dbg('reduce in-game clutter', on ? 'enabled' : 'disabled');
      }
    );
    genDetail.appendChild(gameClutterRow.row);

    const abilityCooldownRow = makeRow(
      'Ability cooldown timers',
      'abilityCooldown',
      settings.abilityCooldown,
      (on) => {
        settings.abilityCooldown = on;
        store.set('abilityCooldown', on);
        applyAbilityCooldown();
        dbg('ability cooldown timers', on ? 'enabled' : 'disabled');
      }
    );
    genInfo.appendChild(makeSecLabel('Informative'));
    genInfo.appendChild(abilityCooldownRow.row);

    const zoomRow = makeRow(
      'Camera zoom',
      'cameraZoom',
      settings.cameraZoom,
      (on) => {
        settings.cameraZoom = on;
        store.set('cameraZoom', on);
        syncZoomUI();
        if (on) showZoomToast();
        dbg('camera zoom', on ? 'enabled' : 'disabled');
      }
    );

    // The camera hook. The hub attaches to $.camera itself as soon as the game
    // bridge is up and re-checks every two seconds, so this row is a window onto
    // that rather than a control anyone should need. The button stays for the
    // case nobody has thought of. Never greyed out.
    const hookRow = document.createElement('div');
    hookRow.className = 'qolc-subrow';
    hinted(hookRow, 'hook');
    const hookName = document.createElement('div');
    hookName.className = 'qolc-row-name';
    hookName.textContent = 'Camera hook';
    const hookNote = document.createElement('div');
    hookNote.className = 'qolc-row-note';
    const hookBtn = document.createElement('button');
    hookBtn.className = 'qolc-hook-btn';
    hookBtn.type = 'button';
    hookBtn.textContent = 'Re-hook';
    hookBtn.title = "Attach to the game camera again now, without reloading";
    hookBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      hookBtn.disabled = true;
      hookNote.textContent = "Re-attaching…";
      zoomHub.rehook();
      setTimeout(() => {
        hookBtn.disabled = false;
        syncZoomUI();
        if (!zoomHub.hooked()) {
          hookNote.textContent = "Still waiting — " + bridge.status().phase +
            ". If this stays, reload the tab.";
        }
      }, 400);
    });
    hookRow.appendChild(hookName);
    hookRow.appendChild(hookNote);
    hookRow.appendChild(hookBtn);

    // Camera zoom and the hook are one card: the hook is the control that
    // fixes the zoom, and nesting says so without a word of explanation.
    const zoomGroup = makeCard(zoomRow.row, [hookRow]);
    // ---- Social: quick chat (1.33.0) ----
    //
    // A section rather than a sixth sidebar category, at the user's call: a
    // category called Social beside one called Party would be two names for
    // what a player would reasonably expect to be one place.
    const quickChatRow = makeRow(
      'Quick chat',
      'quickChat',
      settings.quickChat,
      (on) => {
        settings.quickChat = on;
        store.set('quickChat', on);
        syncChatRows();
        dbg('quick chat', on ? 'enabled' : 'disabled');
      }
    );
    const chatFields = [];
    const chatSubRows = [];
    for (let i = 0; i < CHAT_SLOTS; i++) {
      const row = hinted(document.createElement('div'), 'quickChatSlot');
      row.className = 'qolc-subrow qolc-chat-row';
      const label = document.createElement('div');
      label.className = 'qolc-row-name';
      label.textContent = String(i + 1);
      const wrap = document.createElement('div');
      wrap.className = 'qolc-party-field qolc-chat-field';
      const field = document.createElement('input');
      field.type = 'text';
      field.spellcheck = false;
      // mope's own limit, so the box cannot hold something the game will not
      // take. The sender trims to the same number rather than trusting this:
      // maxlength constrains typing, not a value set from script.
      field.maxLength = CHAT_MAX_LEN;
      field.placeholder = 'Message for key ' + (i + 1);
      field.value = settings.chatSlots[i] || '';
      field.setAttribute('aria-label', 'Quick chat message for key ' + (i + 1));
      // Keystrokes inside our own field must never reach the game. The panel
      // is open here so the hotkey would already stand down, but typing "1"
      // into slot 3 is exactly the case where that must be true for certain.
      field.addEventListener('keydown', (e) => { e.stopPropagation(); });
      field.addEventListener('input', (e) => {
        e.stopPropagation();
        const slots = settings.chatSlots.slice();
        slots[i] = String(field.value || '').replace(/[\r\n\t]+/g, ' ').slice(0, CHAT_MAX_LEN);
        settings.chatSlots = slots;
        store.set('chatSlots', slots);
      });
      chatFields.push(field);
      wrap.appendChild(field);
      row.appendChild(label);
      row.appendChild(wrap);
      chatSubRows.push(row);
    }
    const chatCard = makeCard(quickChatRow.row, chatSubRows);
    syncChatRows = () => {
      for (const row of chatSubRows) {
        row.classList.toggle('qolc-row-off', !settings.quickChat);
      }
    };
    syncChatRows();
    genSocial.appendChild(makeSecLabel('Social'));
    genSocial.appendChild(chatCard);

    genMisc.appendChild(makeSecLabel('Misc'));
    genMisc.appendChild(zoomGroup);

    const turnRow = makeRow(
      'Turn speed',
      'turnSpeed',
      settings.turnSpeed,
      (on) => {
        settings.turnSpeed = on;
        store.set('turnSpeed', on);
        syncTurnUI();
        dbg('turn speed', on ? 'enabled' : 'disabled');
      }
    );

    const turnLevelRow = document.createElement('div');
    turnLevelRow.className = 'qolc-subrow';
    hinted(turnLevelRow, 'rate');
    const turnLevelText = document.createElement('div');
    const turnLevelName = document.createElement('div');
    turnLevelName.className = 'qolc-row-name';
    turnLevelName.textContent = 'Rate';
    const turnLevelNote = document.createElement('div');
    turnLevelNote.className = 'qolc-row-note';
    turnLevelNote.textContent =
      Math.round(100 * TURN_MIN / TURN_NEUTRAL) + '% to ' +
      Math.round(100 * TURN_MAX / TURN_NEUTRAL) + '% of mope\'s own, 100% is unchanged';
    turnLevelText.appendChild(turnLevelName);

    const turnSteps = document.createElement('div');
    turnSteps.className = 'qolc-zoom-steps';
    const turnMinus = document.createElement('button');
    turnMinus.className = 'qolc-zoom-step';
    turnMinus.textContent = '−';
    turnMinus.title = 'Turn more slowly';
    const turnValue = document.createElement('div');
    turnValue.className = 'qolc-zoom-value';
    const turnPlus = document.createElement('button');
    turnPlus.className = 'qolc-zoom-step';
    turnPlus.textContent = '+';
    turnPlus.title = 'Turn more quickly';
    turnMinus.addEventListener('click', (e) => {
      e.stopPropagation();
      setTurnSpeed(settings.turnSpeedValue - TURN_STEP);
    });
    turnPlus.addEventListener('click', (e) => {
      e.stopPropagation();
      setTurnSpeed(settings.turnSpeedValue + TURN_STEP);
    });
    turnSteps.appendChild(turnMinus);
    turnSteps.appendChild(turnValue);
    turnSteps.appendChild(turnPlus);
    turnLevelRow.appendChild(turnLevelText);
    turnLevelRow.appendChild(turnSteps);

    // Four options in the two-column grid the cosmetics tab already uses, so
    // they come out as a 2x2 block with no new CSS.
    const turnStyleRow = document.createElement('div');
    turnStyleRow.className = 'qolc-subrow';
    turnStyleRow.style.display = 'block';
    hinted(turnStyleRow, 'curve');
    const turnStyleName = document.createElement('div');
    turnStyleName.className = 'qolc-row-name';
    turnStyleName.textContent = 'Curve';
    const turnStyleNote = document.createElement('div');
    turnStyleNote.className = 'qolc-row-note';
    turnStyleNote.textContent = 'Where in the turn the extra speed is spent';
    turnStyleRow.appendChild(turnStyleName);
    const turnStyleTabs = document.createElement('div');
    turnStyleTabs.className = 'qolc-mode-tabs';
    const turnStyleButtons = [];
    for (const [id, label] of TURN_STYLES) {
      const button = document.createElement('div');
      button.className = 'qolc-mode';
      button.textContent = label;
      button.dataset.turnStyle = id;
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        setTurnStyle(id);
      });
      turnStyleTabs.appendChild(button);
      turnStyleButtons.push(button);
    }
    turnStyleRow.appendChild(turnStyleTabs);
    const turnGroup = makeCard(turnRow.row, [turnLevelRow, turnStyleRow]);
    arenaPane.appendChild(turnGroup);

    const hpNumbersRow = makeRow(
      'Damage indicator (WIP)',
      'hpNumbers',
      settings.hpNumbers,
      (on) => {
        settings.hpNumbers = on;
        store.set('hpNumbers', on);
        syncHpBarRow();
        syncHpUnitsRow();
        applyHpNumbers();
      }
    );
    genInfo.appendChild(hpNumbersRow.row);

    // 1.25.0 promoted this out of being a sub-option of the damage numbers.
    // It reads the same setting it always did and still greys out while the
    // numbers are off — but it is a top-level row now, because it is a
    // separate thing you can want and burying it made it hard to find.
    const hpBarRow = makeRow(
      'HP bar',
      'hpBar',
      settings.hpBar,
      (on) => {
        settings.hpBar = on;
        store.set('hpBar', on);
        if (!on) hpHideBar();
        syncHpUnitsRow();
        applyHpNumbers();
      }
    );
    syncHpBarRow = () => hpBarRow.row.classList.toggle('qolc-row-off', !settings.hpNumbers);
    syncHpBarRow();
    genInfo.appendChild(hpBarRow.row);

    // 1.31.0. Which unit BOTH of the rows above are read in, so it is a
    // third top-level row under them rather than a sub-option of either.
    // Nesting it inside the damage indicator's card would have said it only
    // governed the numbers, which is the one thing about it that is easy to
    // get wrong from looking at the panel.
    const hpUnitsRow = hinted(document.createElement('div'), 'hpUnits');
    hpUnitsRow.className = 'qolc-row qolc-units-row';
    const hpUnitsName = document.createElement('div');
    hpUnitsName.className = 'qolc-row-name';
    hpUnitsName.textContent = 'Show as';
    hpUnitsRow.appendChild(hpUnitsName);
    const hpUnitsTabs = document.createElement('div');
    hpUnitsTabs.className = 'qolc-mode-tabs';
    const hpUnitsButtons = [];
    for (const [id, label] of HP_UNIT_MODES) {
      const button = document.createElement('div');
      button.className = 'qolc-mode';
      button.textContent = label;
      button.dataset.hpUnits = id;
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        setHpUnits(id);
      });
      hpUnitsTabs.appendChild(button);
      hpUnitsButtons.push(button);
    }
    hpUnitsRow.appendChild(hpUnitsTabs);
    // Dim when NEITHER feature is on. The HP bar row dims on the damage
    // indicator alone because it genuinely depends on it; this one is read by
    // both, so it is still live while only one of them is.
    syncHpUnitsRow = () => {
      const mode = hpUnitsPercent() ? 'percent' : 'hp';
      for (const button of hpUnitsButtons) {
        button.classList.toggle('active', button.dataset.hpUnits === mode);
      }
      hpUnitsRow.classList.toggle('qolc-row-off', !settings.hpNumbers && !settings.hpBar);
    };
    syncHpUnitsRow();
    genInfo.appendChild(hpUnitsRow);

    // The arena starfield. Its description — including the Z hotkey and what
    // the switch does to mope's own Arena Culling — is in the info bar now,
    // like every other row's.
    const arenaSkyRow = makeRow(
      'Arena theme',
      'arenaSky',
      settings.arenaSky,
      (on) => { arenaSkySet(on, 'panel'); }
    );
    // First in the pane, though it is built after the turn card — the starfield
    // is what the category is named for.
    // Inserted as a card below, once the theme row exists to go in it.
    syncArenaSkyRow = () => {
      arenaSkyRow.sw.classList.toggle("on", !!settings.arenaSky);
      syncArenaThemeRow();
    };

    // The theme picker, as a dependent row under the switch. It is one card
    // with the switch because "is the backdrop on" and "which backdrop" are
    // the same feature answered at two levels — the same relationship the dots
    // and their names have, and the same treatment.
    const themeRow = document.createElement('div');
    themeRow.className = 'qolc-subrow';
    hinted(themeRow, 'arenaTheme');
    const themeLabel = document.createElement('div');
    themeLabel.className = 'qolc-row-name';
    themeLabel.textContent = 'Theme';
    themeRow.appendChild(themeLabel);
    const themePicks = document.createElement('div');
    themePicks.className = 'qolc-theme-picks';
    const themeButtons = [];
    for (const th of ARENA_THEMES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'qolc-theme-pick';
      btn.textContent = th.label;
      btn.title = th.note;
      btn.dataset.theme = th.id;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        settings.arenaTheme = th.id;
        store.set('arenaTheme', th.id);
        // The sky is geometry, built once and kept until the view changes
        // enough to be worth redrawing. A recolour is not a change of view, so
        // nothing would have rebuilt it — clearing the built span is how the
        // next tick is told the thing on screen is out of date.
        arenaSky.builtSpan = 0;
        syncThemePicks();
        dbg('arena theme', th.id);
      });
      themePicks.appendChild(btn);
      themeButtons.push(btn);
    }
    themeRow.appendChild(themePicks);
    function syncThemePicks() {
      const active = arenaThemeOf().id;
      for (const b of themeButtons) b.classList.toggle('is-on', b.dataset.theme === active);
    }
    syncThemePicks();
    const arenaSkyCard = makeCard(arenaSkyRow.row, [themeRow]);
    arenaPane.insertBefore(arenaSkyCard, arenaPane.firstChild);
    syncArenaThemeRow = () => {
      themeRow.classList.toggle('qolc-row-off', !settings.arenaSky);
      syncThemePicks();
    };
    syncArenaThemeRow();

    // 1.28.0's two. Both go under the starfield and above the turn card, so
    // the pane reads as "the three things that only happen in a duel" and
    // then the thing that does not.
    const biteRow = makeRow(
      'Bite indicator',
      'biteIndicator',
      settings.biteIndicator,
      (on) => {
        settings.biteIndicator = on;
        store.set('biteIndicator', on);
        if (!on) biteClearAll();
        dbg('bite indicator', on ? 'enabled' : 'disabled');
      }
    );
    // No sub-options left since 1.0.4, so it is a plain row rather than a card
    // wrapping nothing.
    arenaPane.insertBefore(biteRow.row, arenaSkyCard.nextSibling);

    const focusRow = makeRow(
      'Focus mode',
      'arenaFocus',
      settings.arenaFocus,
      (on) => {
        settings.arenaFocus = on;
        store.set('arenaFocus', on);
        // Switching it ON mid-duel has to close a composer that is already
        // open, and switching it OFF mid-duel has to give the party back
        // without waiting for the duel to end. Both are one call: the gates
        // are read live, so the only thing with any state is the composer.
        if (on) arenaFocusEnter();
        dbg('arena focus mode', on ? 'enabled' : 'disabled');
      }
    );
    arenaPane.insertBefore(focusRow.row, biteRow.row.nextSibling);

    // Draw order. Two rows rather than one three-state control, because they
    // are two things a player wants in two different moments — and each has
    // its own key, so each wants its own line showing that key.
    const zAboveRow = makeRow(
      'Draw above other players  ]',
      'zorderAbove',
      settings.zorderMode > 0,
      () => { zorderSet(1, 'panel'); }
    );
    const zBelowRow = makeRow(
      'Draw below other players  [',
      'zorderBelow',
      settings.zorderMode < 0,
      () => { zorderSet(-1, 'panel'); }
    );
    arenaPane.insertBefore(zAboveRow.row, focusRow.row.nextSibling);
    arenaPane.insertBefore(zBelowRow.row, zAboveRow.row.nextSibling);
    syncZorderRows = () => {
      // Written from zorder.mode rather than toggled, because the two switches
      // are one exclusive choice: turning either on has to turn the other off
      // on screen as well as in the state.
      zAboveRow.sw.classList.toggle('on', zorder.mode > 0);
      zBelowRow.sw.classList.toggle('on', zorder.mode < 0);
    };
    syncZorderRows();

    // 1.35.0. Under focus mode, above the turn card: it belongs with the three
    // things that only happen in a duel. Pane order is decided by where an
    // element is INSERTED and not by the order this file reads in, which is
    // the trap §6 of the handoff records — so it is insertBefore'd, checked in
    // the render, and not merely appended in the place it looks right here.
    const boostRow = makeRow(
      'Boost counter',
      'boostCounter',
      settings.boostCounter,
      (on) => {
        settings.boostCounter = on;
        store.set('boostCounter', on);
        if (!on) boostHide();
        dbg('boost counter', on ? 'enabled' : 'disabled');
      }
    );
    arenaPane.insertBefore(boostRow.row, focusRow.row.nextSibling);

    const nameEnabledRow = makeRow(
      'Player name color',
      'nameColor',
      nameColorState.enabled,
      (on) => {
        nameColorState.enabled = on;
        saveNameColor();
        domSweep();
        syncNameColorUI();
      }
    );
    cosmeticsPane.appendChild(makeSecLabel('Name color'));
    cosmeticsPane.appendChild(nameEnabledRow.row);

    const nameCard = document.createElement('div');
    nameCard.className = 'qolc-name-card';
    const preview = document.createElement('div');
    preview.id = 'qolc-name-preview';
    nameCard.appendChild(preview);

    const modes = document.createElement('div');
    modes.className = 'qolc-mode-tabs';
    const solidMode = document.createElement('div');
    solidMode.className = 'qolc-mode';
    solidMode.textContent = 'Solid';
    const gradientMode = document.createElement('div');
    gradientMode.className = 'qolc-mode';
    gradientMode.textContent = 'Gradient';
    modes.appendChild(solidMode);
    modes.appendChild(gradientMode);
    nameCard.appendChild(modes);

    const solidPane = document.createElement('div');
    const palette = document.createElement('div');
    palette.className = 'qolc-palette';
    const colorButtons = [];
    for (const [label, hex] of NAME_COLORS) {
      const color = document.createElement('button');
      color.type = 'button';
      color.className = 'qolc-color';
      color.title = label;
      color.dataset.hex = hex;
      color.style.background = hex;
      color.addEventListener('click', () => {
        nameColorState.color = hex;
        nameColorState.mode = 'solid';
        saveNameColor();
        syncNameColorUI();
      });
      palette.appendChild(color);
      colorButtons.push(color);
    }
    solidPane.appendChild(palette);
    const customRow = document.createElement('div');
    customRow.className = 'qolc-control-row';
    const customLabel = document.createElement('span');
    customLabel.textContent = 'Any custom color';
    const custom = document.createElement('input');
    custom.type = 'color';
    custom.id = 'qolc-custom-color';
    custom.addEventListener('input', (e) => {
      nameColorState.color = e.target.value;
      nameColorState.mode = 'solid';
      saveNameColor();
      syncNameColorUI();
    });
    customRow.appendChild(customLabel);
    customRow.appendChild(custom);
    solidPane.appendChild(customRow);
    nameCard.appendChild(solidPane);

    const gradientPane = document.createElement('div');
    const gradientPicker = document.createElement('div');
    gradientPicker.className = 'qolc-gradient-picker';
    const gradientTrigger = document.createElement('button');
    gradientTrigger.type = 'button';
    gradientTrigger.className = 'qolc-gradient-trigger';
    const gradientSwatch = document.createElement('span');
    gradientSwatch.className = 'qolc-gradient-swatch';
    const gradientName = document.createElement('span');
    gradientName.className = 'qolc-gradient-name';
    const gradientChevron = document.createElement('span');
    gradientChevron.className = 'qolc-gradient-chevron';
    gradientChevron.textContent = '▼';
    gradientTrigger.appendChild(gradientSwatch);
    gradientTrigger.appendChild(gradientName);
    gradientTrigger.appendChild(gradientChevron);
    const gradientMenu = document.createElement('div');
    gradientMenu.className = 'qolc-gradient-menu';
    const gradientOptions = [];
    NAME_GRADIENTS.forEach(([label], index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'qolc-gradient-option';
      option.dataset.grad = String(index);
      const swatch = document.createElement('span');
      swatch.className = 'qolc-gradient-option-swatch';
      swatch.style.backgroundImage = cssGrad(index);
      const optionName = document.createElement('span');
      optionName.textContent = label;
      option.appendChild(swatch);
      option.appendChild(optionName);
      option.addEventListener('click', (e) => {
        e.stopPropagation();
        nameColorState.grad = index;
        nameColorState.mode = 'grad';
        gradientPicker.classList.remove('open');
        saveNameColor();
        syncNameColorUI();
      });
      gradientMenu.appendChild(option);
      gradientOptions.push(option);
    });
    gradientTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      gradientPicker.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!gradientPicker.contains(e.target)) gradientPicker.classList.remove('open');
    });
    gradientPicker.appendChild(gradientTrigger);
    gradientPicker.appendChild(gradientMenu);
    const gradientStrip = document.createElement('div');
    gradientStrip.id = 'qolc-gradient-strip';
    gradientPane.appendChild(gradientPicker);
    gradientPane.appendChild(gradientStrip);

    nameCard.appendChild(gradientPane);

    solidMode.addEventListener('click', () => {
      nameColorState.mode = 'solid';
      saveNameColor();
      syncNameColorUI();
    });
    gradientMode.addEventListener('click', () => {
      nameColorState.mode = 'grad';
      saveNameColor();
      syncNameColorUI();
    });
    hinted(nameCard, 'palette');
    cosmeticsPane.appendChild(nameCard);

    const animateRow = makeRow(
      'Animate gradient',
      'animate',
      nameColorState.anim,
      (on) => {
        nameColorState.anim = on;
        saveNameColor();
        syncNameColorUI();
      }
    );
    cosmeticsPane.appendChild(makeSecLabel('Sharing'));
    cosmeticsPane.appendChild(animateRow.row);

    const shareRow = makeRow(
      'Share with script users',
      'share',
      nameColorState.share,
      (on) => {
        nameColorState.share = on;
        saveNameColor();
        syncNameColorUI();
      }
    );

    const shareWarn = document.createElement('div');
    shareWarn.className = 'qolc-name-warn';

    const relayRow = makeSubRow(
      'Online color registry',
      'registry',
      nameColorState.relay,
      (on) => {
        nameColorState.relay = on;
        saveNameColor();          // which is what tells the registry to connect
        syncNameColorUI();
      }
    );

    // Borrows the party tab's status line, dot and all — it answers the same
    // question about the same kind of connection, so it should look the same.
    const relayStatus = document.createElement('div');
    relayStatus.className = 'qolc-party-status qolc-sub-status';

    // What everyone else actually sees. The picker above shows the colour on
    // your name; this shows the same thing where it lands — and it is the only
    // place in the panel that answers "is this doing anything for anyone else".
    const tagPreviewRow = document.createElement('div');
    tagPreviewRow.className = 'qolc-subrow qolc-tagprev';
    hinted(tagPreviewRow, 'tagPreview');
    const tagPreviewLabel = document.createElement('div');
    tagPreviewLabel.className = 'qolc-row-name';
    tagPreviewLabel.textContent = 'They see';
    const tagPreview = document.createElement('div');
    tagPreview.className = 'qolc-tagprev-name';
    tagPreviewRow.appendChild(tagPreviewLabel);
    tagPreviewRow.appendChild(tagPreview);

    // Share, the registry it feeds, its status and the preview are one card.
    const shareCard = makeCard(shareRow.row,
      [relayRow.row, relayStatus, tagPreviewRow, shareWarn]);
    cosmeticsPane.appendChild(shareCard);

    const domRow = makeRow(
      'Leaderboard and menus',
      'dom',
      nameColorState.dom,
      (on) => {
        nameColorState.dom = on;
        saveNameColor();
        domSweep();
        syncNameColorUI();
      }
    );
    cosmeticsPane.appendChild(domRow.row);

    const cosmeticNote = document.createElement('div');
    cosmeticNote.className = 'qolc-cosmetic-note';
    cosmeticNote.textContent =
      'Colors are cosmetic and never touch mope. Sharing sends only the selected ' +
      'color: as invisible nickname characters, and — with the registry on — ' +
      'encrypted to a public relay under a key made from your name. Turning ' +
      'sharing off withdraws the entry.';
    cosmeticsPane.appendChild(cosmeticNote);


    const partyEnabledRow = makeRow(
      'Party',
      'party',
      party.enabled,
      (on) => {
        party.enabled = on;
        store.set(PARTY_KEYS.enabled, on);
        // A party with no code is useless, so joining one generates a code
        // rather than making the player think of one — a typed code is also
        // exactly what the fixed PBKDF2 salt is weakest against.
        if (on && !partyNormalizeCode(party.code)) {
          party.code = partyRandomCode();
          store.set(PARTY_KEYS.code, party.code);
        }
        if (on) partyConnect();
        // Leaving for real, so the join stamp goes with it: rejoining later, or
        // joining a DIFFERENT party, must not carry an old seniority into a
        // room where it was never earned.
        else { partyDisconnect('disabled'); partySetStatus('off', ''); party.joinedAt = 0; }
        syncPartyUI();
      }
    );

    const partyField = document.createElement('div');
    partyField.className = 'qolc-party-field';
    const partyCode = document.createElement('input');
    partyCode.type = 'text';
    partyCode.spellcheck = false;
    partyCode.maxLength = 24;
    partyCode.placeholder = 'Party code';
    partyCode.setAttribute('aria-label', 'Party code');
    let partyCodeTimer = 0;
    partyCode.addEventListener('input', (e) => {
      const cleaned = e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24);
      if (e.target.value !== cleaned) e.target.value = cleaned;
      party.code = cleaned;
      store.set(PARTY_KEYS.code, cleaned);
      // A new code is a different party. Seniority does not travel between
      // rooms, and the peers are cleared with it so the old roster cannot
      // decide the new party's leader.
      party.joinedAt = 0;
      // Debounced: reconnecting on every keystroke would run PBKDF2 (200k
      // iterations) once per character typed.
      clearTimeout(partyCodeTimer);
      partyCodeTimer = setTimeout(() => { if (partyActive()) partyConnect(); }, 700);
    });
    const partyRoll = document.createElement('button');
    partyRoll.className = 'qolc-party-btn';
    partyRoll.textContent = 'New';
    partyRoll.title = 'Generate a fresh random party code';
    partyRoll.addEventListener('click', (e) => {
      e.stopPropagation();
      party.code = partyRandomCode();
      store.set(PARTY_KEYS.code, party.code);
      party.joinedAt = 0;
      syncPartyUI();
      if (partyActive()) partyConnect();
    });
    const partyCopy = document.createElement('button');
    partyCopy.className = 'qolc-party-btn';
    partyCopy.textContent = 'Copy';
    partyCopy.title = 'Copy the party code so you can send it to a friend';
    partyCopy.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!partyNormalizeCode(party.code)) return;
      try {
        navigator.clipboard.writeText(party.code);
        partyCopy.textContent = 'Copied';
        setTimeout(() => { partyCopy.textContent = 'Copy'; }, 1200);
      } catch (err) { /* clipboard blocked; the field is selectable anyway */ }
    });
    partyField.appendChild(partyCode);
    partyField.appendChild(partyRoll);
    partyField.appendChild(partyCopy);

    const partyStatus = document.createElement('div');
    partyStatus.className = 'qolc-party-status';

    // Relay picker. It sits with the connection rather than with the display
    // toggles because it is the first thing to check when a party that should
    // work does not: the code can be identical and both ends connected, and
    // still nobody appears, purely because these are three separate servers.
    const partyRelayBlock = document.createElement('div');
    const partyRelayLabel = document.createElement('div');
    partyRelayLabel.className = 'qolc-party-label';
    partyRelayLabel.textContent = 'Relay';
    const partyRelays = document.createElement('div');
    partyRelays.className = 'qolc-party-relays';

    const partyRelayButtons = [];
    // -1 is Auto; the rest index PARTY_BROKERS.
    const relayChoices = [[-1, 'Auto', 'Pick a relay automatically and move on failure']];
    for (let i = 0; i < PARTY_BROKERS.length; i++) {
      relayChoices.push([i, PARTY_BROKERS[i][0], 'Always use ' + PARTY_BROKERS[i][0]]);
    }
    for (const [value, label, title] of relayChoices) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'qolc-party-relay';
      btn.textContent = label;
      btn.title = title;
      btn.dataset.relay = String(value);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        partySetRelay(value);
      });
      partyRelays.appendChild(btn);
      partyRelayButtons.push(btn);
    }
    // Relay reads as one line too: which one you are on is a single choice.
    partyRelayBlock.className = 'qolc-subrow';
    partyRelayLabel.className = 'qolc-row-name';
    partyRelayBlock.appendChild(partyRelayLabel);
    partyRelayBlock.appendChild(partyRelays);

    const partyRoster = document.createElement('div');
    partyRoster.className = 'qolc-party-roster';

    const partyEmpty = document.createElement('div');
    partyEmpty.className = 'qolc-party-empty';
    partyEmpty.textContent =
      'Nobody else yet. Send the code to a friend and have them paste it here.';

    const partyDotsRow = makeRow(
      'Party map',
      'dots',
      party.dots,
      (on) => {
        party.dots = on;
        store.set(PARTY_KEYS.dots, on);
        syncPartyUI();
      }
    );

    const partyTagsRow = makeSubRow(
      'Show names on minimap',
      'tags',
      party.tags,
      (on) => {
        party.tags = on;
        store.set(PARTY_KEYS.tags, on);
        if (!on) for (const peer of party.peers.values()) {
          if (peer.tag) peer.tag.style.display = 'none';
        }
        syncPartyUI();
      }
    );

    // The names ride on the dots — there is nothing to label if no dot is
    // drawn — so they are one card, and the names row dims with the dots.
    const partyDotsGroup = makeCard(partyDotsRow.row, [partyTagsRow.row]);
    partyOverlays.appendChild(makeSecLabel('Overlays'));
    partyOverlays.appendChild(partyDotsGroup);

    const partyChatRow = makeRow(
      'Party chat',
      'chat',
      party.chat,
      (on) => {
        party.chat = on;
        store.set(PARTY_KEYS.chat, on);
        // Switching it off drops you back to public chat rather than leaving
        // the mode set with no way to see or change it.
        if (!on) { partyChat.mode = false; partyChatCloseInput(); partyChatClear(); }
        syncPartyUI();
      }
    );
    partyOverlays.appendChild(partyChatRow.row);

    const partyListRowUi = makeRow(
      'Party list',
      'list',
      party.list,
      (on) => {
        party.list = on;
        store.set(PARTY_KEYS.list, on);
        // Off takes it off screen at once rather than on the next pass, which
        // is 250ms away and long enough to read as the switch not working.
        if (!on) partyListHide();
        syncPartyUI();
      }
    );

    // 1.22.0. Two sub-options, both added on player feedback, both default off.
    // Sub-rows of the list rather than rows of their own: neither does anything
    // with the list switched off, and the panel should say so rather than offer
    // a switch that silently achieves nothing.
    const partyListSelfRow = makeSubRow(
      'Include yourself',
      'listSelf',
      party.listSelf,
      (on) => {
        party.listSelf = on;
        store.set(PARTY_KEYS.listSelf, on);
        // Turning it off in a party of one empties the list, and the tick only
        // reaches its own hide 250ms later. Hide now so the switch is believed.
        if (!on && !party.peers.size) partyListHide();
        syncPartyUI();
      }
    );

    const partyListBoxRow = makeSubRow(
      'Box around the list',
      'listBox',
      party.listBox,
      (on) => {
        party.listBox = on;
        store.set(PARTY_KEYS.listBox, on);
        syncPartyUI();
      }
    );
    // The list and its two sub-options are one card. Nesting is what says they
    // belong to it; 1.24.0 drew a branch line to say the same thing and spent
    // a release getting that line to join up.
    const partyListGroup = makeCard(partyListRowUi.row,
      [partyListSelfRow.row, partyListBoxRow.row]);
    partyOverlays.appendChild(partyListGroup);

    // Greyed out while the party is off OR the list is off — the same
    // treatment "Your HP bar" gets under the damage numbers. Both conditions
    // matter: with the party off nothing in this tab does anything, and with
    // the list off these two specifically do not.
    syncPartyListSubRows = () => {
      const off = !party.enabled || !party.list;
      partyListGroup.kids.classList.toggle('qolc-row-off', off);
      partyListSelfRow.sw.classList.toggle('on', party.listSelf);
      partyListBoxRow.sw.classList.toggle('on', party.listBox);
    };
    syncPartyListSubRows();

    // Your own dot colour. It sits with the display toggles rather than with
    // the connection because it is a display choice — just one that takes
    // effect on everyone else's minimap instead of on yours.
    const partyColorBlock = document.createElement('div');
    const partyColorLabel = document.createElement('div');
    partyColorLabel.className = 'qolc-party-label';
    partyColorLabel.textContent = 'Your dot color';
    const partyPalette = document.createElement('div');
    partyPalette.className = 'qolc-party-palette';
    const partyColorButtons = [];
    for (let i = 0; i < PARTY_DOT_COLORS.length; i++) {
      const preset = PARTY_DOT_COLORS[i];
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'qolc-color';
      swatch.title = preset.name + (i === 0 ? ' (default)' : '');
      swatch.dataset.idx = String(i);
      swatch.style.background = preset.fill;
      swatch.addEventListener('click', (e) => {
        e.stopPropagation();
        party.color = i;
        store.set(PARTY_KEYS.color, i);
        // Peers only learn about this on the next publish, and the pacer holds
        // that back for up to two seconds while you stand still — which is
        // exactly when someone is most likely to be fiddling with the panel.
        // Clearing it lets the very next frame carry the change.
        if (party.pacer) party.pacer.reset();
        syncPartyUI();
      });
      partyPalette.appendChild(swatch);
      partyColorButtons.push(swatch);
    }
    // Label left, swatches right, on one line — the panel is 884px wide and
    // eleven 25px circles fit across it with room to spare, so stacking them
    // under a heading was spending 40px of a fixed pane on nothing.
    partyColorBlock.className = 'qolc-subrow';
    partyColorLabel.className = 'qolc-row-name';
    partyColorBlock.appendChild(partyColorLabel);
    partyColorBlock.appendChild(partyPalette);

    // Your handle. It is normally read from the account and this field is left
    // empty — which is why the block SHOWS what was found rather than putting
    // it in the box. A found handle in the box would be indistinguishable from
    // an override, and the moment it went stale there would be no way to tell
    // which of the two was on screen.
    const partyHandleBlock = document.createElement('div');
    const partyHandleLabel = document.createElement('div');
    partyHandleLabel.className = 'qolc-party-label';
    partyHandleLabel.textContent = 'Your handle';
    const partyHandleNote = document.createElement('div');
    partyHandleNote.className = 'qolc-row-note';
    const partyHandleField = document.createElement('input');
    partyHandleField.type = 'text';
    partyHandleField.spellcheck = false;
    partyHandleField.maxLength = 25;
    partyHandleField.placeholder = 'Read from your account';
    partyHandleField.setAttribute('aria-label', 'Party chat handle override');
    partyHandleField.addEventListener('input', (e) => {
      e.stopPropagation();
      // Stored exactly as typed, including something the validator will
      // reject: silently rewriting the field while it is being typed in makes
      // it impossible to use. partySelfHandle() is what decides whether it
      // counts, and the note below says which way it went.
      party.handle = String(partyHandleField.value || '').slice(0, 25);
      store.set(PARTY_KEYS.handle, party.handle);
      syncPartyUI();
    });
    const partyHandleWrap = document.createElement('div');
    partyHandleWrap.className = 'qolc-party-field';
    partyHandleWrap.appendChild(partyHandleField);
    partyHandleBlock.className = 'qolc-subrow qolc-handle-row';
    partyHandleLabel.className = 'qolc-row-name';
    partyHandleBlock.appendChild(partyHandleLabel);
    partyHandleBlock.appendChild(partyHandleNote);
    partyHandleBlock.appendChild(partyHandleWrap);

    // The connection, and who it found. One card under the Party map switch:
    // the code, the relay it is reached through and the people it reached are
    // three views of the same thing, and the map switch is what turns them on.
    hinted(partyField, 'code');
    hinted(partyRelayBlock, 'relay');
    hinted(partyRoster, 'roster');
    hinted(partyEmpty, 'roster');
    partyField.classList.add('qolc-subrow');
    partyStatus.classList.add('qolc-sub-status');
    partyRoster.classList.add('qolc-subblock');
    // Roster and empty line are two states of the same thing, and only one is
    // ever on screen — so the roster is COLLAPSED rather than left standing as
    // an empty inset, which is what reserved space for both in a pane that has
    // none to spare. They stay siblings: syncPartyUI clears the roster with
    // textContent = '', so anything nested inside it is destroyed on the first
    // sync.
    const partyConnCard = makeCard(partyEnabledRow.row,
      [partyField, partyStatus, partyRelayBlock, partyRoster, partyEmpty]);
    partyTop.appendChild(partyConnCard);

    // You, as the rest of the party sees you. Two top-level rows rather than a
    // card: a card with no parent switch at its head is 26px of border and
    // padding wrapped around nothing, and the pane has a fixed budget.
    partyColorBlock.className = 'qolc-row';
    partyHandleBlock.className = 'qolc-row qolc-handle-row';
    hinted(partyColorBlock, 'dotColor');
    hinted(partyHandleBlock, 'handle');
    partyTop.appendChild(partyColorBlock);
    partyTop.appendChild(partyHandleBlock);


    const togglePanel = (e) => {
      if (e) e.stopPropagation();
      const opening = panel.style.display !== 'block';
      if (opening) positionExtrasPanel();
      panel.style.display = opening ? 'block' : 'none';
    };
    btn.addEventListener('click', togglePanel);

    for (const el of [btn, panel]) {
      for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
        el.addEventListener(type, (e) => e.stopPropagation());
      }
    }

    host.appendChild(btn);
    host.appendChild(panel);
    host.appendChild(hint);
    extras = {
      btn,
      panel,
      hint,
      cats,
      info,
      current: 'general',
      partyUi: {
        enabled: partyEnabledRow.sw,
        code: partyCode,
        status: partyStatus,
        roster: partyRoster,
        empty: partyEmpty,
        dots: partyDotsRow.sw,
        dotsRow: partyDotsRow.row,
        tags: partyTagsRow.sw,
        tagsRow: partyTagsRow.row,
        chat: partyChatRow.sw,
        chatRow: partyChatRow.row,
        list: partyListRowUi.sw,
        listRow: partyListRowUi.row,
        handle: partyHandleField,
        handleBlock: partyHandleBlock,
        handleNote: partyHandleNote,
        colors: partyColorButtons,
        colorBlock: partyColorBlock,
        relays: partyRelayButtons,
      },
      zoomUi: {
        row: zoomRow.row,
        sw: zoomRow.sw,
        hookRow,
        hookNote,
        hookBtn,
      },
      turnUi: {
        sw: turnRow.sw,
        level: turnLevelRow,
        value: turnValue,
        minus: turnMinus,
        plus: turnPlus,
        styleRow: turnStyleRow,
        styles: turnStyleButtons,
      },
      nameUi: {
        enabled: nameEnabledRow.sw,
        preview,
        solidMode,
        gradientMode,
        solidPane,
        gradientPane,
        colors: colorButtons,
        custom,
        gradientPicker,
        gradientMenu,
        gradientName,
        gradientSwatch,
        gradientOptions,
        gradientStrip,
        animate: animateRow.sw,
        share: shareRow.sw,
        shareWarn,
        relay: relayRow.sw,
        relayStatus,
        dom: domRow.sw,
        tagPreview,
      },
    };
    // Select a category. Nothing else does this at build time, and without it
    // the panel opens with no pane active at all — which is what 1.26.0
    // shipped: four category titles stacked over an empty body on the very
    // first open, until something happened to call setExtrasTab.
    //
    // 1.24.0 never had the bug because its first view was born with 'active'
    // in its class string; makeCategory() builds every pane the same way, so
    // the initial selection has to be made rather than inherited. It runs here
    // because setExtrasTab reads the extras object, which is assigned just above.
    setExtrasTab('general');

    syncNameColorUI();
    syncZoomUI();
    syncTurnUI();

    /* ---- Settings: keybinds ---- */
    //
    // One row per bind: what it does, the key it is on, whether it wins or
    // yields when something else wants that key, and what is currently wrong
    // with it. The hazard chip is last because it is the thing you look for
    // when scanning the list and the thing you ignore when there is none.
    settingsPane.appendChild(makeSecLabel('Keybinds'));

    const kbRows = [];
    const kbList = document.createElement('div');
    kbList.className = 'qolc-kb-list';

    for (const bind of KEYBINDS) {
      const row = document.createElement('div');
      row.className = 'qolc-kb-row';

      const name = document.createElement('div');
      name.className = 'qolc-kb-name';
      name.textContent = bind.label;

      // The key cap. Clicking it arms capture; the NEXT key pressed becomes
      // the bind. Escape cancels, because a capture with no way out is a trap
      // for anyone who clicked it by accident, and Backspace clears.
      const cap = document.createElement('button');
      cap.type = 'button';
      cap.className = 'qolc-kb-cap';
      cap.addEventListener('click', (e) => {
        e.stopPropagation();
        kbBeginCapture(bind.id);
      });

      // Unbinding as a BUTTON and not only as a keystroke. The keyboard
      // gesture is faster once you know it and undiscoverable until you do;
      // this is the half of it that can be found by looking. It is hidden
      // rather than disabled on a bind that is already off, because ten dead
      // controls down a column read as broken rather than as finished.
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'qolc-kb-clear';
      clear.textContent = '×';
      clear.title = 'Unbind this key';
      clear.setAttribute('aria-label', 'Unbind ' + bind.label);
      clear.addEventListener('click', (e) => {
        e.stopPropagation();
        // A capture armed on some OTHER row has to be cancelled first, or it
        // stays armed with its prompt off screen and eats the next key pressed.
        if (kbArmed) kbEndCapture();
        kbClearCode(bind.id);
        syncKeybinds();
      });

      // Priority. Two states rather than a switch, because "override" and
      // "underride" are two named things and a switch would have to imply one
      // of them is the off position.
      const prio = document.createElement('button');
      prio.type = 'button';
      prio.className = 'qolc-kb-prio';
      prio.addEventListener('click', (e) => {
        e.stopPropagation();
        kbSetPrio(bind.id, kbPrio(bind.id) === 'override' ? 'underride' : 'override');
        syncKeybinds();
      });

      const haz = document.createElement('span');
      haz.className = 'qolc-kb-haz';

      row.appendChild(name);
      row.appendChild(haz);
      row.appendChild(prio);
      row.appendChild(cap);
      row.appendChild(clear);
      kbList.appendChild(row);
      kbRows.push({bind, row, cap, prio, haz, clear});
    }
    settingsPane.appendChild(kbList);

    const kbFoot = document.createElement('div');
    kbFoot.className = 'qolc-kb-foot';
    const kbNote = document.createElement('div');
    kbNote.className = 'qolc-kb-note';
    const kbReset = document.createElement('button');
    kbReset.type = 'button';
    kbReset.className = 'qolc-obtn qolc-obtn-sm';
    kbReset.textContent = 'Reset all keybinds';
    kbReset.addEventListener('click', (e) => {
      e.stopPropagation();
      kbResetAll();
      syncKeybinds();
    });
    kbFoot.appendChild(kbNote);
    kbFoot.appendChild(kbReset);
    settingsPane.appendChild(kbFoot);

    // Capture. The armed row is held here rather than on the element so that
    // only one can ever be armed, and so that a pane rebuild cannot leave a
    // listener waiting on a row nobody can see.
    let kbArmed = '';
    function kbBeginCapture(id) {
      kbArmed = id;
      kb.capturing = true;
      syncKeybinds();
    }
    kbCancelCapture = () => { if (kbArmed) kbEndCapture(); };
    function kbEndCapture() {
      kbArmed = '';
      kb.capturing = false;
      syncKeybinds();
    }
    // On the window at capture, ahead of every other handler in this script
    // AND ahead of mope's — while a capture is armed the key belongs to the
    // panel and to nothing else, which is why this consumes the event
    // outright. kbHit() also refuses everything while kb.capturing is set, so
    // even a handler registered earlier cannot act on the press.
    // The keys a bind may actually be. Everything else is refused, and refused
    // WITHOUT being consumed — the previous form called preventDefault before
    // deciding, so while a capture was armed F5 would not reload and F12 would
    // not open devtools, with nothing on screen to say why.
    //
    // Backspace and Delete are deliberately NOT in this list: they are the
    // gesture that CLEARS a bind, which is worth more than the ability to put
    // a hotkey on Delete. A bind already sitting on Delete from an older build
    // still loads and still fires — the loader validates shape, not this list
    // — it simply cannot be chosen again from here.
    const KB_BINDABLE = /^(Key[A-Z]|Digit[0-9]|Numpad[A-Za-z0-9]+|F[1-9]|F1[0-2]|Bracket(Left|Right)|Semicolon|Quote|Comma|Period|Slash|Backslash|Backquote|Minus|Equal|Arrow(Up|Down|Left|Right)|Space|Insert|Home|End|Page(Up|Down))$/;
    // Refused even though they match above: the browser needs them more than a
    // mope hotkey does, and binding one would be a trap with no way back.
    const KB_FORBIDDEN = {F5: 1, F11: 1, F12: 1};
    // Both keys clear, because both are what people reach for and there is no
    // way to know which one a given person means by "get this off my key".
    const KB_CLEAR = {Backspace: 1, Delete: 1};

    PAGE.addEventListener('keydown', (event) => {
      if (!kbArmed || !event.isTrusted) return;
      const code = event.code;
      if (!code) return;
      // Escape is the way out, and is consumed so it does not also close
      // whatever else on the page listens for it.
      if (code === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        kbEndCapture();
        return;
      }
      // Unbind. Consumed for the same reason a real bind is — while a capture
      // is armed the key belongs to the panel — and Backspace in particular
      // has to be swallowed, because on a page with no focused field some
      // setups still read it as "go back".
      if (KB_CLEAR[code]) {
        event.preventDefault();
        event.stopImmediatePropagation();
        kbClearCode(kbArmed);
        kbEndCapture();
        return;
      }
      // Modifier keys alone are not binds. Pressing shift to reach a symbol
      // would otherwise capture "ShiftLeft" and leave the bind unusable. Held
      // rather than cancelled, so the capture waits for the real key.
      if (/^(Shift|Control|Alt|Meta)/.test(code)) return;
      if (!KB_BINDABLE.test(code) || KB_FORBIDDEN[code]) {
        // Not consumed: the browser gets its key, and the capture stands down
        // rather than sitting armed on a press the user meant for something
        // else.
        kbEndCapture();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      kbSetCode(kbArmed, code);
      kbEndCapture();
    }, true);

    // A capture that is armed and then abandoned would leave kb.capturing set
    // forever, and kbHit() refuses everything while it is — so walking away
    // from a half-finished rebind would silently kill every hotkey in the
    // script until the panel was reopened and Escape pressed. Both ways out of
    // the panel therefore cancel it.
    document.addEventListener('mousedown', (e) => {
      if (!kbArmed) return;
      // The armed cap itself is not an escape: clicking it again should read
      // as still waiting, not as a cancel that looks like nothing happened.
      const on = e.target && e.target.closest &&
        e.target.closest('.qolc-kb-cap.is-armed');
      if (!on) kbEndCapture();
    }, true);
    PAGE.addEventListener('blur', () => { if (kbArmed) kbEndCapture(); });

    syncKeybinds = () => {
      let worst = '';
      for (const r of kbRows) {
        const armed = kbArmed === r.bind.id;
        const code = kbCode(r.bind.id);
        r.cap.textContent = armed ? 'Press a key… (⌫ clears)'
          : code ? kbLabelOf(code) : 'Not bound';
        r.cap.classList.toggle('is-armed', armed);
        r.cap.classList.toggle('is-unbound', !armed && !code);
        r.cap.title = code
          ? 'Click to rebind. Backspace or Delete clears it.'
          : 'Not bound — click to set a key.';
        // Nothing to clear on a bind that is already off, and a dead button on
        // every unbound row would read as broken rather than as finished.
        r.clear.classList.toggle('is-idle', !code);
        const over = kbPrio(r.bind.id) === 'override';
        r.prio.textContent = over ? 'Override' : 'Underride';
        r.prio.classList.toggle('is-over', over);
        r.prio.title = over
          ? 'This key is ours. mope never sees it.'
          : 'mope wins wherever it claims this key, and this works everywhere else.';
        const list = kbConflicts(r.bind.id);
        const kind = kbWorstKind(list);
        r.haz.className = 'qolc-kb-haz' + (kind ? ' is-' + kind : '');
        r.haz.textContent = kind === 'ours' ? '!!' : kind ? '!' : '';
        r.haz.title = list.length
          ? list.map((c) => c.kind === 'ours' ? 'Also bound to: ' + c.what
              : c.kind === 'fixed' ? 'mope uses this key for ' + c.what
              : 'mope has "' + c.what + '" bound to this key').join('\n')
          : '';
        r.row.classList.toggle('has-clash', !!kind);
        // Ranked, not last-wins. The previous form let a 'bound' row further
        // down the list overwrite a 'fixed' row above it, so the summary named
        // the milder problem — on the one line whose job is to say which
        // problem matters.
        const rank = {ours: 3, fixed: 2, bound: 1};
        if ((rank[kind] || 0) > (rank[worst] || 0)) worst = kind;
      }
      // One line that says what the list means, so the chips do not have to be
      // hovered one at a time to find out whether anything is actually broken.
      // With nothing wrong it says how to unbind instead, because that is the
      // one thing about this list you cannot discover by looking at it.
      kbNote.textContent = worst === 'ours'
        ? 'Two Lumi’s Extras binds share a key. One of them will not fire.'
        : worst === 'fixed'
          ? 'A bind sits on a key mope uses itself. Underride yields to it; Override takes it.'
          : worst === 'bound'
            ? 'A bind sits on a key you have bound in mope. Underride yields to it; Override takes it.'
            : mopeSettingsProxy()
              ? 'No conflicts. Press × to unbind a key, or Backspace while setting one.'
              : 'No conflicts found — but mope’s own bind list could not be read, so clashes with it cannot be seen.';
      kbNote.className = 'qolc-kb-note' + (worst ? ' is-' + worst : '');
    };
    syncKeybinds();

    /* ---- Settings: panel theme ---- */
    settingsPane.appendChild(makeSecLabel('Appearance'));
    const themePanelRow = document.createElement('div');
    themePanelRow.className = 'qolc-subrow';
    hinted(themePanelRow, 'panelTheme');
    const themePanelLabel = document.createElement('div');
    themePanelLabel.className = 'qolc-row-name';
    themePanelLabel.textContent = 'Panel theme';
    themePanelRow.appendChild(themePanelLabel);
    const themePanelPicks = document.createElement('div');
    themePanelPicks.className = 'qolc-theme-picks';
    const panelThemeButtons = [];
    for (const th of PANEL_THEMES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'qolc-theme-pick';
      btn.textContent = th.label;
      btn.title = th.note;
      btn.dataset.ptheme = th.id;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        panelThemeSet(th.id);
        syncPanelTheme();
      });
      themePanelPicks.appendChild(btn);
      panelThemeButtons.push(btn);
    }
    themePanelRow.appendChild(themePanelPicks);
    settingsPane.appendChild(themePanelRow);

    /* ---- Settings: troubleshooting ---- */
    // 1.0.24. This lived in Tampermonkey's menu, which the extension does not
    // have, so it is here for both — one place, whichever way it was installed.
    settingsPane.appendChild(makeSecLabel('Troubleshooting'));
    const debugRow = makeRow('Debug logging', 'debugLogging', settings.debug, (on) => {
      settings.debug = on;
      store.set('debug', on);
      console.log(TAG, 'debug', on ? 'enabled' : 'disabled');
    });
    settingsPane.appendChild(debugRow.row);

    // 1.1.0. What the game bridge found — the one line to read when something
    // in game is not appearing, and a report to paste to Lumi.
    const hookRecRow = document.createElement('div');
    hookRecRow.className = 'qolc-subrow';
    hinted(hookRecRow, 'gameLink');
    const hookRecName = document.createElement('div');
    hookRecName.className = 'qolc-row-name';
    hookRecName.textContent = 'Game connection';
    const hookRecNote = document.createElement('div');
    hookRecNote.className = 'qolc-row-note';
    const hookRecBtn = document.createElement('button');
    hookRecBtn.className = 'qolc-hook-btn';
    hookRecBtn.type = 'button';
    hookRecBtn.textContent = 'Copy report';
    hookRecBtn.title = 'Copy a report to the clipboard, to paste to Lumi';
    hookRecBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const done = (ok) => {
        hookRecBtn.textContent = ok ? 'Copied' : 'Copy failed';
        setTimeout(() => { hookRecBtn.textContent = 'Copy report'; }, 1500);
      };
      try { navigator.clipboard.writeText(lumiReport()).then(() => done(true), () => done(false)); }
      catch (err) { done(false); }
    });
    hookRecRow.appendChild(hookRecName);
    hookRecRow.appendChild(hookRecNote);
    hookRecRow.appendChild(hookRecBtn);
    settingsPane.appendChild(hookRecRow);

    // The update check is the extension's alone, so a Tampermonkey copy does
    // not get a switch that would do nothing.
    let updateNote = null;
    if (QOLC_VIA === 'extension') {
      const updateRow = makeRow('Check for updates', 'updateCheck', settings.updateCheck, (on) => {
        settings.updateCheck = on;
        store.set('updateCheck', on);
        if (on) store.set('updateCheckedAt', 0);
        syncTroubleshootingUI();
      });
      settingsPane.appendChild(updateRow.row);
      updateNote = document.createElement('div');
      updateNote.className = 'qolc-subrow';
      const updateName = document.createElement('div');
      updateName.className = 'qolc-row-note';
      const updateBtn = document.createElement('button');
      updateBtn.className = 'qolc-hook-btn';
      updateBtn.type = 'button';
      updateBtn.textContent = 'Releases';
      updateBtn.title = 'Open the GitHub releases page in a new tab';
      // No name column on this row, so the button is pushed to the edge by
      // hand to line up with Copy report above it.
      updateBtn.style.marginLeft = 'auto';
      updateBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        PAGE.open(UPDATE_PAGE, '_blank', 'noopener');
      });
      updateNote.appendChild(updateName);
      updateNote.appendChild(updateBtn);
      updateNote.textEl = updateName;
      settingsPane.appendChild(updateNote);
    }
    syncTroubleshootingUI = () => {
      hookRecNote.textContent = bridgeSummary();
      if (updateNote) {
        const latest = updateAvailable();
        updateNote.textEl.textContent = latest
          ? 'Version ' + latest + ' is out. You have ' + VERSION + '.'
          : settings.updateCheck ? 'Up to date (' + VERSION + ').' : 'Not checking. You have ' + VERSION + '.';
      }
    };
    syncTroubleshootingUI();
    function syncPanelTheme() {
      const active = panelThemeOf().id;
      for (const b of panelThemeButtons) {
        b.classList.toggle('is-on', b.dataset.ptheme === active);
      }
    }
    syncPanelTheme();
    syncPartyUI();
    // ON THE WINDOW AT CAPTURE, like every other hotkey here. It was on
    // `document` until 1.0.7, which put it DOWNSTREAM of mope's own handlers —
    // capture visits window before document — so setting this bind to Override
    // on a key mope has bound did nothing at all: mope had already acted by the
    // time preventDefault ran. Override was silently inoperative for the one
    // bind most likely to be moved.
    //
    // The hand-rolled typing check that used to sit here is gone with it:
    // kbHit calls kbTyping(), which is the same test plus the #chatInput check
    // this copy was missing.
    PAGE.addEventListener('keydown', (e) => {
      if (!kbHit('panel', e) || !inGame()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      togglePanel(e);
    }, true);
    // The stored theme, applied once the panel element exists to carry it.
    panelThemeApply();
    return extras;
  }
  // ------------------------------------------- canvas negative-radius guard
  //
  // Some devices end up passing a negative radius into the 2D context, and
  // the canvas API throws on that (IndexSizeError / RangeError) rather than
  // ignoring it. Thrown mid-frame it takes the whole render loop down, so the
  // game stops drawing. Clamping the offending argument to 0 turns a fatal
  // frame into a slightly-wrong one.
  //
  // Folded in from the standalone "Canvas negative-radius crash fix" script.
  // The __radiusFixed marker is deliberately the SAME name that script used,
  // so running both installed at once wraps the methods exactly once rather
  // than twice.
  const radiusFixStats = Object.create(null);
  let lastRadiusLog = 0;

  function radiusClamp(value, method) {
    // Only FINITE negatives are clamped, because only those throw. Canvas
    // silently ignores NaN and ±Infinity — the whole call becomes a no-op —
    // so passing them through leaves behaviour identical. (-Infinity is the
    // one to watch: it is negative but must not be turned into a real
    // zero-radius arc that the browser would then actually add to the path.)
    const n = +value;
    if (!Number.isFinite(n) || n >= 0) return value;
    radiusFixStats[method] = (radiusFixStats[method] || 0) + 1;
    const now = Date.now();
    if (now - lastRadiusLog >= 2000) {
      lastRadiusLog = now;
      dbg('radius fix: clamped', method, n, 'totals', Object.assign({}, radiusFixStats));
    }
    return 0;
  }

  function radiusPatch(proto, name, fix) {
    if (!proto) return;
    const original = proto[name];
    if (typeof original !== 'function' || original.__radiusFixed) return;
    const wrapped = function () {
      return original.apply(this, fix(arguments));
    };
    wrapped.__radiusFixed = true;
    // Keep the function looking native-ish; some engines sniff these.
    try {
      Object.defineProperty(wrapped, 'name', {value: name});
      Object.defineProperty(wrapped, 'length', {value: original.length});
    } catch (e) { /* non-fatal */ }
    proto[name] = wrapped;
  }

  function radiusPatchProto(proto) {
    // arc(x, y, radius, startAngle, endAngle, ccw)
    radiusPatch(proto, 'arc', (a) => {
      a[2] = radiusClamp(a[2], 'arc');
      return a;
    });
    // arcTo(x1, y1, x2, y2, radius)
    radiusPatch(proto, 'arcTo', (a) => {
      a[4] = radiusClamp(a[4], 'arcTo');
      return a;
    });
    // ellipse(x, y, radiusX, radiusY, rotation, start, end, ccw)
    radiusPatch(proto, 'ellipse', (a) => {
      a[2] = radiusClamp(a[2], 'ellipse');
      a[3] = radiusClamp(a[3], 'ellipse');
      return a;
    });
    // createRadialGradient(x0, y0, r0, x1, y1, r1)
    radiusPatch(proto, 'createRadialGradient', (a) => {
      a[2] = radiusClamp(a[2], 'createRadialGradient');
      a[5] = radiusClamp(a[5], 'createRadialGradient');
      return a;
    });
    // roundRect(x, y, w, h, radii) — radii may be a number, a DOMPoint-ish
    // object, or an array of either. Negative entries throw RangeError.
    //
    // 1.0.10 actually handles the object form this comment has always named.
    // A {x, y} radius fell through both branches untouched, so the one shape
    // the comment called out by name was the one still able to take the render
    // loop down. Handled by copying the point rather than writing to it: the
    // caller owns that object and may reuse it across draws, so clamping in
    // place would silently rewrite mope's own geometry.
    const clampRadius = (v) => {
      if (typeof v === 'number' || typeof v === 'string') return radiusClamp(v, 'roundRect');
      if (v && typeof v === 'object') {
        const x = radiusClamp(v.x, 'roundRect');
        const y = radiusClamp(v.y, 'roundRect');
        // Only replaced when something actually needed clamping, so the normal
        // path allocates nothing and hands back the caller's own object.
        return (x === v.x && y === v.y) ? v : {x, y};
      }
      return v;
    };
    radiusPatch(proto, 'roundRect', (a) => {
      const r = a[4];
      if (Array.isArray(r)) {
        let changed = false;
        const out = new Array(r.length);
        for (let i = 0; i < r.length; i++) {
          out[i] = clampRadius(r[i]);
          if (out[i] !== r[i]) changed = true;
        }
        // Allocate only when a clamp actually happened; roundRect is a
        // per-frame call and mope passes a plain number on the ordinary path.
        if (changed) a[4] = out;
      } else if (r != null) {
        a[4] = clampRadius(r);
      }
      return a;
    });
  }

  function hookCanvasRadius() {
    try {
      radiusPatchProto(PAGE.CanvasRenderingContext2D && PAGE.CanvasRenderingContext2D.prototype);
      radiusPatchProto(PAGE.OffscreenCanvasRenderingContext2D &&
        PAGE.OffscreenCanvasRenderingContext2D.prototype);
      radiusPatchProto(PAGE.Path2D && PAGE.Path2D.prototype);
      // Peek at what has been clamped: __radiusFixStats() in the console.
      Object.defineProperty(PAGE, '__radiusFixStats', {
        value: () => Object.assign({}, radiusFixStats),
        configurable: true,
      });
      dbg('canvas radius guard installed');
    } catch (e) {
      dbg('canvas radius guard failed', e);
    }
  }


  /* ================================ go ================================ */

  /* ----- menu <-> game ----- */

  let lastScreen = '';
  let firstGameHintShown = false;
  let gameHintTimer = 0;

  function showFirstGameHint() {
    const current = ensureExtrasUI();
    if (!current || !current.hint) return;
    const hint = current.hint;
    hint.classList.remove('qolc-show');
    void hint.offsetWidth;   // restart the entrance animation
    hint.classList.add('qolc-show');
    clearTimeout(gameHintTimer);
    gameHintTimer = setTimeout(() => hint.classList.remove('qolc-show'), 6500);
  }

  // mope's own screen state, watched for the two edges that matter: the
  // first game of the session (show the N hint) and the return to the menu
  // (close the in-game panel and any half-done rebind).
  function screenTick() {
    const screen = mopeScreen();
    if (screen === lastScreen) return;
    const was = lastScreen;
    lastScreen = screen;
    if (screen === 'HUD' && was === 'menu' && !firstGameHintShown) {
      firstGameHintShown = true;
      showFirstGameHint();
    } else if (screen === 'menu' && was && was !== 'menu') {
      kbCancelCapture();
      if (extras) extras.panel.style.display = 'none';
    }
  }

  // Bottom-left corner of the menu. Lumi's Moderator Extras puts its own
  // launcher immediately to the right of this one by measuring it, so the
  // inset is shared and must not move on its own.
  const EXTRAS_BTN_EDGE = 24;

  function positionExtrasBtn() {
    if (!extras) return;
    const btn = extras.btn;
    if (!inGame()) {
      const edge = EXTRAS_BTN_EDGE + 'px';
      if (btn.style.display !== 'block') btn.style.display = 'block';
      if (btn.style.left !== edge) btn.style.left = edge;
      if (btn.style.bottom !== edge) btn.style.bottom = edge;
      if (btn.style.right !== 'auto') btn.style.right = 'auto';
      if (btn.style.top !== 'auto') btn.style.top = 'auto';
    } else if (btn.style.display !== 'none') {
      // In game, N replaces the on-screen button.
      btn.style.display = 'none';
    }
    if (extras.panel.style.display === 'block') positionExtrasPanel();
  }

  /* ----- DOM clutter scanning ----- */

  let domScanQueued = false;

  function scanDom() {
    domScanQueued = false;
    applyCluttersIfEnabled();
  }

  function startDomObserver() {
    const target = document.body || document.documentElement;
    if (!target) return;
    const observer = new MutationObserver(() => {
      if (!settings.masterEnabled || (!settings.menuClutter && !settings.gameClutter)) return;
      if (domScanQueued) return;
      domScanQueued = true;
      setTimeout(scanDom, 250);
    });
    observer.observe(target, {childList: true, subtree: true});
    setInterval(() => {
      if (settings.menuClutter || settings.gameClutter) scanDom();
    }, 600);
  }

  /* ----- everything that draws, once per frame the game draws ----- */

  onFrame('name colours', nameFrame);
  onFrame('damage numbers and HP bar', hpFrame);
  onFrame('arena', arenaFrame);
  onFrame('party', partyTick);

  /* ----- the console ----- */

  // One object for every diagnostic. The 1.0.x names that people already
  // know are kept as aliases.
  const lumiConsole = {
    version: VERSION,
    status() {
      const report = {
        version: VERSION,
        via: QOLC_VIA,
        connection: bridgeSummary(),
        screen: mopeScreen(),
        yourAnimal: myAnimal() ? artKeyOf(myAnimal()) || '(unknown species)' : '(none)',
        framesDrawn: frame.frames,
        zoomHooked: zoomHub.hooked(),
        featureErrors: featureErrors.size
          ? [...featureErrors].map(([name, row]) => name + ' x' + row.count).join(', ') : 'none',
      };
      console.table ? console.table(report) : console.log(report);
      return Object.assign(report, {bridge: bridge.status()});
    },
    report() { const text = lumiReport(); console.log(text); return text; },
    health: hpDebug,
    arena: arenaDebug,
    party: partyDebug,
    zoom: zoomDebug,
    keybinds: kbDebug,
    registry: nrDebug,
    errors() { return [...featureErrors].map(([name, row]) => Object.assign({name}, row)); },
    // mope's own game object, for anyone poking around in the console.
    get game() { return bridge.game; },
    // Everything the bridge found: the game, the Entity and Animal classes,
    // the animal configs and the HUD stores.
    get mope() {
      const stores = {};
      for (const name of ['hud', 'stats', 'arena', 'leaderboard', 'ui', 'death']) stores[name] = bridge.store(name);
      return {game: bridge.game, Entity: bridge.Entity, Animal: bridge.Animal, configs: bridge.configs, stores};
    },
  };
  expose('__lumi', lumiConsole);
  expose('__lumiInstances', () => qolcInstances.map((i, n) => ({
    copy: n + 1, version: i.version, via: i.via, startedAtMs: Math.round(i.at),
  })));
  expose('__lumiZoomDebug', zoomDebug);
  expose('__lumiArenaDebug', arenaDebug);
  expose('__lumiHpDebug', hpDebug);
  expose('__lumiCaptureDebug', () => lumiConsole.status());
  expose('__lumiPerfDebug', () => ({frames: frame.frames, featureErrors: lumiConsole.errors()}));

  /* ----- start ----- */

  hookCanvasRadius();
  installGradientCodes();
  bridge.start();
  bridge.ready().then(() => {
    startFrameHook();
    turnInstall();
    dbg('ready —', bridgeSummary());
  });

  function onReady() {
    ensureExtrasUI();
    startDomObserver();
    startClutterLoop();
    applyAbilityCooldown();
    applyHpNumbers();
    setTimeout(applyCluttersIfEnabled, 500);
    if (qolcInstances.length > 1 && qolcInstances[0] === QOLC_INSTANCE) {
      setTimeout(() => qolcToast('Lumi’s Extras is installed twice. Keep the ' +
        'browser extension and uninstall the Tampermonkey copy.', 'is-bad', 12000), 2500);
    } else {
      userscriptNotice();
      setTimeout(updateCheck, 4000);
      setInterval(updateCheck, 5 * 60 * 1000);
    }
    // The DOM side, on a timer rather than the frame hook: it has to work on
    // the menu (where the launcher lives) and keep the party list's peers
    // expiring while the tab is in the background.
    setInterval(() => {
      const now = performance.now();
      try { screenTick(); } catch (e) { frameFailed('screen', e); }
      if (document.hidden) return;
      positionExtrasBtn();
      menuNoticeTick();
      try { if (partyActive()) partyListTick(now); } catch (e) { frameFailed('party list', e); }
    }, 250);
    // The Settings pane's connection line, live while it is open.
    setInterval(() => {
      if (!extras || extras.panel.style.display !== 'block' || extras.current !== 'settings') return;
      syncTroubleshootingUI();
    }, 1000);
    dbg('panel ready');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady, {once: true});
  } else {
    onReady();
  }
})();
