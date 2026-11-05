import { SANDBOX_PATH } from '@s-maker/shared';
import type { FastifyReply } from 'fastify';

export { SANDBOX_PATH };

/** Hosts the Strudel player loads samples and soundfonts from. */
export const SOUND_HOSTS = [
  'https://raw.githubusercontent.com',
  'https://felixroos.github.io',
  'https://cdn.freesound.org',
  'https://shabda.ndre.gr',
];

/**
 * Security headers of the Strudel player page (sandbox.html).
 *
 * - `sandbox allow-scripts`: even when someone opens /sandbox.html directly (not in our iframe), the
 *   browser gives it an opaque origin, so song code can never reach the app's cookies or API.
 * - 'unsafe-eval' is needed only here: Strudel compiles songs with Function(). The main app page
 *   keeps a strict CSP without it.
 * - frame-ancestors 'self': only our own app may embed the player.
 */
export const SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:",
  "worker-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' data: blob: ${SOUND_HOSTS.join(' ')}`,
  `media-src 'self' data: blob: ${SOUND_HOSTS.join(' ')}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-scripts',
].join('; ');

export function applySandboxHeaders(reply: FastifyReply): void {
  reply.header('Content-Security-Policy', SANDBOX_CSP);
  // frame-ancestors replaces X-Frame-Options; keep only one source of truth.
  reply.removeHeader('X-Frame-Options');
  reply.header('Cache-Control', 'no-cache');
  reply.header('Access-Control-Allow-Origin', '*');
}
