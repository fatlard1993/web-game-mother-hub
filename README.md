# web-game-mother-hub

One page for the house's web games: which are running, and a switch to turn each on or off, update it, reset it, or open it to the internet for a game night with people outside the house.

Games run on the htpc. Opening one to the internet carries it out through the VPS: an SSH tunnel from the htpc, and Caddy on the VPS facing the internet. Closing it takes the tunnel down, and nothing of the game is reachable from outside.

## Who can do what

Anyone on the LAN finds the games without logging in: each one's card, whether it's up, who's playing, a **Play** link, its About page, and, while it's open to the internet, its public address to share. Running them takes the admin password (the **Admin** button): turning them on and off, restarting, updating, resetting, opening them to the internet, their settings and logs, adding and forgetting games, and choosing covers. The server enforces it: a player's view of a game carries no folders, save files, git state or command output, and every change asks for the admin.

## Setup

The hub lives on the htpc beside the games, and [dotfiles](https://github.com/fatlard1993/dotfiles)' `htpc` profile sets it up with the rest: `profiles/htpc/dot-update.d/mother-hub` clones it to `~/Projects/web-game-mother-hub` and runs it as `bun-server@web-game-mother-hub`, the template unit the games run as, and `lan-names` serves it at `https://hub.home`. Its settings come from the environment, in `~/.config/web-game-mother-hub.env`, which priv-config keeps:

| Variable | Flag | Default |  |
| --- | --- | --- | --- |
| `MOTHER_HUB_PASSWORD` | `--password` | printed once on first run | every device logs in once |
| `MOTHER_HUB_VPS_HOST` | `--vps-host` |  | the VPS as ssh knows it, a `Host` in `~/.ssh/config` |
| `MOTHER_HUB_PUBLIC_HOST` | `--public-host` |  | the VPS's address as players type it |
| `MOTHER_HUB_LAN_NAMES` | `--lan-names` | `~/.config/lan-names.urls` | each service's LAN address, as `lan-names` writes it |
| `MOTHER_HUB_PORT` | `--port` | `8036` | where the page is served |
| `MOTHER_HUB_TOKEN` |  |  | what paude hosts games with, as a bearer token |
| `MOTHER_HUB_LAN_NAMES_DIR` |  |  | where a hosted game's `name=port` goes, to be named |
| `MOTHER_HUB_LAN_NAMES_REFRESH` |  |  | the command that makes those names |
| `MOTHER_HUB_PUBLIC_PORT_BASE` | `--public-port-base` | `9100` | exposed games are on the ports after it |
| `MOTHER_HUB_TUNNEL_PORT_BASE` | `--tunnel-port-base` | `19100` | their tunnels listen on the VPS's loopback after it |
| `MOTHER_HUB_UPDATE_AT` | `--update-at` | `04:00` | when, each night, the games set to update themselves are |
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
- **Auto-update**, a switch on each game with an upstream, has the game update itself each night (at 04:00, `MOTHER_HUB_UPDATE_AT`) when something new has landed there, but never under anyone: a game with players connected is tried again an hour later, and its card says it's waiting. An update that fails isn't tried again until something newer lands upstream, so one bad commit doesn't fail every night. The hub also fetches every game a minute after it starts, so each card's **Update** says how many commits are waiting without asking. A game with nothing upstream (an arcade game shelved from the folder it's built in) has **Rebuild** instead, and no switch.
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

## Hosting for paude

paude's arcade hosts its games here: wired to a hub (its `arcade.hub`, a URL and this hub's token), or, given none, running a copy of the hub of its own. Either way it's the same API:

- `POST /api/host` with `{ name, dir, head }`. When the hub sees the game's repo in its projects folder at that commit (paude on the same machine), it hosts it there. Otherwise it answers `{ needsBundle: true }`.
- `POST /api/host/<name>/bundle` with the repo as a git bundle (`git bundle create - HEAD --branches`) for the body. The first time it's cloned into the projects folder; after that, each new bundle is brought forward on top (fast-forward only). That way a game built in a local repo, with no remote to pull from, can be hosted from any machine.

paude does this on its own: when a game is made, about ten minutes after each spell of building on it, and for any arcade game not hosted yet when paude starts. Its hosting asks the hub to wait for an idle game (`whenIdle`): a game with players connected gets its new code but not the rebuild and restart, which wait for the night's round once they've gone.

Hosting installs and builds the game, starts it (or restarts it), and, on a machine that names its services, gives it its LAN name: a `name=port` file in `MOTHER_HUB_LAN_NAMES_DIR`, then `MOTHER_HUB_LAN_NAMES_REFRESH` run to make it a name (on the htpc, dotfiles' `lan-names`). Hosting the same game again brings it up to date. The request takes `Authorization: Bearer <MOTHER_HUB_TOKEN>`, a shared secret, so keep it as close as the password.

On a machine without dotfiles' `bun-server@` template unit, the hub installs its own, of the same shape, the first time it starts a game.

A game made with web-game-framework's `new-game` starts with its face already: its title, its description as the README's opening and in its manifest, and a color of its own. paude's arcade passes the game's title and idea, and its rules have Claude keep the README's opening saying what the game is as it grows.

## Opening a game to the internet

Each exposed game gets a slot, and keeps it, so its address is the same every game night: slot 1 is `https://<public-host>:9101`, and so on. **Open to the internet** starts an SSH reverse tunnel from the htpc to `127.0.0.1:1910N` on the VPS, as a systemd unit of its own that reconnects when the connection drops. **Close**, turning the game off, or **Close everything to the internet** in the toolbar takes it down.

The VPS is set up by dotfiles' `vps` profile: its `dot-update.d/caddy` gives each slot a site on its public port, proxying to the tunnel's loopback port, and answering "This game isn't open right now" while there's no tunnel, with the same short-lived IP certificate as paude there, and opens the ports in its firewall. Nothing on the VPS changes when a game opens or closes. The htpc's user needs to `ssh vps` without a password, as priv-config's keys and ssh config give it: the tunnels run with `BatchMode`, so a prompt is a failure, and the card says the VPS can't be reached.

A hub running on the VPS itself (paude's own copy there) is given `MOTHER_HUB_VPS_HOST=local`: its "tunnels" are then forwards on the VPS's own loopback, to the same Caddy ports, with no ssh.

The tunnels listen on the VPS's loopback only, so a game is reachable from outside through Caddy and nothing else.

## Development

```sh
bun run dev     # rebuilds the page on change; type b to rebuild, stop to quit
bun test
bun run lint
```
