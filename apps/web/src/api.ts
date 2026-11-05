import { CSRF_HEADER } from '@s-maker/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;

/** Set after login / on app start from /api/auth/me. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export async function api<T>(method: Method, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers[CSRF_HEADER] = csrfToken;

  const res = await fetch(url, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}

/** Uploads a file as the raw request body (no multipart), e.g. a .mid file. */
export async function uploadFile<T>(url: string, file: File, contentType: string): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': contentType };
  if (csrfToken) headers[CSRF_HEADER] = csrfToken;
  const res = await fetch(url, { method: 'POST', headers, credentials: 'same-origin', body: file });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    const msg = res.status === 413 ? 'The file is too large (max 2 MB)' : data.error;
    throw new ApiError(res.status, msg ?? `Upload failed (${res.status})`);
  }
  return data as T;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

/** Only allow redirects to our own paths (prevents open redirects via ?next=). */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  return next;
}
