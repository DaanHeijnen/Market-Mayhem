import type { Pool, PoolClient } from 'pg';
import { HttpError } from './http';
import { isRoundType, type RoundType, type RoundStatus } from './round-types';

type Queryable = Pool | PoolClient;

/**
 * Reading a round and its content.
 *
 * Each round type keeps its content in its own tables, so "load a round's content" is a
 * dispatch rather than one query. Keeping that dispatch here means the Admin snapshot, the
 * player snapshot and the projector snapshot all ask the same question and get the same
 * rows — they differ in what they are then allowed to *show*, which is dto.ts's job, not
 * this file's.
 */

export type RoundRecord = {
  id: number;
  gameNightId: number;
  sortOrder: number;
  title: string;
  description: string | null;
  type: RoundType;
  status: RoundStatus;
  instructions: string;
  defaultPoints: number;
};

function toRecord(row: any): RoundRecord {
  return {
    id: Number(row.id),
    gameNightId: Number(row.game_night_id),
    sortOrder: Number(row.sort_order),
    title: row.title,
    description: row.description ?? null,
    type: row.type,
    status: row.status,
    instructions: row.instructions ?? '',
    defaultPoints: Number(row.default_points ?? 0),
  };
}

/**
 * Load one round and lock it.
 *
 * Every admin command that changes a round takes this lock first, which is what serialises
 * two admin tabs pressing the same button: the second waits, then re-reads a status that
 * makes its command illegal.
 */
export async function lockRound(client: PoolClient, gameId: number, roundId: number): Promise<RoundRecord> {
  const { rows } = await client.query(
    `SELECT id,game_night_id,sort_order,title,description,type,status,instructions,default_points
     FROM rounds WHERE id=$1 AND game_night_id=$2 FOR UPDATE`,
    [roundId, gameId],
  );
  if (!rows[0]) throw new HttpError(404, 'Round not found');
  return toRecord(rows[0]);
}

export async function loadRound(db: Queryable, gameId: number, roundId: number): Promise<RoundRecord | null> {
  const { rows } = await db.query(
    `SELECT id,game_night_id,sort_order,title,description,type,status,instructions,default_points
     FROM rounds WHERE id=$1 AND game_night_id=$2`,
    [roundId, gameId],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/** The round the game is currently playing, if any. Progression, not presentation. */
export async function loadActiveRound(db: Queryable, gameId: number): Promise<RoundRecord | null> {
  const { rows } = await db.query(
    `SELECT id,game_night_id,sort_order,title,description,type,status,instructions,default_points
     FROM rounds WHERE game_night_id=$1 AND status='ACTIVE'`,
    [gameId],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/**
 * Assert a round is of the type a command expects.
 *
 * Endpoints are per type — there is no generic "round action" — so this is how each one
 * refuses a round id belonging to a different game form, rather than doing something
 * nonsensical with it.
 */
export function assertRoundType(round: RoundRecord, expected: RoundType) {
  if (round.type !== expected) {
    throw new HttpError(409, `This action needs a ${expected} round, but round ${round.sortOrder} is ${round.type}`);
  }
}

export function assertRoundActive(round: RoundRecord) {
  if (round.status !== 'ACTIVE') throw new HttpError(409, 'Only the active round can be played');
}

/** Structural edits stop once a round has been played. Its content is history by then. */
export function assertRoundEditable(round: RoundRecord) {
  if (round.status === 'COMPLETED') throw new HttpError(409, 'A completed round can no longer be edited');
}

export function roundTypeValue(value: unknown): RoundType {
  if (!isRoundType(value)) throw new HttpError(400, 'Unknown round type');
  return value;
}

// ---------------------------------------------------------------------------
// Content loaders, one per type
// ---------------------------------------------------------------------------

/** The per-round execution cursor. Never confuse it with what is on the projector. */
export async function loadRoundRuntime(db: Queryable, roundId: number) {
  const { rows } = await db.query(
    'SELECT round_id,current_quiz_question_id,current_slide_id,revision FROM round_runtime WHERE round_id=$1',
    [roundId],
  );
  const row = rows[0];
  return {
    currentQuizQuestionId: row?.current_quiz_question_id ? Number(row.current_quiz_question_id) : null,
    currentSlideId: row?.current_slide_id ? Number(row.current_slide_id) : null,
    revision: Number(row?.revision ?? 0),
  };
}

/**
 * Advance the round cursor, refusing a stale command.
 *
 * The caller passes the revision it based its decision on. If another admin tab has moved
 * on since, no row matches and the update applies to nothing — which the caller turns into
 * a 409 rather than silently doing the wrong thing. This is the whole optimistic-locking
 * story for round navigation.
 */
export async function advanceRoundCursor(
  client: PoolClient,
  roundId: number,
  expectedRevision: number,
  next: { quizQuestionId?: number | null; slideId?: number | null },
) {
  const sets: string[] = [];
  const params: unknown[] = [roundId, expectedRevision];
  if ('quizQuestionId' in next) {
    params.push(next.quizQuestionId ?? null);
    sets.push(`current_quiz_question_id=$${params.length}`);
  }
  if ('slideId' in next) {
    params.push(next.slideId ?? null);
    sets.push(`current_slide_id=$${params.length}`);
  }
  const { rows } = await client.query(
    `UPDATE round_runtime SET ${sets.join(',')},revision=revision+1,updated_at=NOW()
     WHERE round_id=$1 AND revision=$2
     RETURNING revision,current_quiz_question_id,current_slide_id`,
    params,
  );
  if (!rows[0]) {
    throw new HttpError(409, 'This round has moved on since — refresh and try again');
  }
  return {
    revision: Number(rows[0].revision),
    currentQuizQuestionId: rows[0].current_quiz_question_id ? Number(rows[0].current_quiz_question_id) : null,
    currentSlideId: rows[0].current_slide_id ? Number(rows[0].current_slide_id) : null,
  };
}

/** The neighbours of an item in its round's order, for previous/next navigation. */
export function neighbours<T extends { id: number }>(items: T[], currentId: number | null) {
  const index = items.findIndex(item => item.id === currentId);
  return {
    index,
    first: items[0] ?? null,
    previous: index > 0 ? items[index - 1] : null,
    next: index >= 0 && index + 1 < items.length ? items[index + 1] : null,
    current: index >= 0 ? items[index] : null,
  };
}

/**
 * Renumber a round's content to the order the host is looking at.
 *
 * Shared by the three ordered content types because the mechanism is identical and the
 * subtle part — the two passes needed to get past `UNIQUE (round_id, sort_order)` without
 * colliding with rows not yet renumbered — is worth writing once. The table name is
 * interpolated rather than bound, so callers pass a literal from this module's own list
 * and never anything from a request.
 */
const ORDERABLE_TABLES = {
  live_quiz_questions: 'live_quiz_questions',
  presentation_slides: 'presentation_slides',
  fotoronde_subjects: 'fotoronde_subjects',
} as const;

export type OrderableTable = keyof typeof ORDERABLE_TABLES;

export async function reorderRoundContent(
  client: PoolClient,
  table: OrderableTable,
  roundId: number,
  ids: number[],
) {
  const name = ORDERABLE_TABLES[table];
  if (!name) throw new HttpError(500, 'Unknown content table');

  const existing = await client.query(
    `SELECT id FROM ${name} WHERE round_id=$1 ORDER BY sort_order,id FOR UPDATE`,
    [roundId],
  );
  const known = existing.rows.map((r: any) => Number(r.id));
  // The list must name exactly this round's content. A stale list would otherwise drop
  // whatever it forgot to the end without saying so.
  if (ids.length !== known.length || !known.every(id => ids.includes(id))) {
    throw new HttpError(409, 'This round has changed since — refresh and try again');
  }

  await client.query(`UPDATE ${name} SET sort_order=sort_order+100000 WHERE round_id=$1`, [roundId]);
  for (const [index, id] of ids.entries()) {
    await client.query(`UPDATE ${name} SET sort_order=$2,updated_at=NOW() WHERE id=$1`, [id, index]);
  }
  return ids.length;
}

/**
 * Every round's content for one game, in a fixed number of queries.
 *
 * The Admin snapshot is polled for the whole evening, and this database bills compute for
 * as long as it is awake — so "one query per round" would make a ten-round evening cost
 * ten times what it needs to, forever. Five queries regardless of how many rounds there
 * are, grouped in memory.
 */
export async function loadAllRoundContent(db: Queryable, gameId: number) {
  const [questions, options, slides, subjects, slotConfigs, slotParticipants] = await Promise.all([
    db.query(
      `SELECT q.id,q.round_id,q.sort_order,q.prompt,q.body,q.points,q.time_limit_seconds,q.context_media_key,
              st.status,st.opened_at,st.closed_at,st.revealed_at,st.settled_at,st.context_photo_shown,st.revision,
              COUNT(ap.id)::int AS answer_count
       FROM live_quiz_questions q
       LEFT JOIN live_quiz_question_state st ON st.question_id=q.id
       LEFT JOIN quiz_answers a ON a.question_id=q.id
       -- Answers are counted from active players only, matching the denominator the
       -- participation bar divides by.
       LEFT JOIN players ap ON ap.id=a.player_id AND ap.active=TRUE
       WHERE q.game_night_id=$1
       GROUP BY q.id,st.status,st.opened_at,st.closed_at,st.revealed_at,st.settled_at,st.context_photo_shown,st.revision
       ORDER BY q.round_id,q.sort_order,q.id`,
      [gameId],
    ),
    db.query(
      `SELECT id,question_id,sort_order,text,is_correct FROM live_quiz_question_options
       WHERE game_night_id=$1 ORDER BY question_id,sort_order,id`,
      [gameId],
    ),
    db.query(
      `SELECT s.id,s.round_id,s.sort_order,s.title,s.body,s.media_key,s.media_kind,s.media_name,
              s.reveal_text,s.hide_title_until_reveal,s.hidden,st.revealed_at,st.revision
       FROM presentation_slides s
       LEFT JOIN presentation_slide_state st ON st.slide_id=s.id
       WHERE s.game_night_id=$1 ORDER BY s.round_id,s.sort_order,s.id`,
      [gameId],
    ),
    db.query(
      `SELECT id,round_id,sort_order,subject_key,label,points,reference_media_key
       FROM fotoronde_subjects WHERE game_night_id=$1 ORDER BY round_id,sort_order,id`,
      [gameId],
    ),
    db.query('SELECT round_id,max_spins FROM slotmachine_rounds WHERE game_night_id=$1', [gameId]),
    db.query('SELECT round_id,player_id FROM slotmachine_round_participants WHERE game_night_id=$1 ORDER BY player_id', [gameId]),
  ]);

  const group = <T,>(rows: T[], key: (row: T) => number) => {
    const map = new Map<number, T[]>();
    for (const row of rows) {
      const id = key(row);
      const list = map.get(id);
      if (list) list.push(row); else map.set(id, [row]);
    }
    return map;
  };

  const optionsByQuestion = group(options.rows, (o: any) => Number(o.question_id));
  return {
    questionsByRound: group(
      questions.rows.map((row: any) => ({ row, options: optionsByQuestion.get(Number(row.id)) || [] })),
      entry => Number(entry.row.round_id),
    ),
    slidesByRound: group(slides.rows, (s: any) => Number(s.round_id)),
    subjectsByRound: group(subjects.rows, (s: any) => Number(s.round_id)),
    slotByRound: new Map<number, { maxSpins: number; allowedPlayerIds: number[] }>(
      slotConfigs.rows.map((row: any) => [
        Number(row.round_id),
        {
          maxSpins: Number(row.max_spins),
          allowedPlayerIds: slotParticipants.rows
            .filter((p: any) => Number(p.round_id) === Number(row.round_id))
            .map((p: any) => Number(p.player_id)),
        },
      ]),
    ),
  };
}
