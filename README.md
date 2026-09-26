# Lumi's Extras

A quality-of-life and cosmetic userscript for [mope.io](https://mope.io).

Ability cooldown timers, HP damage numbers, a camera zoom, turn-speed feel,
a night sky behind 1v1 duels, an encrypted party map with a party list and
party chat, clutter controls, and solid or gradient player-name colours.

## Install

Lumi's Extras is a **browser extension** for Chrome, Vivaldi, Edge, Brave and
other Chromium browsers.

It used to be a Tampermonkey userscript, and the same file still works that
way, but the extension is the version to use. Chrome starts an extension's
script before any of mope's own code runs, and every hook this script depends
on (the game, the camera, the renderer) has to be in place while mope is
building them. Tampermonkey can't guarantee that timing, and when it ran late
those hooks missed. That timing is behind most of the long-running "mis-hook"
bugs.

### From the Chrome Web Store

Coming soon.

### Loading it yourself (developer mode)

1. Download the latest `lumis-extras-<version>.zip` from
   [Releases](../../releases) and unzip it. A clone of this repository works
   too.
2. Open `chrome://extensions` (in Vivaldi, `vivaldi://extensions`) and turn on
   **Developer mode**.
3. Click **Load unpacked** and pick the folder that contains `manifest.json`.
4. Reload mope.io.

A developer-mode install does not update itself, but it tells you on the menu
when a newer version is out. To update, replace the folder
contents with a newer release, then click the reload arrow on the extension's
card.

### Moving over from Tampermonkey

Install the extension, then **uninstall the Tampermonkey copy**. Your settings
carry over, because both keep them in the same place in your browser.

If both are installed, the Tampermonkey copy steps aside whenever the extension
is already running. If the userscript happens to load first, the game shows a
warning telling you to remove it.

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

**Update check (extension only).** Once a day the extension downloads this
repository's `manifest.json` from GitHub to see whether a newer version is out.
That request carries nothing about you. GitHub sees it the way it sees any page
visit. It is on by default and can be switched off in Settings →
Troubleshooting. A Tampermonkey copy never checks, because Tampermonkey updates
it on its own.

Nothing else is sent anywhere, and there is no analytics or telemetry. With
the party, the registry and the update check all off, no data leaves your
machine. Your settings, and the hook record in Settings → Troubleshooting, are
stored locally in your own browser.

The source is one file and it is all here — if you would rather check than
take the above on trust, that is the point of publishing it.

## Reporting a problem

Open an [issue](../../issues). Useful things to include: the version shown in
the panel, your browser, and whether you have any other mope.io scripts or
extensions installed.

## Development

The extension is `manifest.json`, `lumis-extras.user.js` and `icons/`, and
nothing else. There is no build step: the manifest runs the userscript file
as-is, in the page (`"world": "MAIN"`) at `document_start`. The version lives in
three places (the manifest, the `@version` line and the fallback literal
`VERSION` returns), and the checks fail if they disagree. To release, bump all
three and push a tag `v<version>`. The *Extension package* workflow then builds
the store zip and attaches it to a GitHub release.

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
