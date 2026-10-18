# Naija Life shared-world server (Stage 2)

One world for everybody: **one clock, one weather, one set of pedestrians, every player in the same Lagos and Sapele, chat**, with the server checking movement speed and Lagos walls.

## Be clear about what this is
| Done on the server | Still done on each player's phone |
|---|---|
| World clock and weather | Money, items, shops, jobs, properties |
| 28 shared pedestrians (walk around, avoid buildings) | Fights, shooting, damage |
| Player list, positions, names, interest range (320 m) | Car and helicopter/tank physics |
| Speed-hack and wall-walk rejection (Lagos), teleport rate limit | Traffic cars (still per player) |
| Chat (nearby 70 m, or whole world), length and rate limits, flood kick | Story NPCs and interiors |
| One login per account, player cap, per-address cap, optional origin allow-list | |
| Last position remembered per player (data/players.json) | Save game (still your Supabase cloud save) |

So this suits **friends and small groups**. A public game needs "Stage 3": moving money, combat and vehicles to the server so players cannot cheat them. Pedestrians are shared but are ghosts for now (you cannot hit them online), and sleeping does not skip time while connected.

## Security
- **No secret keys.** The server verifies a player's Supabase login by calling `/auth/v1/user` with the player's own token and the PUBLIC anon key. Never put a `service_role` key here or in the game.
- Guests are allowed by default (`ALLOW_GUESTS=1`). Set `ALLOW_GUESTS=0` so only signed-in players can join.
- Set `ALLOWED_ORIGINS` to your game's address(es) so other websites cannot connect.
- Use `wss://` (TLS) in production. Hosts like Fly.io and Railway give you TLS automatically.

## Run it on your computer
```
cd naija-server
npm install
node server.js            # listens on :8787
```
Then in the game: phone > **World** > address `ws://127.0.0.1:8787` > Connect. (`ws://` only works for localhost; an https page needs `wss://`.)

Settings (environment variables): `PORT`, `MAX_PLAYERS` (40), `MAX_PER_IP` (5), `CITIZENS` (28), `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ALLOW_GUESTS`, `ALLOWED_ORIGINS` (comma list), `SAVE_FILE`.

## Put it online (you choose the host; I have not deployed anything)
It is a normal Node.js app with one open port, so any of these work:
- **Fly.io / Railway / Render**: create an app from this folder, set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ALLOWED_ORIGINS`, and keep ONE instance (the world lives in memory). Use a small persistent volume for `data/players.json` or accept that remembered positions reset on redeploy.
- **A VPS**: `npm install`, run with `pm2` or systemd, put Caddy or nginx in front for `wss://`.
Cost: a small instance (256 to 512 MB) is enough for tens of players.

Then add to your game's `config.js`: `worldUrl: "wss://your-server.example"` (and players can still type another address in the World app).

## Tests
`node tests/server_test.js` runs 25 checks with real WebSocket clients (join, clock, citizens, speed/wall rejection, teleport limit, chat scopes and sanitising, flood kick, one-session-per-account, persistence, token verification against a local Supabase stub, guests blocked, origin and per-address caps).
The game side is tested by `naija5/tests/world_test.py` (two real browser pages against this server).
NOT tested: a real internet deployment, real Supabase tokens, more than a handful of simultaneous players, phones.

`data/lagos_nav.json` is the Lagos wall layout exported from the game (re-export if Lagos buildings change). Sapele has no wall checks yet, only speed checks.

## One-command deploy files (added; NOT run by me)
`Dockerfile` (works anywhere), `fly.toml` (Fly.io), `render.yaml` (Render).
Fly.io: `fly launch --no-deploy --copy-config`, `fly volumes create naija_data --size 1`, `fly secrets set SUPABASE_URL=https://uzjcpvaqsfflgxrpxvmx.supabase.co SUPABASE_ANON_KEY=<public key> ALLOWED_ORIGINS=https://<your-test-site>`, `fly deploy`. Your server address is `wss://<app>.fly.dev`.
Railway: New Project > Deploy from folder/repo (it uses the Dockerfile), set the same variables, add a volume at /data.
Check it is up: open `https://<host>/` or connect with the game's World app.
