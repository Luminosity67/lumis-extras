# How Lumi's Extras reaches the game (1.1.0 and later)

## The short version

mope.io's client is a Vite build: one entry module and a handful of chunks
that import from each other. The game chunk is imported by the UI chunk, so it
**exports** what the UI needs, and that includes:

| Export (recognised by shape) | What it is |
|---|---|
| object with `camera`, `network`, `settings`, `loop` | the game singleton `$` (`$.player` is your animal while you play) |
| class with its **own** static `dynamicList` Map, plus `list`, `create`, `get` | the base Entity class; `Entity.list` is every entity the client knows |
| class whose prototype **declares** `isUsingAbility1` and `setOutlineColor` | the base Animal class |
| object whose `mouse` entry has `comfortZones` and `subspeciesEnum` | the animal config table |
| `{cooldowns, hasAbility1, animalBiome, equippedItemId}` | the HUD store (ability cooldowns) |
| `{oxygen, resource, xp, coins}` | the stats store |
| `{currentScreen, showSettings}` | the UI store (`menu`, `HUD`, `spectating`, `banned`) |

A module is evaluated once per page and `import(url)` with a URL already in the
page's module map returns **that** instance. So the script, running in the page
(the extension's `MAIN` world, or a userscript under `@grant none`), imports
mope's modules after mope has loaded them and gets the live game. This is in
`bridge` near the top of `lumis-extras.user.js`.

There is no timing race (the import can happen at any point), nothing is
patched to find the game, and no file name is written down: the module URLs are
read from the page's `<script type="module">` and `<link rel="modulepreload">`
tags on every load.

## Why not the modpacks' way

Nova and angelwings swap mope's game chunk for an edited copy that puts `$` on
`window`. That copy is pinned to one mope build: every deploy leaves them
running old game code until the author ships a new copy. The bridge reads the
build that is actually running.

## When mope updates and something stops working

1. Settings → Troubleshooting → **Game connection** says what was and was not
   found. `__lumi.status()` in the console says the same, in more detail.
2. If a piece is missing, mope has renamed one of the properties a fingerprint
   checks. Load mope in a browser, `await import('<game chunk url>')`, find the
   export, and update the matching `mopeIs…` function (they are top-level so
   `tests/bridge.test.cjs` can run them). Update the fixtures in that test to
   match.
3. Feature code reads a few fields off entities: `target.health`, `tier`,
   `subspecies`, `animalConfig`, `effects.{burning,poisoned,bleeding,frozen,aloed,healing}`,
   `health.{container,wrapper,size,value}`, `name`, `arena`
   (`{container, base, walls, textPlayer1, textPlayer2, player1, player2}`),
   `diving`. If one of those is renamed, the feature that reads it goes quiet
   and `__lumi.errors()` usually names it.

## What still hooks anything

- `renderer.render` on mope's renderer instance is wrapped so features that
  draw run once per frame, right after mope draws. A watchdog re-wraps it if
  mope rebuilds the renderer.
- `Animal.prototype.update` is wrapped for turn speed.
- `Animal.prototype.setOutlineColor` is wrapped for duel colors (1.1.2): after
  mope recolours an animal, a fighter in your own 1v1 whose outline mope just
  set to the arena's cyan or yellow gets the colour picked in the panel instead.
  Afflictions (healing, poison, bleeding, frozen) still win, as in mope.
- `camera.target.zoom` gets an accessor for the shared zoom hub (revision 4;
  Moderator Extras joins it unchanged).
- The 2D canvas negative-radius guard (`arc`, `roundRect`, …) is unchanged from
  1.0.x.

## Testing in a real game

The browser pane in Claude's desktop app cannot pass mope's Turnstile check.
What worked on 2026-10-07: a second Vivaldi instance with a throwaway
`--user-data-dir`, `--load-extension=<folder>` and
`--remote-debugging-port=9333`, driven over the DevTools protocol from
PowerShell. Two windows in that instance can be two party members.
