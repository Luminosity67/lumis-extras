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

## Licence

MIT.
