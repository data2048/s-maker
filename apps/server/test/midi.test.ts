import {
  writeMidi,
  type MidiConvertResponse,
  type MidiImportResponse,
  type MidiUploadDto,
  type VersionSummaryDto,
} from '@s-maker/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_UPLOADS_PER_USER, midiUploads } from '../src/midi/store';
import { call, createTestApp, createUser, ORIGIN, setupAdmin, type Client } from './helpers';

let app: FastifyInstance;
let alice: Client;
let bob: Client;

const Q = 480;
const tune = (pitch = 60) =>
  writeMidi({
    bpm: 110,
    tracks: [
      {
        name: 'Melody',
        program: 73,
        notes: [0, 1, 2, 3].map((i) => ({ tick: i * Q, duration: Q, pitch: pitch + i * 2 })),
      },
      { name: 'Drums', channel: 9, notes: [0, 2].map((i) => ({ tick: i * Q, duration: 20, pitch: 36 })) },
    ],
  });

function upload(
  client: Client | null,
  bytes: Uint8Array,
  opts: { name?: string; type?: string; csrf?: boolean } = {},
) {
  const headers: Record<string, string> = { origin: ORIGIN, 'content-type': opts.type ?? 'audio/midi' };
  if (client) {
    headers.cookie = client.cookie;
    if (opts.csrf !== false) headers['x-csrf-token'] = client.csrf;
  }
  return app.inject({
    method: 'POST',
    url: `/api/midi?name=${encodeURIComponent(opts.name ?? 'tune.mid')}`,
    headers,
    payload: Buffer.from(bytes),
  });
}

async function uploaded(client: Client, bytes = tune(), name?: string): Promise<MidiUploadDto> {
  const res = await upload(client, bytes, { name });
  expect(res.statusCode).toBe(201);
  return res.json() as MidiUploadDto;
}

beforeEach(async () => {
  ({ app } = await createTestApp());
  alice = await setupAdmin(app);
  bob = await createUser(app, alice, 'bob');
});
afterEach(async () => {
  await app.close();
});

describe('MIDI upload', () => {
  it('stores the file and returns its analysis', async () => {
    const u = await uploaded(alice);
    expect(u.fileName).toBe('tune.mid');
    expect(u.analysis).toMatchObject({ bpm: 110, bars: 1, noteCount: 6 });
    expect(u.analysis.parts.map((p) => [p.name, p.sound])).toEqual([
      ['Melody', 'gm_flute'],
      ['Drums', 'drums'],
    ]);
    // Same file again: no duplicate.
    expect((await uploaded(alice)).id).toBe(u.id);
    const list = (await call(app, alice, 'GET', '/api/midi')).json() as { uploads: MidiUploadDto[] };
    expect(list.uploads).toHaveLength(1);
  });

  it('requires login, same origin and the CSRF token', async () => {
    expect((await upload(null, tune())).statusCode).toBe(401);
    expect((await upload(alice, tune(), { csrf: false })).statusCode).toBe(403);
    const res = await app.inject({
      method: 'POST',
      url: '/api/midi',
      headers: {
        origin: 'https://evil.example',
        cookie: alice.cookie,
        'x-csrf-token': alice.csrf,
        'content-type': 'audio/midi',
      },
      payload: Buffer.from(tune()),
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects files that are not MIDI, too large, or have no notes', async () => {
    const text = await upload(alice, new TextEncoder().encode('MThd but not really a midi file'));
    expect(text.statusCode).toBe(400);
    expect((await upload(alice, new TextEncoder().encode('<html>'))).json()).toMatchObject({
      error: 'This is not a MIDI file',
    });
    const big = new Uint8Array(2 * 1024 * 1024 + 10);
    big.set(tune());
    expect((await upload(alice, big)).statusCode).toBe(413);
    const empty = writeMidi({ tracks: [{ name: 'Nothing', notes: [] }] });
    expect((await upload(alice, empty)).json()).toMatchObject({ error: 'This MIDI file has no notes' });
    // Other content types are not accepted as uploads.
    expect((await upload(alice, tune(), { type: 'text/plain' })).statusCode).toBe(400);
  });

  it('cleans the file name', async () => {
    const u = await uploaded(alice, tune(), '../../etc/\u0000pass‮wd.mid');
    expect(u.fileName).toBe('.._.._etc_passwd.mid');
  });

  it('limits uploads per minute', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await upload(alice, tune(30 + i))).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 201)).toBe(true);
    expect(codes[20]).toBe(429);
  });

  it('keeps only the newest uploads per user', async () => {
    const u = await uploaded(alice);
    for (let i = 0; i < MAX_UPLOADS_PER_USER; i++)
      midiUploads.add(app.db, alice.userId, `f${i}.mid`, tune(70 + i), u.analysis);
    const list = (await call(app, alice, 'GET', '/api/midi')).json() as { uploads: MidiUploadDto[] };
    expect(list.uploads).toHaveLength(MAX_UPLOADS_PER_USER);
    expect(list.uploads.some((x) => x.id === u.id)).toBe(false);
  });
});

describe('MIDI conversion and import', () => {
  it('previews Strudel code for the chosen tracks', async () => {
    const u = await uploaded(alice);
    const res = await call(app, alice, 'POST', `/api/midi/${u.id}/convert`, { parts: [0], grid: 'auto' });
    expect(res.statusCode).toBe(200);
    const r = res.json() as MidiConvertResponse;
    expect(r.code).toContain('setcpm(110/4)');
    expect(r.code).toContain('melody: note("[c4 d4 e4 f#4]").s("gm_flute")');
    expect(r.code).not.toContain('drums:');
    expect(r.code.split('\n')[0]).toContain('"tune.mid"');
  });

  it('validates conversion options', async () => {
    const u = await uploaded(alice);
    const bad = [
      { parts: [] },
      { parts: [0], grid: 5 },
      { parts: [0], bars: 0 },
      { parts: [0], startBar: -1 },
      { parts: ['x'] },
    ];
    for (const body of bad)
      expect((await call(app, alice, 'POST', `/api/midi/${u.id}/convert`, body)).statusCode).toBe(400);
    const none = await call(app, alice, 'POST', `/api/midi/${u.id}/convert`, { parts: [7] });
    expect(none.json()).toMatchObject({ error: 'Choose at least one track to import' });
  });

  it('imports as a new song with the code as version 1', async () => {
    const u = await uploaded(alice);
    const res = await call(app, alice, 'POST', `/api/midi/${u.id}/import`, {
      parts: [0, 1],
      title: 'From MIDI',
      visibility: 'private',
    });
    expect(res.statusCode).toBe(201);
    const { song, warnings } = res.json() as MidiImportResponse;
    expect(warnings).toEqual([]);
    expect(song).toMatchObject({ title: 'From MIDI', visibility: 'private', canEdit: true, versionCount: 1 });
    expect(song.currentVersion.code).toContain('drums: s("bd*2").bank("RolandTR909")');
    const versions = (await call(app, alice, 'GET', `/api/songs/${song.id}/versions`)).json() as {
      versions: VersionSummaryDto[];
    };
    expect(versions.versions[0]!.message).toBe('Imported from tune.mid');

    // Deleting the upload keeps the song.
    expect((await call(app, alice, 'DELETE', `/api/midi/${u.id}`)).statusCode).toBe(200);
    expect((await call(app, alice, 'GET', `/api/songs/${song.id}`)).statusCode).toBe(200);
    expect((await call(app, alice, 'GET', `/api/midi/${u.id}`)).statusCode).toBe(404);
  });

  it('requires a title for the import', async () => {
    const u = await uploaded(alice);
    expect((await call(app, alice, 'POST', `/api/midi/${u.id}/import`, { parts: [0] })).statusCode).toBe(400);
  });

  it("other users cannot see or use someone's upload", async () => {
    const u = await uploaded(alice);
    const urls: ['GET' | 'POST' | 'DELETE', string, unknown?][] = [
      ['GET', `/api/midi/${u.id}`],
      ['POST', `/api/midi/${u.id}/convert`, { parts: [0] }],
      ['POST', `/api/midi/${u.id}/import`, { parts: [0], title: 'Stolen' }],
      ['DELETE', `/api/midi/${u.id}`],
    ];
    for (const [method, url, body] of urls) {
      expect((await call(app, bob, method, url, body)).statusCode).toBe(404);
      expect((await call(app, null, method, url, body)).statusCode).toBe(401);
    }
    const list = (await call(app, bob, 'GET', '/api/midi')).json() as { uploads: MidiUploadDto[] };
    expect(list.uploads).toEqual([]);
    // Still there for the owner.
    expect((await call(app, alice, 'GET', `/api/midi/${u.id}`)).statusCode).toBe(200);
  });
});
