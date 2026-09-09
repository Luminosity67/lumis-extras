# Party health correction — 1.0.22

The reported mismatch was 13 above a party member in mope and 100% in Lumi's
party list. A sender with native HP numbers disabled could produce this:
mope draws a fixed 30-unit fill rectangle and changes its local `scale.x` to
`health.value / 100`. Lumi read the original graphics width, yielding 30/30
and therefore 100%. The receiving player's HP-number setting cannot repair
the value that another client already sent.

## Result

- `partySelfHealth()` reads the current `game.player.target.health`, the
  server percentage used by mope's own numeric label. It follows damage and
  healing without waiting for bar animation, HP discovery or a visible HUD.
- Death, a destroyed player and invalid server values return unknown. The
  player reference is read again on every call, including after respawn.
- When the native model field is unavailable, the script reads the visual
  bar afresh instead of publishing old `raw` or `settled` damage samples.
- Graphics-context and geometry widths include each sibling's local scale.
  Pixi's `width` fallback is already scaled and is not multiplied again.
- The existing encrypted message format and 100ms minimum send interval are
  preserved. The local self row and outgoing HP use the same reader.
- `__lumiPartyDebug().selfHealthWhy` reports the server value and published
  value when the native source is available.

The native contract was checked in the saved mope client `BrhD8Ove.js` fetched
on 2026-09-08: `initHealthBar`, `renderHealthRect`, `renderHealthBar`, and animal
`synchronize`. The server health is a uint8; the fill uses an interpolated
value, while the game's numeric label uses `target.health`.

## Verification

Run `node scripts/check.cjs`. Tests execute the actual userscript functions.
The new suite reproduces 100 instead of 13 against 1.0.21, then verifies the
corrected context/geometry paths, bounds-only compatibility, disabled HP
numbers, hidden HUDs, damage/healing, zero health, death/respawn, unknown
values and the sender-to-receiver party path with a stationary player.
The network boundary is simulated; no live multiplayer match was tested.

## Installation

Each party member must install 1.0.22 and reload mope, since their client
publishes their own health. The protocol remains compatible with older
versions, but older senders can still transmit incorrect HP.

For a live check, disable mope's native HP numbers on the sending client,
take damage while stationary, then heal. The receiving list should track
the sender's current server percentage. Enabling native HP numbers again
should show the same percentage, allowing for relay/network delay.
