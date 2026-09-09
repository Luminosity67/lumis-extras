# Lumi's Extras

A quality-of-life and cosmetic userscript for [mope.io](https://mope.io).

Ability cooldown timers, HP damage numbers, a camera zoom, turn-speed feel,
a night sky behind 1v1 duels, an encrypted party map with a party list and
party chat, clutter controls, a rearrangeable HUD, and solid or gradient
player-name colours.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Click **[lumis-extras.user.js](../../raw/main/lumis-extras.user.js)**.
3. Tampermonkey will open an install page. Click **Install**.

Updates are automatic from then on — Tampermonkey checks this repository and
pulls new versions as they are published.

> Install from the link above, not by pasting the file into Tampermonkey's
> editor. A pasted script is a local copy and will never update.

## Using it

Open the panel with the teal meteor button on the main menu, or press **N**
while in game. Everything is configured there.

## Privacy

Two features open network connections. **Both are off by default and neither
turns itself on.**

- **Party map / party chat** — shares your position, health and messages with
  the people who have your party code.
- **Online colour registry** — shares your chosen name colour so other users
  of this script see it on you.

Both send their data through **public MQTT brokers** (HiveMQ, EMQX,
Mosquitto). These are third-party servers that anyone can connect to, so the
payloads are encrypted with AES-GCM under a key derived from your party code
(party) or your name (registry). Topic names are hashed rather than sent in
the clear. The brokers can see that traffic exists and how large it is; they
cannot read it.

Nothing is sent anywhere else, there is no analytics or telemetry, and no
data leaves your machine while both features are off. Your settings are
stored locally in your own browser.

The source is one file and it is all here — if you would rather check than
take the above on trust, that is the point of publishing it.

## Reporting a problem

Open an [issue](../../issues). Useful things to include: the version shown in
the panel, your browser, and whether you have any other mope.io scripts or
extensions installed.

## Development

Run `node scripts/check.cjs` before releasing. The same regression suite runs in
GitHub Actions on every push and pull request. See
[visual ownership contracts](docs/visual-contracts.md) for the arena, name-colour
and draw-order guarantees, compatibility changes and validation procedure.
See [party health correction](docs/party-health.md) for the 1.0.22 fix and its
sender-to-receiver regression coverage. Every party member needs the update
because each client publishes its own HP.

If party chat works but minimap dots are missing, run
`__lumiCaptureDebug()` and `__lumiPartyDebug()` in the browser console.
`renderersHooked: 0` together with `stageSeen: false` means the script missed
the game renderer, even if party messages are arriving. Version 1.0.20 adds
recovery from the running game loop and keeps the party list updating while
that recovery is pending. This can be triggered by startup timing without a
userscript update; it does not mean your party code or relay changed.

## Regression checks

With Node.js 24 installed, run:

```sh
node --check lumis-extras.user.js
node --test tests/renderer-recovery.test.cjs
```

GitHub Actions runs these checks on pushes and pull requests. Tests execute
the userscript's actual capture/render functions with isolated game fixtures,
including missed startup, late injection, renderer replacement, native bind
behavior, and party-list updates without a renderer. They do not connect to
public relays or replace checking the result in a live game.

## Licence

MIT.
