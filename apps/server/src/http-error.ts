import type { z } from 'zod';

/** Error with an HTTP status; messages of 4xx errors are shown to the client. */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (msg = 'Bad Request') => new HttpError(400, msg);
export const unauthorized = (msg = 'Not logged in') => new HttpError(401, msg);
export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg);
export const notFound = (msg = 'Not Found') => new HttpError(404, msg);
export const conflict = (msg = 'Conflict') => new HttpError(409, msg);
export const tooManyRequests = (msg = 'Too many attempts, try again later') => new HttpError(429, msg);

/** Validates untrusted input; throws 400 with the first problem. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length ? `${issue.path.join('.')}: ` : '';
    throw badRequest(`${where}${issue?.message ?? 'Invalid input'}`);
  }
  return result.data;
}
