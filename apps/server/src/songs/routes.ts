import {
  createSongRequestSchema,
  forkSongRequestSchema,
  NEW_SONG_CODE,
  saveVersionRequestSchema,
  updateSongRequestSchema,
  type SongDto,
  type SongSummaryDto,
  type VersionDto,
  type VersionSummaryDto,
} from '@s-maker/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requireUser } from '../auth/plugin';
import { audit, type UserRow } from '../auth/store';
import { conflict, forbidden, notFound, parse } from '../http-error';
import { canEdit, canView, songs, versions, type SongRow } from './store';

const songParams = z.object({ id: z.coerce.number().int().positive() });
const versionParams = songParams.extend({ versionId: z.coerce.number().int().positive() });
const listQuery = z.object({ scope: z.enum(['mine', 'group']).default('mine') });

/** Loads a song the user may see. Songs the user may not see answer 404 (do not reveal they exist). */
function viewableSong(request: FastifyRequest, id: number): { song: SongRow; user: UserRow } {
  const user = currentUser(request);
  const song = songs.byId(request.server.db, id);
  if (!song || !canView(song, user)) throw notFound('Song not found');
  return { song, user };
}

function editableSong(request: FastifyRequest, id: number): { song: SongRow; user: UserRow } {
  const found = viewableSong(request, id);
  if (!canEdit(found.song, found.user)) throw forbidden('Only the owner can change this song');
  return found;
}

export async function songRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;
  app.addHook('preHandler', requireUser);

  app.get('/api/songs', async (request): Promise<{ songs: SongSummaryDto[] }> => {
    const user = currentUser(request);
    const { scope } = parse(listQuery, request.query);
    return { songs: scope === 'mine' ? songs.listMine(db, user) : songs.listGroup(db, user) };
  });

  app.post('/api/songs', async (request, reply): Promise<SongDto> => {
    const user = currentUser(request);
    const body = parse(createSongRequestSchema, request.body);
    const song = songs.create(db, {
      ownerId: user.id,
      title: body.title,
      visibility: body.visibility,
      code: body.code ?? NEW_SONG_CODE,
    });
    audit.log(db, 'song.created', { userId: user.id, ip: request.ip, details: { songId: song.id } });
    reply.status(201);
    return songs.dto(db, song, user);
  });

  app.get('/api/songs/:id', async (request): Promise<SongDto> => {
    const { id } = parse(songParams, request.params);
    const { song, user } = viewableSong(request, id);
    return songs.dto(db, song, user);
  });

  app.patch('/api/songs/:id', async (request): Promise<SongDto> => {
    const { id } = parse(songParams, request.params);
    const { song, user } = editableSong(request, id);
    songs.update(db, id, parse(updateSongRequestSchema, request.body));
    return songs.dto(db, songs.byId(db, song.id)!, user);
  });

  app.delete('/api/songs/:id', async (request) => {
    const { id } = parse(songParams, request.params);
    const { user } = editableSong(request, id);
    songs.delete(db, id);
    audit.log(db, 'song.deleted', { userId: user.id, ip: request.ip, details: { songId: id } });
    return { ok: true };
  });

  // ---------- versions ----------

  app.get('/api/songs/:id/versions', async (request): Promise<{ versions: VersionSummaryDto[] }> => {
    const { id } = parse(songParams, request.params);
    viewableSong(request, id);
    return { versions: versions.list(db, id) };
  });

  app.get('/api/songs/:id/versions/:versionId', async (request): Promise<VersionDto> => {
    const { id, versionId } = parse(versionParams, request.params);
    viewableSong(request, id);
    const v = versions.get(db, id, versionId);
    if (!v) throw notFound('Version not found');
    return v;
  });

  app.post('/api/songs/:id/versions', async (request, reply): Promise<VersionDto> => {
    const { id } = parse(songParams, request.params);
    const { user } = editableSong(request, id);
    const body = parse(saveVersionRequestSchema, request.body);
    const v = versions.add(db, id, {
      baseVersionId: body.baseVersionId,
      authorId: user.id,
      authorKind: 'user',
      message: body.message || null,
      code: body.code,
    });
    if (!v)
      throw conflict('This song was saved somewhere else in the meantime. Reload to see the latest version.');
    reply.status(201);
    return v;
  });

  /** Restoring never deletes history: it adds a new version with the old code. */
  app.post('/api/songs/:id/versions/:versionId/restore', async (request, reply): Promise<VersionDto> => {
    const { id, versionId } = parse(versionParams, request.params);
    const { song, user } = editableSong(request, id);
    const old = versions.get(db, id, versionId);
    if (!old) throw notFound('Version not found');
    const v = versions.add(db, id, {
      baseVersionId: song.current_version_id,
      authorId: user.id,
      authorKind: 'user',
      message: `Restored v${old.number}`,
      code: old.code,
    });
    if (!v) throw conflict('This song changed in the meantime. Try again.');
    reply.status(201);
    return v;
  });

  /** Copy a song (yours or a friend's) into a new song you own, e.g. to try a variant. */
  app.post('/api/songs/:id/fork', async (request, reply): Promise<SongDto> => {
    const { id } = parse(songParams, request.params);
    const { song, user } = viewableSong(request, id);
    const body = parse(forkSongRequestSchema, request.body ?? {});
    const source = versions.get(db, id, body.versionId ?? song.current_version_id);
    if (!source) throw notFound('Version not found');
    const copy = songs.create(db, {
      ownerId: user.id,
      title: body.title ?? `${song.title} (variant)`.slice(0, 100),
      // A copy of a private song stays private.
      visibility: song.visibility,
      code: source.code,
      message: `Forked from "${song.title}" v${source.number}`,
      forkedFromSongId: song.id,
      forkedFromVersionId: source.id,
    });
    audit.log(db, 'song.forked', {
      userId: user.id,
      ip: request.ip,
      details: { from: song.id, to: copy.id },
    });
    reply.status(201);
    return songs.dto(db, copy, user);
  });
}
