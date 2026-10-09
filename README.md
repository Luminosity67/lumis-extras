# Lumi's Extras

A quality-of-life and cosmetic userscript for [mope.io](https://mope.io).

Ability cooldown timers, HP damage numbers, a camera zoom, turn-speed feel,
a night sky behind 1v1 duels, your own outline colours in a duel, a boost
timer round your cursor, an encrypted party map with a party list and party
chat, clutter controls, and solid or gradient player-name colours.

## Install

Lumi's Extras is a **browser extension** for Chrome, Vivaldi, Edge, Brave and
other Chromium browsers.

It used to be a Tampermonkey userscript, and the same file still works that
way, but the extension is the version to use: it checks for new releases on its
own, and a Tampermonkey copy steps aside whenever the extension is running.

Since 1.1.0 the script reads mope's own game code directly (see
[how it reaches the game](docs/game-bridge.md)), so it no longer has to start
before mope does. That race is what the old "mis-hook" bugs came from, and it
is gone for both the extension and the userscript.

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

Open the panel with the gear button in the bottom-left corner of the main menu, or press **N**
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

**Update check (extension only).** Once an hour the extension downloads this
repository's `manifest.json` from GitHub to see whether a newer version is out.
That request carries nothing about you. GitHub sees it the way it sees any page
visit. It is on by default and can be switched off in Settings →
Troubleshooting. A Tampermonkey copy never checks, because Tampermonkey updates
it on its own.

Nothing else is sent anywhere, and there is no analytics or telemetry. With
the party, the registry and the update check all off, no data leaves your
machine. Your settings are stored locally in your own browser.

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

[How the script reaches the game](docs/game-bridge.md) explains the game
bridge, what each feature reads, and what to check when a mope update breaks
something.

If something in game is not appearing, Settings → Troubleshooting → **Game
connection** says whether the script found mope's game, and **Copy report**
puts the details on the clipboard. In the console, `__lumi.status()`,
`__lumi.party()`, `__lumi.health()`, `__lumi.arena()`, `__lumi.zoom()` and
`__lumi.errors()` give more.

## Regression checks

With Node.js 24 installed, run:

```sh
node scripts/check.cjs
```

That syntax-checks the script and runs every `tests/*.test.cjs`. GitHub Actions
runs the same command on pushes and pull requests. The tests run the script's
own functions against fixtures shaped like mope's classes: the bridge's
fingerprints, the shared zoom hub's contract with Moderator Extras, the
name-tag wire format, and the feature logic. They do not replace checking the
result in a live game.

## Licence

MIT.
