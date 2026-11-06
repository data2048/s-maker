# Security

## Reporting

Please report vulnerabilities privately via GitHub's "Report a vulnerability" (Security tab)
instead of opening a public issue.

## Design notes

s-maker is built against the OWASP Top 10. The main rules:

- **Strudel code is untrusted JavaScript.** Songs shared by other users and code produced by the LLM
  agent only run inside a sandboxed iframe without `allow-same-origin`, so they cannot read cookies,
  call the API as the user, or touch the app page. The server never executes song code.
- **Model output is untrusted.** Code from the agent must pass the AST validator on the server, then a trial
  in the sandboxed player, and the user accepts it after listening. Explanations are rendered through
  DOMPurify with a short allowlist: no images, scripts, styles or event handlers. Text from songs and files is
  marked as data in prompts, and the agent's spending has weekly limits.
- **Access control is enforced on the server** for every resource (owner, visibility, role); deny by default.
- **Authentication:** invite-only accounts, argon2id password hashes, random session ids stored as hashes,
  `HttpOnly` + `Secure` + `SameSite` cookies, CSRF protection, rate limiting on login.
- **Input:** every request body is validated with zod; SQL uses parameterized statements only;
  anything rendered as HTML is sanitized first.
- **Secrets** live only in the server's `.env` (never in the repo); logs redact cookies and auth headers.
- **Container:** non-root user, read-only filesystem except `/data`, all capabilities dropped.
- **Dependencies:** lockfile + `npm ci`, `npm audit` in CI, Dependabot.
