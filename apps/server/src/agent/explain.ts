// Explanations of a song: written by the model on request, kept with the version, visible like the song.
import {
  explainRequestSchema,
  MAX_EXPLANATION_LENGTH,
  safeFileName,
  type ExplanationLevel,
  type SongExplanationDto,
} from '@s-maker/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requireUser } from '../auth/plugin';
import { audit } from '../auth/store';
import type { Db } from '../db';
import { forbidden, notFound, parse } from '../http-error';
import { canEdit, canView, songs, versions } from '../songs/store';
import { explainMessages } from './prompt';
import { oneAtATime, parseBrief, streamEvents, textStreamer } from './routes';
import { runText } from './service';

const songParams = z.object({ id: z.coerce.number().int().positive() });
const explanationParams = songParams.extend({ explanationId: z.coerce.number().int().positive() });

interface ExplanationRow {
  id: number;
  song_id: number;
  version_id: number;
  version_number: number;
  author_id: number | null;
  author_name: string | null;
  level: ExplanationLevel;
  note: string;
  content: string;
  model: string;
  created_at: number;
}

const SELECT = `SELECT e.id, e.song_id, e.version_id, v.number AS version_number, e.author_id,
    u.display_name AS author_name, e.level, e.note, e.content, e.model, e.created_at
  FROM song_explanations e
  JOIN song_versions v ON v.id = e.version_id
  LEFT JOIN users u ON u.id = e.author_id`;

const explanations = {
  add(
    db: Db,
    e: {
      songId: number;
      versionId: number;
      authorId: number;
      level: ExplanationLevel;
      note: string;
      content: string;
      model: string;
    },
  ): ExplanationRow {
    const r = db
      .prepare(
        `INSERT INTO song_explanations (song_id, version_id, author_id, level, note, content, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.songId, e.versionId, e.authorId, e.level, e.note, e.content, e.model, Date.now());
    return explanations.get(db, e.songId, Number(r.lastInsertRowid))!;
  },

  get(db: Db, songId: number, id: number): ExplanationRow | undefined {
    return db.prepare(`${SELECT} WHERE e.id = ? AND e.song_id = ?`).get(id, songId) as unknown as
      ExplanationRow | undefined;
  },

  list(db: Db, songId: number): ExplanationRow[] {
    return db
      .prepare(`${SELECT} WHERE e.song_id = ? ORDER BY e.id DESC LIMIT 100`)
      .all(songId) as unknown as ExplanationRow[];
  },

  remove(db: Db, id: number): void {
    db.prepare('DELETE FROM song_explanations WHERE id = ?').run(id);
  },
};

/** The file: the explanation, then the code it explains. */
export function explanationMarkdown(input: {
  title: string;
  versionNumber: number;
  text: string;
  code: string;
}): string {
  const longestRun = Math.max(2, ...(input.code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  const heading = input.title.replace(/[\r\n#]+/g, ' ').trim();
  return `# ${heading} (v${input.versionNumber})

${input.text.trim()}

## Code

${fence}strudel
${input.code.trim()}
${fence}
`;
}

/** Models sometimes wrap the whole answer in a code fence. */
export function cleanExplanation(raw: string): string {
  const fenced = /^\s*```(?:markdown|md)?\s*\n([\s\S]*)\n```\s*$/.exec(raw);
  return (fenced ? fenced[1]! : raw).trim().slice(0, MAX_EXPLANATION_LENGTH);
}

export function fileNameFor(title: string, versionNumber: number, level: string): string {
  const base =
    safeFileName(title)
      .replace(/[\s.()]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'song';
  return `${base}-v${versionNumber}-${level}.md`;
}

function viewable(request: FastifyRequest, id: number) {
  const user = currentUser(request);
  const song = songs.byId(request.server.db, id);
  if (!song || !canView(song, user)) throw notFound('Song not found');
  return { song, user };
}

export async function explainRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;
  app.addHook('preHandler', requireUser);

  const dto = (
    r: ExplanationRow,
    user: ReturnType<typeof currentUser>,
    mayDelete: boolean,
  ): SongExplanationDto => ({
    id: r.id,
    songId: r.song_id,
    versionId: r.version_id,
    versionNumber: r.version_number,
    level: r.level,
    note: r.note,
    content: r.content,
    author: r.author_id === null ? null : { id: r.author_id, displayName: r.author_name ?? '' },
    model: r.model,
    at: new Date(r.created_at).toISOString(),
    canDelete: mayDelete || r.author_id === user.id,
  });

  app.get('/api/songs/:id/explanations', async (request) => {
    const { id } = parse(songParams, request.params);
    const { song, user } = viewable(request, id);
    const mayDelete = canEdit(song, user);
    return { explanations: explanations.list(db, song.id).map((r) => dto(r, user, mayDelete)) };
  });

  /** Anyone who can see a song can have it explained, paying from their own limit. */
  app.post(
    '/api/songs/:id/explanations',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = parse(songParams, request.params);
      const { song, user } = viewable(request, id);
      const body = parse(explainRequestSchema, request.body);
      const version = versions.get(db, song.id, body.versionId ?? song.current_version_id);
      if (!version) throw notFound('Version not found');
      const mayDelete = canEdit(song, user);
      return streamEvents(request, reply, (send, signal) =>
        oneAtATime(user.id, async () => {
          send({ type: 'status', text: 'The agent is writing…' });
          const result = await runText(
            { app, userId: user.id, songId: song.id, purpose: 'explain' },
            {
              request: `Explain, level ${body.level}${body.note ? `: ${body.note}` : ''}`,
              inputCode: version.code,
              tier: body.tier,
              messages: explainMessages({
                code: version.code,
                brief: parseBrief(song.brief),
                level: body.level,
                note: body.note,
              }),
              onText: textStreamer(send),
              signal,
            },
          );
          const row = explanations.add(db, {
            songId: song.id,
            versionId: version.id,
            authorId: user.id,
            level: body.level,
            note: body.note,
            content: explanationMarkdown({
              title: song.title,
              versionNumber: version.number,
              text: cleanExplanation(result.content),
              code: version.code,
            }),
            model: result.model,
          });
          audit.log(db, 'song.explained', {
            userId: user.id,
            ip: request.ip,
            details: { songId: song.id, explanationId: row.id },
          });
          send({ type: 'done', explanation: dto(row, user, mayDelete) });
        }),
      );
    },
  );

  app.get('/api/songs/:id/explanations/:explanationId/download', async (request, reply) => {
    const { id, explanationId } = parse(explanationParams, request.params);
    const { song } = viewable(request, id);
    const row = explanations.get(db, song.id, explanationId);
    if (!row) throw notFound('Explanation not found');
    const name = fileNameFor(song.title, row.version_number, row.level);
    return reply
      .type('text/markdown; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .send(row.content);
  });

  app.delete('/api/songs/:id/explanations/:explanationId', async (request) => {
    const { id, explanationId } = parse(explanationParams, request.params);
    const { song, user } = viewable(request, id);
    const row = explanations.get(db, song.id, explanationId);
    if (!row) throw notFound('Explanation not found');
    if (row.author_id !== user.id && !canEdit(song, user))
      throw forbidden('Only its author or the song owner can delete this');
    explanations.remove(db, row.id);
    return { ok: true };
  });
}
