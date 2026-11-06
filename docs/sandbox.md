# Strudel player sandbox

Songs are JavaScript. A song shared by a friend or written by the LLM agent could, if run on the app page,
read the session, call the API as the user, or change the page. So **song code never runs on the app page.**

## How it works

```
App page (https://music.example.com)              Player (sandbox.html, origin "null")
  cookies, API, React UI                            CodeMirror + Strudel + Web Audio
        │   postMessage {setCode, play, stop, check, export} ─► │
        │ ◄─  postMessage {ready, code, state, checked, exported} │
```

- The player is an `<iframe sandbox="allow-scripts">` **without** `allow-same-origin`. The browser gives it an
  opaque origin, so it cannot read cookies (`document.cookie` throws), cannot read the parent page, and
  requests it makes to `/api` carry no session.
- The server sends `/sandbox.html` with `Content-Security-Policy: ... sandbox allow-scripts`. Even when someone
  opens it directly (not in our iframe), it is still sandboxed.
- Only the player page allows `'unsafe-eval'` (Strudel compiles songs with `Function()`). The app page CSP has no
  eval and `frame-ancestors 'none'`. The player allows `frame-ancestors 'self'`.
- Network access from the player is limited by CSP to our own static files and the sample/soundfont hosts
  (`raw.githubusercontent.com`, `felixroos.github.io`, `cdn.freesound.org`, `shabda.ndre.gr`).
- Messages are validated with zod on both sides (`packages/shared/src/strudel/protocol.ts`) and accepted only
  from the expected window (`event.source`). The opaque origin forces `postMessage(..., '*')`; we only ever send
  song code and player state.
- Before saving or running code from the agent, `validateStrudelCode(code, 'strict')` rejects access to
  globals (`fetch`, `window`, `document`, ...), prototype tricks (`constructor`, `__proto__`), `this`, dynamic
  `import()` and computed property access. For user-typed code the same checks are warnings (the sandbox is the
  real boundary).

## Spike findings (PR 2)

| Question                                | Result                                                                                                                                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does Strudel run with an opaque origin? | Yes, with an in-memory `localStorage` shim (`src/sandbox/storage-shim.ts`). Reading `localStorage` throws there, and Strudel keeps editor settings in it.                                            |
| Module scripts and AudioWorklets        | Load with CORS from an opaque origin: `/assets/*` and `/sandbox.html` are served with `Access-Control-Allow-Origin: *` (public static files). In dev, Vite's `server.cors` allows the `null` origin. |
| Audio start                             | Play/Stop buttons live inside the iframe, so the user gesture happens in the frame that owns the AudioContext. The iframe also has `allow="autoplay"`.                                               |
| General MIDI sounds                     | `gm_*` soundfonts load from `felixroos.github.io`; samples from GitHub. Both allowed by the player CSP.                                                                                              |
| Verified in                             | Microsoft Edge (Chromium) via Playwright (`npm run test:e2e`).                                                                                                                                       |

Note: the Claude desktop app's built-in preview browser does not load URL-based sandboxed iframes, so the
player looks blank there. Use a normal browser.

## Plan B (not needed so far)

Serve the player from a separate subdomain (e.g. `player.music.example.com`) with `allow-same-origin`, if some
browser feature ever requires a real origin.
