# s-maker

Make music with [Strudel](https://strudel.cc): import MIDI files and turn them into Strudel code,
compose with an LLM agent, and share songs with a small group of friends (chat + wall).

Status: in development. Songs, MIDI import and the agent work; sharing, chat and the wall are next.
See [docs/PLAN.md](docs/PLAN.md) for the roadmap.

## What it does

- **Player and editor:** Strudel in a sandbox, with a mixer, version history and copies of songs.
- **MIDI import:** faithful (note for note) or essence (sections and loops), with a filled-in Music Brief.
- **Agent:** commands for a track or section, a chat at the song, composing from a description or the
  14 musical elements, and explanations as `.md` files. You listen to every change before it is saved.
- **Cost control:** weekly limits per person and for the group, and a spending overview for the admin.

## Development

Requirements: Node.js **24.7+** (uses the built-in `node:sqlite` and `crypto.argon2`).

```bash
npm install
npm run dev        # server on :44566, web on http://localhost:5173 (proxies /api to the server)
```

Useful scripts:

| Command                           | What it does                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `npm test`                        | unit and API tests (Vitest)                                                                 |
| `npm run test:e2e`                | browser tests of the built app (Playwright, uses installed Edge; run `npm run build` first) |
| `npm run typecheck`               | TypeScript checks for all packages                                                          |
| `npm run lint` / `npm run format` | ESLint / Prettier                                                                           |
| `npm run build`                   | production build of web + server                                                            |
| `npm start`                       | run the built server (serves the web app too)                                               |
| `npm run eval-models -- <models>` | compare models on real tasks, in the real player (costs money; run `npm run build` first)   |

Local configuration goes into `.env` in the repo root (see [.env.example](.env.example)).
The agent needs `OPENROUTER_API_KEY`; tests use a fake model and need no key.

### Layout

```
apps/server     Fastify API, database, agent
apps/web        React app
packages/shared code used by both: types, schemas, music logic
kb              what the agent knows about Strudel; every example is run by a test
scripts         model comparison, knowledge base builder
deploy.sh       one-command deploy to a server with Docker
```

## Security of song code

Songs are JavaScript, so they only run in a sandboxed iframe that cannot reach your session or the app.
See [docs/sandbox.md](docs/sandbox.md).

## Deploying

On the server (Docker, git and curl installed, user in the `docker` group):

```bash
curl -fsSLO https://raw.githubusercontent.com/data2048/s-maker/main/deploy.sh
bash deploy.sh            # first run creates ~/s-maker/.env from the template, then stops
nano ~/s-maker/.env       # fill in PUBLIC_URL, ADMIN_USERNAME, OPENROUTER_API_KEY, ...
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
