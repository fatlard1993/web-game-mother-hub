# web-game-mother-hub

One page for the house's web games: which are running, and a switch to turn each on or off, update it, reset it, or open it to the internet for a game night with people outside the house.

Games run on the htpc. Opening one to the internet carries it out through the VPS: an SSH tunnel from the htpc, and Caddy on the VPS facing the internet. Closing it takes the tunnel down, and nothing of the game is reachable from outside.

## Setup

Needs [Bun](https://bun.sh), on Linux with systemd (the htpc).

```sh
bun install
bun start -- --password 'something'     # http://htpc:8036
```

`bun run service:enable` runs the hub itself as a background service on port 8036, and `bun run deploy` rebuilds and restarts it. So that the games and the hub keep running with nobody logged in, and come back after a reboot, run once:

```sh
loginctl enable-linger $USER
```

| Option               | Default                       |                                                          |
| -------------------- | ----------------------------- | -------------------------------------------------------- |
| `--port`             | `8036`                        | where the page is served                                 |
| `--password`         | printed once on first run     | or `MOTHER_HUB_PASSWORD`; every device logs in once      |
| `--database`         | `~/.web-game-mother-hub.json` | the games and their settings                             |
| `--projects`         | `~/Projects`                  | where **Add a game** looks for games to offer            |
| `--vps-host`         |                               | the VPS as ssh knows it, a `Host` in `~/.ssh/config`     |
| `--public-host`      |                               | the VPS's address as players type it                     |
| `--public-port-base` | `9100`                        | exposed games are on the ports after it: 9101, 9102, ... |
| `--tunnel-port-base` | `19100`                       | each tunnel listens on the VPS's loopback, 19101, ...    |
| `--slots`            | `8`                           | how many games can be open to the internet at once       |

Give the service the VPS flags by enabling it with them: `vbc-service enable --port 8036 -- --vps-host vps --public-host 203.0.113.7`.

## Games

**Add a game** offers the folders under `--projects` that look like games, or takes any folder. Both kinds of game in the house are understood:

- **A house app** (void-driller, humanity, sorcery-and-savagery): run as `bun server/index.js --port N`. Its port comes from its `service:enable` script, and its save file from its `db:clean` script, or else the default its server names.
- **A web-game-framework game** (what paude's arcade makes): run as `bun server.js` with `PORT` set, given a port from 4100 up, saving in its `data/games.json`.

Port and save files can be changed in a game's settings (the gear).

Each game runs as a systemd user unit named for the game: the same unit its own `bun run service:enable` makes. A game already running that way is taken over rather than doubled, and forgetting it in the hub leaves that unit alone. Units keep running through the hub's own restarts.

- **Turn on / Turn off** starts the unit and keeps it starting at boot, or stops it and keeps it stopped.
- **Update** runs `git pull --ff-only`, `bun install` and the build, then restarts the game if it was running. When a step fails it stops there, and the game keeps running the code it had.
- **Check for updates** fetches, so the card shows how many commits are waiting upstream.
- **Reset** stops the game, moves its save files to `~/.web-game-mother-hub-resets/<game>/<time>/`, and starts it again. Regretted, it's a folder to move back.
- **Logs** shows the game's journal, and its tunnel's for an exposed game.

The light by each name says whether it's running and answering on its port, starting, crashing (with how many restarts), or running without answering.

## Opening a game to the internet

Each exposed game gets a slot, and keeps it, so its address is the same every game night: slot 1 is `https://<public-host>:9101`, and so on. **Open to the internet** starts an SSH reverse tunnel from the htpc to `127.0.0.1:1910N` on the VPS, as a systemd unit of its own that reconnects when the connection drops. **Close**, turning the game off, or **Close everything to the internet** in the toolbar takes it down.

The VPS needs setting up once:

1. The htpc's user can `ssh vps` without a password (a key, with `Host vps` in `~/.ssh/config`). The tunnels run with `BatchMode`, so a passphrase prompt is a failure, and the card says the VPS can't be reached.
2. Caddy on the VPS, with a site for each slot. This prints them:

   ```sh
   bun run vps:caddyfile -- --public-host 203.0.113.7 > Caddyfile
   ```

   Each public port proxies to its tunnel's loopback port, and answers "This game isn't open right now" while there's no tunnel. A bare IP is certified on Let's Encrypt's short-lived profile, and a domain name the usual way. Nothing on the VPS changes when a game opens or closes.

3. The VPS's firewall lets in 80 and 443 (for the certificates) and the public ports, 9101 to 9108.

The tunnels listen on the VPS's loopback only, so a game is reachable from outside through Caddy and nothing else.

## Development

```sh
bun run dev     # rebuilds the page on change; type b to rebuild, stop to quit
bun test
bun run lint
```
