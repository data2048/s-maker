# s-maker

Make music with [Strudel](https://strudel.cc): import MIDI files and turn them into Strudel code,
compose with an LLM agent, and share songs with a small group of friends (chat + wall).

Status: early development. See [docs/PLAN.md](docs/PLAN.md) for the roadmap.

## Development

Requirements: Node.js **24.7+** (uses the built-in `node:sqlite` and `crypto.argon2`).

```bash
npm install
npm run dev        # server on :44566, web on http://localhost:5173 (proxies /api to the server)
```

Useful scripts:

| Command                           | What it does                                  |
| --------------------------------- | --------------------------------------------- |
| `npm test`                        | unit and API tests (Vitest)                   |
| `npm run typecheck`               | TypeScript checks for all packages            |
| `npm run lint` / `npm run format` | ESLint / Prettier                             |
| `npm run build`                   | production build of web + server              |
| `npm start`                       | run the built server (serves the web app too) |

Local configuration goes into `.env` in the repo root (see [.env.example](.env.example)).

### Layout

```
apps/server     Fastify API, database, agent (later)
apps/web        React app
packages/shared code used by both: types, schemas, music logic
deploy.sh       one-command deploy to a server with Docker
```

## Deploying

On the server (Docker, git and curl installed, user in the `docker` group):

```bash
curl -fsSLO https://raw.githubusercontent.com/data2048/s-maker/main/deploy.sh
bash deploy.sh            # first run creates ~/s-maker/.env from the template, then stops
nano ~/s-maker/.env       # fill in PUBLIC_URL, ADMIN_USERNAME, ...
bash deploy.sh            # builds and starts the app on port 44566
```

Later deploys: `bash ~/s-maker/repo/deploy.sh [branch]`. The script backs up the data volume, swaps
the container, waits for `/health` and rolls back automatically if the new version fails.
Point your reverse proxy (HTTPS) at `BIND_ADDRESS:44566`.

**First start:** there are no accounts yet. The app prints a one-time `ADMIN SETUP LINK` (deploy.sh shows it,
or run `docker logs s-maker | grep "ADMIN SETUP"`). Open it to create the admin account (username from
`ADMIN_USERNAME`), then invite friends from **Admin → Invites**. The link is valid for 24 h; restarting the
container while no account exists prints a new one.

## License

[AGPL-3.0-or-later](LICENSE), like Strudel itself. If you host a modified version for others,
you must offer them its source code.
