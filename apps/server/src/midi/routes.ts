import {
  analyzeMidi,
  briefFromMidi,
  convertEssence,
  cleanMidiFileName,
  convertFaithful,
  MAX_MIDI_BYTES,
  MidiError,
  midiConvertOptionsSchema,
  midiImportRequestSchema,
  parseMidi,
  validateStrudelCode,
  type MidiFile,
  type MidiConvertResponse,
  type MidiImportResponse,
  type MidiUploadDto,
} from '@s-maker/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requireUser } from '../auth/plugin';
import { audit } from '../auth/store';
import { badRequest, HttpError, notFound, parse } from '../http-error';
import { songs } from '../songs/store';
import { midiUploads } from './store';

const idParams = z.object({ id: z.coerce.number().int().positive() });
const uploadQuery = z.object({ name: z.string().max(300).default('upload.mid') });

const MIDI_TYPES = [
  'audio/midi',
  'audio/mid',
  'audio/x-midi',
  'application/x-midi',
  'application/octet-stream',
];

/** The form is always part of the brief, also for faithful imports. */
function formFor(
  file: MidiFile,
  options: z.output<typeof midiConvertOptionsSchema>,
  result: MidiConvertResponse,
) {
  return result.form ?? convertEssence(file, options).form;
}

function convert(request: FastifyRequest, id: number, body: unknown) {
  const user = currentUser(request);
  const upload = midiUploads.get(request.server.db, user.id, id);
  const data = midiUploads.data(request.server.db, user.id, id);
  if (!upload || !data) throw notFound('MIDI file not found');
  const options = parse(midiConvertOptionsSchema, body);
  try {
    const file = parseMidi(data);
    const settings = { ...options, fileName: upload.fileName };
    const raw = options.mode === 'essence' ? convertEssence(file, settings) : convertFaithful(file, settings);
    const result: MidiConvertResponse = { ...raw, mode: options.mode };
    // The generated code contains no user text except sanitized names, but check it like agent code anyway.
    const check = validateStrudelCode(result.code, 'strict');
    if (!check.ok) {
      request.log.error({ issues: check.issues }, 'MIDI conversion produced invalid code');
      throw new HttpError(500, 'Conversion failed');
    }
    return { upload, user, result, file, options };
  } catch (e) {
    if (e instanceof MidiError) throw badRequest(e.message);
    throw e;
  }
}

export async function midiRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;
  app.addHook('preHandler', requireUser);

  // Raw file upload (no multipart): the body is the .mid file itself. Only in this plugin's scope.
  app.addContentTypeParser(MIDI_TYPES, { parseAs: 'buffer', bodyLimit: MAX_MIDI_BYTES }, (_req, body, done) =>
    done(null, body),
  );

  app.get('/api/midi', async (request): Promise<{ uploads: MidiUploadDto[] }> => {
    return { uploads: midiUploads.list(db, currentUser(request).id) };
  });

  app.post(
    '/api/midi',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } }, bodyLimit: MAX_MIDI_BYTES },
    async (request, reply): Promise<MidiUploadDto> => {
      const user = currentUser(request);
      if (!Buffer.isBuffer(request.body)) throw badRequest('Send the .mid file as the request body');
      const { name } = parse(uploadQuery, request.query);
      const bytes = new Uint8Array(request.body);
      let analysis;
      try {
        analysis = analyzeMidi(parseMidi(bytes));
      } catch (e) {
        if (e instanceof MidiError) throw badRequest(e.message);
        throw badRequest('Could not read this MIDI file');
      }
      if (!analysis.noteCount) throw badRequest('This MIDI file has no notes');
      const upload = midiUploads.add(db, user.id, cleanMidiFileName(name), bytes, analysis);
      audit.log(db, 'midi.uploaded', {
        userId: user.id,
        ip: request.ip,
        details: { uploadId: upload.id, size: bytes.length },
      });
      reply.status(201);
      return upload;
    },
  );

  app.get('/api/midi/:id', async (request): Promise<MidiUploadDto> => {
    const { id } = parse(idParams, request.params);
    const upload = midiUploads.get(db, currentUser(request).id, id);
    if (!upload) throw notFound('MIDI file not found');
    return upload;
  });

  app.delete('/api/midi/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    if (!midiUploads.delete(db, currentUser(request).id, id)) throw notFound('MIDI file not found');
    return { ok: true };
  });

  /** Preview: the Strudel code for the chosen tracks and settings, nothing is saved. */
  app.post('/api/midi/:id/convert', async (request): Promise<MidiConvertResponse> => {
    const { id } = parse(idParams, request.params);
    return convert(request, id, request.body).result;
  });

  /** Creates a new song from the conversion. */
  app.post('/api/midi/:id/import', async (request, reply): Promise<MidiImportResponse> => {
    const { id } = parse(idParams, request.params);
    const body = parse(midiImportRequestSchema, request.body);
    const { upload, user, result, file, options } = convert(request, id, request.body);
    const song = songs.create(db, {
      ownerId: user.id,
      title: body.title,
      visibility: body.visibility,
      code: result.code,
      message: `Imported from ${upload.fileName}`,
      midiUploadId: upload.id,
      brief: briefFromMidi(file, {
        parts: options.parts,
        form: formFor(file, options, result),
        type: body.midiType,
      }),
    });
    audit.log(db, 'song.imported', {
      userId: user.id,
      ip: request.ip,
      details: { songId: song.id, uploadId: upload.id },
    });
    reply.status(201);
    return { song: songs.dto(db, song, user), warnings: result.warnings };
  });
}
