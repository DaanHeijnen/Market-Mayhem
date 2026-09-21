import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migratedDb, pgliteAvailable, seedGame, addRound, type TestDb } from './helpers/pglite';
import { adminCookie, jsonRequest, playerCookie, readJson, sqlTag, uploadRequest, TEST_SESSION_SECRET } from './helpers/endpoint';
import {
  clampSubmissionMinutes,
  submissionWindow,
  uploadsAccepted,
  DEFAULT_SUBMISSION_MINUTES,
} from '../netlify/lib/photo-round';

/**
 * The Fotoronde submission window, end to end.
 *
 * The rules are pure and tested as such below, but the promise the host actually relies on
 * — "after the deadline the server refuses the photo" — is a property of the request path,
 * not of a function. So the endpoints are driven for real here: a signed session, a real
 * migrated database, a real multipart upload. A disabled button on a phone is not a check,
 * and a test that only checked the rule would not have noticed if the endpoint forgot to
 * ask it.
 */

const { holder } = vi.hoisted(() => ({ holder: { pool: null as any, sql: null as any } }));
vi.mock('../netlify/lib/db', () => ({
  database: () => ({ pool: holder.pool, sql: holder.sql }),
  withTransaction: async (fn: any) => fn(holder.pool),
}));
// The bytes never reach a real store in a test; what is being tested is what the handler
// does around them.
const { stored } = vi.hoisted(() => ({ stored: new Map<string, unknown>() }));
vi.mock('@netlify/blobs', () => ({
  getStore: () => ({ set: async (key: string, value: unknown) => { stored.set(key, value); } }),
}));

const photoRoundAction = (await import('../netlify/functions/photo-round-action')).default;
const uploadPhoto = (await import('../netlify/functions/upload-photo-submission')).default;
const updateFotorondeRound = (await import('../netlify/functions/update-fotoronde-round')).default;
const { loadPhotoRound } = await import('../netlify/lib/photo-round-state');
const { syncTimedState } = await import('../netlify/lib/queries');

const available = await pgliteAvailable();

// ---------------------------------------------------------------------------
// The rules, on their own
// ---------------------------------------------------------------------------

describe('when a submission window is open', () => {
  const at = (iso: string) => new Date(iso).getTime();
  const CLOSES = '2026-01-01T20:15:00.000Z';

  it('is open while the phase allows it and the clock has not run out', () => {
    expect(submissionWindow('OPEN', CLOSES, at('2026-01-01T20:05:00.000Z')))
      .toEqual({ open: true, expired: false, msRemaining: 600_000 });
  });

  it('is shut the moment the deadline arrives', () => {
    expect(submissionWindow('OPEN', CLOSES, at(CLOSES)))
      .toEqual({ open: false, expired: true, msRemaining: 0 });
  });

  it('is shut when the host closed it early, deadline or not', () => {
    expect(uploadsAccepted('CLOSED', CLOSES, at('2026-01-01T20:05:00.000Z'))).toBe(false);
    expect(uploadsAccepted('DRAFT', null)).toBe(false);
    expect(uploadsAccepted('COMPLETED', null)).toBe(false);
  });

  // A round opened before the window existed has no deadline. That must read as "no
  // deadline", never as "already past".
  it('runs open-ended when there is no deadline at all', () => {
    expect(submissionWindow('OPEN', null)).toEqual({ open: true, expired: false, msRemaining: null });
  });

  it('keeps a configured duration inside what a round can hold', () => {
    expect(clampSubmissionMinutes(15)).toBe(15);
    expect(clampSubmissionMinutes(0)).toBe(1);
    expect(clampSubmissionMinutes(9999)).toBe(240);
    expect(clampSubmissionMinutes(Number.NaN)).toBe(DEFAULT_SUBMISSION_MINUTES);
  });
});

// ---------------------------------------------------------------------------
// The endpoints, against a real database
// ---------------------------------------------------------------------------

describe.skipIf(!available)('a Fotoronde being played', () => {
  let db: TestDb;
  let gameId: number;
  let roundId: number;
  let admin: string;
  /** Two team-mates and one player on another team. */
  let jordi: number;
  let wouter: number;
  let outsider: number;
  let teamId: number;

  const SUBJECT = 'moois';

  beforeAll(async () => {
    process.env.SESSION_SECRET = TEST_SESSION_SECRET;
    db = await migratedDb();
    holder.pool = db;
    holder.sql = sqlTag(db);
    gameId = await seedGame(db, 903);
    admin = await adminCookie(db);
  });
  afterAll(async () => { await db?.close(); });

  const addPlayer = async (id: number, name: string) => {
    await db.query(
      `INSERT INTO players(id,game_night_id,display_name,public_color,active,starting_balance_snapshot)
       VALUES($1,$2,$3,'#123456',TRUE,100) ON CONFLICT (id) DO NOTHING`,
      [id, gameId, name],
    );
    await db.query('INSERT INTO wallets(game_night_id,player_id,current_balance) VALUES($1,$2,100) ON CONFLICT DO NOTHING', [gameId, id]);
    return id;
  };

  const open = (minutes?: number) => photoRoundAction(jsonRequest('/api/photo-round-action', { gameId, roundId, action: 'OPEN' }, admin))
    .then(readJson)
    .then(async result => { void minutes; return result; });

  const upload = (cookie: string, subjectKey = SUBJECT) =>
    uploadPhoto(uploadRequest('/api/upload-photo-submission', {
      gameId: String(gameId), roundId: String(roundId), subjectKey,
    }, cookie)).then(readJson);

  const load = () => loadPhotoRound(db as any, gameId, roundId, [{ key: SUBJECT, label: 'Iets moois' }]);

  const submissions = async () => (await db.query(
    'SELECT id,group_id,subject_key,uploaded_by,media_key FROM photo_submissions WHERE round_id=$1 ORDER BY id',
    [roundId],
  )).rows;

  beforeEach(async () => {
    stored.clear();
    await db.query(`UPDATE rounds SET status='COMPLETED' WHERE game_night_id=$1 AND status='ACTIVE'`, [gameId]);
    roundId = await addRound(db, gameId, 'FOTORONDE', { status: 'ACTIVE', title: 'Fotoronde' });
    await db.query('UPDATE game_nights SET current_round_id=$2 WHERE id=$1', [gameId, roundId]);
    await db.query(
      `INSERT INTO fotoronde_subjects(game_night_id,round_id,sort_order,subject_key,label,points)
       VALUES($1,$2,0,$3,'Iets moois',10)`,
      [gameId, roundId, SUBJECT],
    );
    await db.query('INSERT INTO fotoronde_rounds(round_id,game_night_id,submission_duration_minutes) VALUES($1,$2,15)', [roundId, gameId]);

    jordi = await addPlayer(601, 'Jordi');
    wouter = await addPlayer(602, 'Wouter');
    outsider = await addPlayer(603, 'Bas');
    const team = await db.query('INSERT INTO round_groups(game_night_id,round_id,name) VALUES($1,$2,$3) RETURNING id', [gameId, roundId, 'Team A']);
    teamId = Number(team.rows[0].id);
    const other = await db.query('INSERT INTO round_groups(game_night_id,round_id,name) VALUES($1,$2,$3) RETURNING id', [gameId, roundId, 'Team B']);
    for (const [group, player] of [[teamId, jordi], [teamId, wouter], [Number(other.rows[0].id), outsider]] as const) {
      await db.query(
        'INSERT INTO round_group_members(group_id,game_night_id,round_id,player_id) VALUES($1,$2,$3,$4)',
        [group, gameId, roundId, player],
      );
    }
  });

  // 1 · the duration is the host's to set
  it('lets the host set how long teams get', async () => {
    const result = await updateFotorondeRound(jsonRequest('/api/update-fotoronde-round', {
      gameId, roundId, submissionDurationMinutes: 25,
    }, admin)).then(readJson);
    expect(result.status).toBe(200);
    const { rows } = await db.query('SELECT submission_duration_minutes FROM fotoronde_rounds WHERE round_id=$1', [roundId]);
    expect(Number(rows[0].submission_duration_minutes)).toBe(25);
  });

  it('refuses a duration outside what a round can hold', async () => {
    const tooLong = await updateFotorondeRound(jsonRequest('/api/update-fotoronde-round', {
      gameId, roundId, submissionDurationMinutes: 1000,
    }, admin)).then(readJson);
    expect(tooLong.status).toBe(400);
  });

  // 2 · the clock starts on OPEN, not on START
  it('starts no clock until the host opens submissions', async () => {
    const before = await load();
    expect(before).toBeNull();

    const result = await open();
    expect(result.status).toBe(200);

    const after = await load();
    expect(after?.status).toBe('OPEN');
    expect(after?.submissionOpenedAt).toBeTruthy();
    expect(after?.submissionClosesAt).toBeTruthy();
    // 15 minutes, from the database's own clock.
    const span = new Date(after!.submissionClosesAt!).getTime() - new Date(after!.submissionOpenedAt!).getTime();
    expect(span).toBeGreaterThan(14 * 60_000);
    expect(span).toBeLessThanOrEqual(15 * 60_000 + 1000);
  });

  it('uses the duration the host configured', async () => {
    await updateFotorondeRound(jsonRequest('/api/update-fotoronde-round', { gameId, roundId, submissionDurationMinutes: 40 }, admin));
    await open();
    const after = await load();
    const span = new Date(after!.submissionClosesAt!).getTime() - new Date(after!.submissionOpenedAt!).getTime();
    expect(Math.round(span / 60_000)).toBe(40);
  });

  // 3 and 4 · what the phone counts down to survives a reload, because it is a timestamp
  it('reports the same deadline on every read', async () => {
    await open();
    const first = await load();
    const second = await load();
    expect(second!.submissionClosesAt).toEqual(first!.submissionClosesAt);
    expect(second!.submissionMsRemaining).toBeLessThanOrEqual(first!.submissionMsRemaining!);
    expect(second!.submissionMsRemaining).toBeGreaterThan(14 * 60_000);
  });

  // 7 and 11 · one photo per team per subject, and the team is the server's to decide
  it('files a photo against the uploader’s own team', async () => {
    await open();
    const result = await upload(await playerCookie(db, gameId, jordi));
    expect(result.status).toBe(200);
    expect(result.body.team).toBe('Team A');

    const rows = await submissions();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].group_id)).toBe(teamId);
    expect(Number(rows[0].uploaded_by)).toBe(jordi);
  });

  it('takes no team from the request', async () => {
    await open();
    // The outsider names another team's group in the form; the server files it under the
    // team their own session belongs to.
    const result = await uploadPhoto(uploadRequest('/api/upload-photo-submission', {
      gameId: String(gameId), roundId: String(roundId), subjectKey: SUBJECT,
      groupId: String(teamId), playerId: String(jordi),
    }, await playerCookie(db, gameId, outsider))).then(readJson);
    expect(result.status).toBe(200);
    expect(result.body.team).toBe('Team B');
  });

  // 8 and 9 · a team-mate replaces rather than adds, and is named for it
  it('replaces a team-mate’s photo rather than adding a second', async () => {
    await open();
    await upload(await playerCookie(db, gameId, jordi));
    const first = await submissions();

    await upload(await playerCookie(db, gameId, wouter));
    const after = await submissions();

    expect(after).toHaveLength(1);
    expect(Number(after[0].id)).toBe(Number(first[0].id));
    expect(Number(after[0].uploaded_by)).toBe(wouter);
    expect(after[0].media_key).not.toBe(first[0].media_key);

    const loaded = await load();
    expect(loaded!.submissions[0].uploaderName).toBe('Wouter');
  });

  // 10 · two team-mates uploading together
  it('cannot be made to hold two photos by two team-mates at once', async () => {
    await open();
    const results = await Promise.all([
      upload(await playerCookie(db, gameId, jordi)),
      upload(await playerCookie(db, gameId, wouter)),
    ]);
    // Both may succeed — the second replaces the first — but there is only ever one row,
    // and that is the database's guarantee rather than this code's promise.
    expect(results.every(r => r.status === 200 || r.status === 409)).toBe(true);
    expect(await submissions()).toHaveLength(1);
  });

  // 5 and 6 · the deadline is the server's, and it is enforced
  it('refuses an upload once the deadline has passed', async () => {
    await open();
    // The window runs out. Moving the deadline is how a test travels in time without
    // making the code depend on an injectable clock.
    await db.query(`UPDATE photo_rounds SET submission_closes_at=NOW()-INTERVAL '1 second' WHERE round_id=$1`, [roundId]);

    const result = await upload(await playerCookie(db, gameId, jordi));
    expect(result.status).toBe(409);
    expect(String(result.body.error)).toMatch(/inzendtijd/i);
    expect(await submissions()).toHaveLength(0);
  });

  it('treats the window as shut even before anything has closed the round', async () => {
    await open();
    await db.query(`UPDATE photo_rounds SET submission_closes_at=NOW()-INTERVAL '1 second' WHERE round_id=$1`, [roundId]);

    // The phase is still OPEN — nothing has swept yet — and the round already refuses.
    const { rows } = await db.query('SELECT status FROM photo_rounds WHERE round_id=$1', [roundId]);
    expect(rows[0].status).toBe('OPEN');
    const loaded = await load();
    expect(loaded!.acceptsUploads).toBe(false);
    expect(loaded!.submissionExpired).toBe(true);
  });

  it('closes an expired window by itself, without a browser asking', async () => {
    await open();
    await db.query(`UPDATE photo_rounds SET submission_closes_at=NOW()-INTERVAL '1 second' WHERE round_id=$1`, [roundId]);

    const changed = await syncTimedState(gameId);
    expect(changed).toBe(true);

    const { rows } = await db.query('SELECT status,closed_at FROM photo_rounds WHERE round_id=$1', [roundId]);
    expect(rows[0].status).toBe('CLOSED');
    expect(rows[0].closed_at).toBeTruthy();
  });

  it('sweeps nothing while the window is still running', async () => {
    await open();
    expect(await syncTimedState(gameId)).toBe(false);
    const { rows } = await db.query('SELECT status FROM photo_rounds WHERE round_id=$1', [roundId]);
    expect(rows[0].status).toBe('OPEN');
  });

  // The host is never held to their own timer
  it('lets the host close early', async () => {
    await open();
    const closed = await photoRoundAction(jsonRequest('/api/photo-round-action', { gameId, roundId, action: 'CLOSE' }, admin)).then(readJson);
    expect(closed.status).toBe(200);

    const result = await upload(await playerCookie(db, gameId, jordi));
    expect(result.status).toBe(409);
    expect(await submissions()).toHaveLength(0);
  });

  it('refuses an upload before the host has opened anything', async () => {
    const result = await upload(await playerCookie(db, gameId, jordi));
    expect(result.status).toBe(409);
    expect(await submissions()).toHaveLength(0);
  });

  it('refuses a subject this round does not ask for', async () => {
    await open();
    const result = await upload(await playerCookie(db, gameId, jordi), 'nietbestaand');
    expect(result.status).toBe(400);
  });

  it('refuses a player who is in no team', async () => {
    await open();
    const loner = await addPlayer(604, 'Loner');
    const result = await upload(await playerCookie(db, gameId, loner));
    expect(result.status).toBe(403);
  });

  it('refuses an upload with no session at all', async () => {
    await open();
    const result = await upload('');
    expect(result.status).toBe(401);
  });
});
