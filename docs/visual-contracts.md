# Visual ownership and release checks

Release 1.0.21 replaces three recurring sources of visual regressions. These
contracts apply to every nickname, animal species, arena theme and renderer.
Do not add rules for particular names or raise a scene-child ceiling to fix a
new report.

## Name colours

- Style only game-owned animal name nodes, or the leaderboard's dedicated name
  cells. Own colour belongs to `game.player.name` and the leaderboard's main row.
  Neither matching letters nor camera distance identifies the local player.
- A name-keyed retained registry record is not proof that a player uses the mod.
  Remote colouring requires a valid share suffix. The registry can refresh the
  colour only after that condition is met. Duplicate names use their own suffix.
- Gradient clones are marked and excluded from discovery. Clean up partial clone
  creation, preserve the game's original tint/renderability, and revoke styling
  on recycled nodes before the next render, even between discovery passes.
- If capture is unavailable, only a positively recognised animal nameplate may
  use its own share suffix. Do not guess which player is self.

This deliberately changes name-only registry behaviour. A full-length name with
no room for a share suffix keeps its local colour, but must be shortened to share
with this release. The UI explains this; names are never silently shortened.
Older clients still use their older matching rules until they update.

## Arena themes

- Read `game.player.arena.container` and that model's `base`/`walls` directly.
  No HP entry or prior discovery pass is required. No child-count ceiling is
  allowed, including on the shape-based fallback.
- Distinguish a known absent player/arena from a missing or unfamiliar field.
  Unknown shapes may use the fallback; an explicit absence ends the effect.
- If the known arena is rebuilding or has no measurable geometry, wait for it.
  Never replace it with a nearby arena that happens to contain the camera.
- Check both scene parent and render-layer ownership before reusing the sky.
  Repair lost attachments, destroyed nodes and replaced floor layers. Failed
  placement must remove partial layer entries.

## Draw order

- Resolve self from `game.player.container` without an HP lock. Enumerate animal
  models for their layers, including full-health animals.
- Move self into a dedicated RenderLayer immediately above/below the relevant
  animal layers. Never reorder other animals' draw lists. Compare ranks only
  within the same scene parent; layer names and species are irrelevant.
- Reconcile on every native render, outside paced HP/discovery work. Only change
  an attachment or layer index when necessary.
- Track the native layer whenever the game moves the animal; call its
  `updateLayer()` on restoration so dive/fly/arena transitions are respected.
  Clean up on disable, respawn, death and scene replacement. Roll back a failed
  attachment rather than leaving an animal in two lists or no list.
- Missing authoritative identity leaves this optional override waiting, with a
  reason in `__lumiZOrderDebug()`, rather than moving a guessed player.

## Release procedure

Run `node scripts/check.cjs` before committing. It compiles the whole userscript
and discovers **all** `tests/*.test.cjs`; GitHub Actions runs the same command on
every push and pull request. Keep both version literals in sync and retain the
embedded stylesheet backtick check.

For a reported recurrence, first add a failing behavioural reproduction against
the preceding release, then fix it. Tests execute extracted production functions
and check outcomes; do not copy the implementation into test expectations.
`LUMI_TEST_SOURCE` can select a preceding userscript for a negative control.

When changing the game adapter, verify the constructors in the current public
client and test unknown, absent and replaced objects separately. The fixtures for
this release follow `BrhD8Ove.js`, retrieved 2026-09-08, SHA-256
`a31ffbbd14ee1b0b2684fe666859c4830fc5e1f3e62892bd755658ffc22905a7`.
Its animal class owns a Map of models, each with a container, name, arenaWins and
HUD. Its arena owns base, walls, two player labels, timer and message. Pixi's
RenderLayer has a separate `renderLayerChildren` array; attach to the same layer
is a no-op.

Validation for 1.0.21 also loaded the complete userscript in Chrome, exercised
the game's actual Pixi classes for all three themes and attachment recovery,
and checked rendered WebGPU pixels for above/below ordering. No page errors.
This is not a live multiplayer duel test; future mope client API changes still
require review. Diagnostics remain available through `__lumiArenaDebug()`,
`__lumiZOrderDebug()` and `__lumiPerfDebug().featureErrors`.
