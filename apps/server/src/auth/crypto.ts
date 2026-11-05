import { argon2, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const argon2Async = promisify(argon2);

// OWASP Password Storage Cheat Sheet: argon2id, m=19 MiB, t=2, p=1.
const PARAMS = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 } as const;

const b64 = (buf: Buffer) => buf.toString('base64').replace(/=+$/, '');

/** Returns a PHC-formatted argon2id hash: $argon2id$v=19$m=..,t=..,p=..$salt$hash */
export async function hashPassword(password: string): Promise<string> {
  const nonce = randomBytes(16);
  const hash = await argon2Async('argon2id', { message: password, nonce, ...PARAMS });
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${b64(nonce)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(phc);
  if (!m) return false;
  const [, memory, passes, parallelism, salt, expected] = m;
  const expectedBuf = Buffer.from(expected!, 'base64');
  const actual = await argon2Async('argon2id', {
    message: password,
    nonce: Buffer.from(salt!, 'base64'),
    memory: Number(memory),
    passes: Number(passes),
    parallelism: Number(parallelism),
    tagLength: expectedBuf.length,
  });
  return actual.length === expectedBuf.length && timingSafeEqual(actual, expectedBuf);
}

/** A hash used to keep login timing equal when the username does not exist. */
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}

/** 256-bit random token, URL safe. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens (sessions, invites) are stored only as SHA-256 hashes: a database leak does not leak logins. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
