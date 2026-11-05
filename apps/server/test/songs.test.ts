import type { SongDto, SongSummaryDto, VersionDto, VersionSummaryDto } from '@s-maker/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, createTestApp, createUser, setupAdmin, type Client } from './helpers';

let app: FastifyInstance;
let alice: Client;
let bob: Client;

beforeEach(async () => {
  ({ app } = await createTestApp());
  alice = await setupAdmin(app);
  bob = await createUser(app, alice, 'bob');
});
afterEach(async () => {
  await app.close();
});

async function newSong(client: Client, body: Record<string, unknown> = {}): Promise<SongDto> {
  const res = await call(app, client, 'POST', '/api/songs', { title: 'My tune', ...body });
  expect(res.statusCode).toBe(201);
  return res.json() as SongDto;
}

async function save(client: Client, song: SongDto | { id: number }, baseVersionId: number, code: string) {
  return call(app, client, 'POST', `/api/songs/${song.id}/versions`, {
    code,
    baseVersionId,
    message: 'edit',
  });
}

describe('songs', () => {
  it('creates a song with a first version from the template', async () => {
    const song = await newSong(alice);
    expect(song).toMatchObject({ title: 'My tune', visibility: 'group', versionCount: 1, canEdit: true });
    expect(song.currentVersion.number).toBe(1);
    expect(song.currentVersion.code).toContain('drums:');
    expect(song.owner.username).toBe('admin');
  });

  it('validates input', async () => {
    expect((await call(app, alice, 'POST', '/api/songs', { title: '' })).statusCode).toBe(400);
    expect(
      (await call(app, alice, 'POST', '/api/songs', { title: 'x', visibility: 'public' })).statusCode,
    ).toBe(400);
    expect(
      (await call(app, alice, 'POST', '/api/songs', { title: 'x', code: 'a'.repeat(200_001) })).statusCode,
    ).toBe(400);
  });

  it('requires login', async () => {
    expect((await call(app, null, 'GET', '/api/songs')).statusCode).toBe(401);
    expect((await call(app, null, 'GET', '/api/songs/1')).statusCode).toBe(401);
    expect((await call(app, null, 'POST', '/api/songs', { title: 'x' })).statusCode).toBe(401);
  });

  it('lists mine and the group separately', async () => {
    await newSong(alice, { title: 'A public' });
    await newSong(alice, { title: 'A private', visibility: 'private' });
    await newSong(bob, { title: 'B public' });

    const mine = (await call(app, alice, 'GET', '/api/songs?scope=mine')).json().songs as SongSummaryDto[];
    expect(mine.map((s) => s.title).sort()).toEqual(['A private', 'A public']);
    const bobsView = (await call(app, bob, 'GET', '/api/songs?scope=group')).json().songs as SongSummaryDto[];
    expect(bobsView.map((s) => s.title)).toEqual(['A public']);
  });
});

describe('access control', () => {
  it('private songs are invisible to others (404, not 403)', async () => {
    const song = await newSong(alice, { visibility: 'private' });
    for (const url of [`/api/songs/${song.id}`, `/api/songs/${song.id}/versions`]) {
      expect((await call(app, bob, 'GET', url)).statusCode).toBe(404);
    }
    const vUrl = `/api/songs/${song.id}/versions/${song.currentVersion.id}`;
    expect((await call(app, bob, 'GET', vUrl)).statusCode).toBe(404);
    expect((await call(app, bob, 'POST', `/api/songs/${song.id}/fork`, {})).statusCode).toBe(404);
  });

  it('group songs are readable but only the owner can change them', async () => {
    const song = await newSong(alice);
    const view = await call(app, bob, 'GET', `/api/songs/${song.id}`);
    expect(view.statusCode).toBe(200);
    expect(view.json().canEdit).toBe(false);

    expect((await save(bob, song, song.currentVersion.id, 'x')).statusCode).toBe(403);
    expect((await call(app, bob, 'PATCH', `/api/songs/${song.id}`, { title: 'pwned' })).statusCode).toBe(403);
    expect((await call(app, bob, 'DELETE', `/api/songs/${song.id}`)).statusCode).toBe(403);
    const restore = `/api/songs/${song.id}/versions/${song.currentVersion.id}/restore`;
    expect((await call(app, bob, 'POST', restore)).statusCode).toBe(403);
  });

  it('a version id from another song is not accepted', async () => {
    const a = await newSong(alice);
    const b = await newSong(bob, { visibility: 'private' });
    const res = await call(app, alice, 'GET', `/api/songs/${a.id}/versions/${b.currentVersion.id}`);
    expect(res.statusCode).toBe(404);
  });
});

describe('versions', () => {
  it('saves new versions and keeps history', async () => {
    const song = await newSong(alice);
    const v2 = (await save(alice, song, song.currentVersion.id, 'drums: s("bd")')).json() as VersionDto;
    expect(v2.number).toBe(2);
    const v3 = (await save(alice, song, v2.id, 'drums: s("bd sd")')).json() as VersionDto;
    expect(v3.number).toBe(3);

    const list = (await call(app, alice, 'GET', `/api/songs/${song.id}/versions`)).json()
      .versions as VersionSummaryDto[];
    expect(list.map((v) => v.number)).toEqual([3, 2, 1]);
    expect(list[0]).not.toHaveProperty('code');

    const current = (await call(app, alice, 'GET', `/api/songs/${song.id}`)).json() as SongDto;
    expect(current.currentVersion.code).toBe('drums: s("bd sd")');
  });

  it('refuses to overwrite a newer version (409)', async () => {
    const song = await newSong(alice);
    expect((await save(alice, song, song.currentVersion.id, 'one')).statusCode).toBe(201);
    // Second tab still based on v1:
    expect((await save(alice, song, song.currentVersion.id, 'two')).statusCode).toBe(409);
  });

  it('restore adds a new version with the old code', async () => {
    const song = await newSong(alice);
    const original = song.currentVersion.code;
    await save(alice, song, song.currentVersion.id, 'changed');
    const res = await call(
      app,
      alice,
      'POST',
      `/api/songs/${song.id}/versions/${song.currentVersion.id}/restore`,
    );
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ number: 3, code: original, message: 'Restored v1' });
  });
});

describe('fork', () => {
  it('copies a friend’s song into a new song I own', async () => {
    const song = await newSong(alice, { title: 'Groove' });
    await save(alice, song, song.currentVersion.id, 'drums: s("bd*4")');
    const res = await call(app, bob, 'POST', `/api/songs/${song.id}/fork`, {});
    expect(res.statusCode).toBe(201);
    const copy = res.json() as SongDto;
    expect(copy).toMatchObject({ title: 'Groove (variant)', canEdit: true, versionCount: 1 });
    expect(copy.owner.username).toBe('bob');
    expect(copy.currentVersion.code).toBe('drums: s("bd*4")');
    expect(copy.forkedFrom).toEqual({ songId: song.id, title: 'Groove' });
  });

  it('can fork an older version', async () => {
    const song = await newSong(alice);
    const v1 = song.currentVersion;
    await save(alice, song, v1.id, 'newer');
    const copy = (
      await call(app, alice, 'POST', `/api/songs/${song.id}/fork`, { versionId: v1.id })
    ).json() as SongDto;
    expect(copy.currentVersion.code).toBe(v1.code);
  });

  it('hides the title of a private source once it is not visible', async () => {
    const song = await newSong(alice, { title: 'Secret' });
    const copy = (await call(app, bob, 'POST', `/api/songs/${song.id}/fork`, {})).json() as SongDto;
    await call(app, alice, 'PATCH', `/api/songs/${song.id}`, { visibility: 'private' });
    const view = (await call(app, bob, 'GET', `/api/songs/${copy.id}`)).json() as SongDto;
    expect(view.forkedFrom).toEqual({ songId: song.id, title: null });
  });
});

describe('delete', () => {
  it('owner can delete; the song and its versions are gone', async () => {
    const song = await newSong(alice);
    expect((await call(app, alice, 'DELETE', `/api/songs/${song.id}`)).statusCode).toBe(200);
    expect((await call(app, alice, 'GET', `/api/songs/${song.id}`)).statusCode).toBe(404);
    expect(app.db.prepare('SELECT COUNT(*) n FROM song_versions').get()!.n).toBe(0);
  });
});
