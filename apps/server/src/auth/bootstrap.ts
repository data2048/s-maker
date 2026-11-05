import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config';
import type { Db } from '../db';
import { inviteLink } from './routes';
import { audit, invites, users } from './store';

/**
 * First start: while there are no users, print a one-time link that creates the admin account.
 * Every restart without users replaces the previous link (tokens are stored only as hashes).
 * Returns the link (for tests) or null when nothing was done.
 */
export function bootstrapAdmin(db: Db, config: Config, log: FastifyBaseLogger): string | null {
  if (users.count(db) > 0) return null;
  if (!config.adminUsername) {
    log.warn('No users yet and ADMIN_USERNAME is not set: nobody can log in. Set it in .env and restart.');
    return null;
  }
  invites.revokeBootstrap(db);
  const { token, id } = invites.create(db, {
    role: 'admin',
    username: config.adminUsername,
    expiresInHours: 24,
  });
  audit.log(db, 'bootstrap.admin_invite', { details: { inviteId: id, username: config.adminUsername } });
  const link = inviteLink(config.publicUrl, token);
  // deploy.sh greps for this exact prefix.
  log.warn(`ADMIN SETUP LINK: ${link}`);
  return link;
}
