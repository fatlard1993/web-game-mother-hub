# web-game-mother-hub

One page for the house's web games: which are running, and a switch to turn each on or off, update it, reset it, or open it to the internet for a game night with people outside the house.

Games run on the htpc. Opening one to the internet carries it out through the VPS: an SSH tunnel from the htpc, and Caddy on the VPS facing the internet. Closing it takes the tunnel down, and nothing of the game is reachable from outside.

## Setup

The hub lives on the htpc beside the games, and [dotfiles](https://github.com/fatlard1993/dotfiles)' `htpc` profile sets it up with the rest: `profiles/htpc/dot-update.d/mother-hub` clones it to `~/Projects/web-game-mother-hub` and runs it as `bun-server@web-game-mother-hub`, the template unit the games run as, and `lan-names` serves it at `https://hub.home`. Its settings come from the environment, in `~/.config/web-game-mother-hub.env`, which priv-config keeps:

| Variable | Flag | Default |  |
| --- | --- | --- | --- |
| `MOTHER_HUB_PASSWORD` | `--password` | printed once on first run | every device logs in once |
| `MOTHER_HUB_VPS_HOST` | `--vps-host` |  | the VPS as ssh knows it, a `Host` in `~/.ssh/config` |
| `MOTHER_HUB_PUBLIC_HOST` | `--public-host` |  | the VPS's address as players type it |
| `MOTHER_HUB_LAN_NAMES` | `--lan-names` | `~/.config/lan-names.urls` | each service's LAN address, as `lan-names` writes it |
| `MOTHER_HUB_PORT` | `--port` | `8036` | where the page is served |
|  | `--database` | `~/.web-game-mother-hub.json` | the games and their settings |
|  | `--projects` | `~/Projects` | where the games are, as `bun-server@` runs them |
|  | `--slots` | `8` | how many games can be open to the internet at once |

Anywhere else, `bun install` and `bun start -- --password 'something'` run it on port 8036, given a `bun-server@` template unit like the htpc's.

## Games

The games are the ones dotfiles already runs: every `bun-server@<folder>` instance, from `dot-update.d/game-servers` (humanity, void-driller, sorcery-and-savagery, game-night) and from the arcade's `shelf-game`, is listed here as soon as the hub sees it. **Add a game** takes any other game folder in `~/Projects`. The hub turns those units on and off; how they're installed, run and named stays dotfiles'.

- **A house app** takes `--port`, and runs on its own port with nothing added. Its save file comes from its `db:clean` script, or else the default its server names.
- **A web-game-framework game** (what the arcade makes) takes `PORT`, from the `port.conf` drop-in `shelf-game` writes. The hub writes the same file, so a game's port is kept in one place. One with no port yet is given one from 4100 up.

Only a game has saves to reset: a house app that isn't one (game-night's library) has none, and a save that's a link into somewhere else (priv-config keeps the library) is never moved.

- **Turn on / Turn off** enables and starts the game's unit, or stops and disables it. dotfiles' game-servers starts a game when it first installs it, and after that leaves on and off to the hub.
- **Update** pulls (`--ff-only`), installs with `--frozen-lockfile` as dotfiles does, so `bun.lock` is never rewritten under a pull, builds, and restarts the game if it was running. An arcade game shelved from the folder it's built in has nothing to pull from, so what's there is built. When a step fails it stops there, and the game keeps running the code it had.
- **Auto-update**, a switch on each game with an upstream, has the game update itself when something new lands there. Every 15 minutes (`MOTHER_HUB_UPDATE_MINUTES`) the hub fetches every game, so each card's **Update** says how many commits are waiting without asking. Those set to update themselves are updated, but never under anyone: a game with players connected waits until they've gone, and its card says so. An update that fails isn't tried again until something newer lands upstream, so one bad commit doesn't fail every round. A game with nothing upstream (an arcade game shelved from the folder it's built in) has **Rebuild** instead, and no switch.
- **Check for updates** fetches right away, rather than at the next round.
- **Reset** stops the game, moves its save files to `~/.web-game-mother-hub-resets/<game>/<time>/`, and starts it again. Regretted, it's a folder to move back.
- **Logs** shows the game's journal, and its tunnel's for an exposed game.
- **Forget** (in a game's settings) takes it off this page and closes its tunnel; its unit is left as it is, on or off.

The light by each name says whether it's running and answering on its port, starting, crashing (with how many restarts), or running without answering. Each card links to the game at its `.home` name when `lan-names` gave it one.

## How a game shows on its card

A game says how it looks and how it's doing itself; the hub only reads it.

- **Its look** comes from its web manifest (`client/manifest.json`), as a browser reads it: `name` for the card's title, `theme_color` for the card's color, and the biggest of its `icons` for the tile. Failing those, the page's `<title>`, `<meta name="theme-color">` and icon link. A game with no color of its own gets a steady one made from its name. The title follows the manifest as it changes, unless the game is renamed in its settings here.
- **What it is** comes from its README: the first paragraph of prose under the title is the card's blurb, and the pictures it shows are the card's cover and the gallery on its **About** page (the book), each captioned by its alt text, with the whole README below. The cover is the first picture captioned "Play: ..." (how the house READMEs caption gameplay), else the first that isn't a logo; any other picture can be made the cover from the gallery. Only pictures inside the game's folder are served, and links into the repo keep their words but not their target.
- **How it looks now** is the hub's own picture: each time a game starts, restarts, updates or resets, the hub opens it in headless Chrome and keeps a picture of it, last in the gallery. A game whose README shows no pictures gets it as its cover, and **Take a picture now** on the About page takes a fresh one. Chrome is found on the PATH (`google-chrome`, `chromium`), or named by `CHROME`; without one there are no live pictures, and nothing else changes.
- **Its numbers** come from `GET /.well-known/web-game`, which every game on [web-game-framework](https://github.com/fatlard1993/web-game-framework) answers: how many have it open right now, the games going and the players in them, and its memory. A game adds numbers of its own with the Server's `status` option, `server => [{ label: 'deepest dig', value: 42 }]`, and they show on its card as they are. A game that doesn't answer it still gets its light, from any answer on its port.

## From paude's arcade

A game shelved in paude's arcade on the htpc (dotfiles' `shelf-game`, paude's `arcade.shelf`) becomes a `bun-server@` unit with a `.home` name, and so a card here, with nothing more to do.

A game made with web-game-framework's `new-game` starts with its face already: its title, its description as the README's opening and in its manifest, and a color of its own. paude's arcade passes the game's title and idea, and its rules have Claude keep the README's opening saying what the game is as it grows.

## Opening a game to the internet

Each exposed game gets a slot, and keeps it, so its address is the same every game night: slot 1 is `https://<public-host>:9101`, and so on. **Open to the internet** starts an SSH reverse tunnel from the htpc to `127.0.0.1:1910N` on the VPS, as a systemd unit of its own that reconnects when the connection drops. **Close**, turning the game off, or **Close everything to the internet** in the toolbar takes it down.

The VPS is set up by dotfiles' `vps` profile: its `dot-update.d/caddy` gives each slot a site on its public port, proxying to the tunnel's loopback port, and answering "This game isn't open right now" while there's no tunnel, with the same short-lived IP certificate as paude there, and opens the ports in its firewall. Nothing on the VPS changes when a game opens or closes. The htpc's user needs to `ssh vps` without a password, as priv-config's keys and ssh config give it: the tunnels run with `BatchMode`, so a prompt is a failure, and the card says the VPS can't be reached.

The tunnels listen on the VPS's loopback only, so a game is reachable from outside through Caddy and nothing else.

## Development

```sh
bun run dev     # rebuilds the page on change; type b to rebuild, stop to quit
bun test
bun run lint
```
