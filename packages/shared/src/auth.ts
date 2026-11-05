import { z } from 'zod';
import { COMMON_PASSWORDS } from './common-passwords';

export const ROLES = ['admin', 'user'] as const;
export type Role = (typeof ROLES)[number];

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Username must have at least 3 characters')
  .max(32, 'Username can have at most 32 characters')
  .regex(/^[a-z0-9_.-]+$/i, 'Use only letters, digits, dot, dash and underscore');

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Display name is required')
  .max(48, 'Display name can have at most 48 characters')
  // No control characters (they can break layouts and logs).
  .regex(/^[^\p{Cc}]+$/u, 'Display name contains invalid characters');

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, `Password must have at least ${PASSWORD_MIN} characters`)
  .max(PASSWORD_MAX, `Password can have at most ${PASSWORD_MAX} characters`)
  .refine((p) => !COMMON_PASSWORDS.has(p.toLowerCase()), 'This password is too common');

/** Password rules that need the username (checked after the schema). */
export function passwordProblem(password: string, username: string): string | null {
  const parsed = passwordSchema.safeParse(password);
  if (!parsed.success) return parsed.error.issues[0]?.message ?? 'Invalid password';
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    return 'Password must not contain your username';
  }
  return null;
}

export const loginRequestSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(PASSWORD_MAX),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const acceptInviteRequestSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  password: passwordSchema,
});
export type AcceptInviteRequest = z.infer<typeof acceptInviteRequestSchema>;

export const updateProfileRequestSchema = z.object({
  displayName: displayNameSchema,
});

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX),
  newPassword: passwordSchema,
});

export const createInviteRequestSchema = z.object({
  role: z.enum(ROLES).default('user'),
  note: z.string().trim().max(100).optional(),
  expiresInHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 14)
    .default(72),
});
export type CreateInviteRequest = z.input<typeof createInviteRequestSchema>;

export const updateUserRequestSchema = z
  .object({
    active: z.boolean().optional(),
    role: z.enum(ROLES).optional(),
  })
  .refine((v) => v.active !== undefined || v.role !== undefined, 'Nothing to update');

export interface UserDto {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  active: boolean;
  createdAt: string;
}

export interface MeResponse {
  user: UserDto;
  csrfToken: string;
}

export interface InviteInfoResponse {
  valid: boolean;
  role?: Role;
  /** Set when the invite is for a fixed username (the first admin). */
  username?: string;
}

export interface InviteDto {
  id: number;
  role: Role;
  username: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedBy: string | null;
  status: 'pending' | 'used' | 'expired' | 'revoked';
}

export interface CreateInviteResponse {
  invite: InviteDto;
  /** Shown once: the token is stored only as a hash. */
  link: string;
}

export interface AuditEntryDto {
  id: number;
  at: string;
  action: string;
  actor: string | null;
  ip: string | null;
  details: Record<string, unknown> | null;
}

/** Header that carries the CSRF token on state-changing requests. */
export const CSRF_HEADER = 'x-csrf-token';
