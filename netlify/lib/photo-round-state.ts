import type { Pool, PoolClient } from 'pg';
import { HttpError } from './http';
import {
  DEFAULT_SUBMISSION_MINUTES,
  acceptsUploads,
  describeDistribution,
  distributeCredits,
  normalizeSubjects,
  type PhotoRoundStatus,
  type PhotoSubject,
} from './photo-round';

/**
 * Database-facing Fotoronde helpers: reading a round's full state, resolving a player's
 * team, and paying out a photo's credits.
 *
 * The rules live in photo-round.ts. This file is the bridge to PostgreSQL, so the read
 * paths (queries.ts) and the write paths (the endpoints) agree on what a Fotoronde is.
 */

type Queryable = Pool | PoolClient;

export type PhotoTeam = { groupId: number; name: string; memberIds: number[]; memberNames: string[] };

export type PhotoSubmissionRow = {
  id: number;
  subjectKey: string;
  groupId: number;
  teamName: string;
  uploadedBy: number | null;
  uploaderName: string | null;
  mediaKey: string;
  creditsAwarded: number | null;
  awardedAt: string | null;
  uploadedAt: string;
  /** How those credits were split, once they were paid. */
  distribution: string;
};

export type PhotoRound = {
  id: number;
  roundId: number | null;
  status: PhotoRoundStatus;
  subjects: PhotoSubject[];
  teams: PhotoTeam[];
  submissions: PhotoSubmissionRow[];
  /** Per subject: which teams submitted, and which are still missing. */
  bySubject: Array<{
    subject: PhotoSubject;
    submissions: PhotoSubmissionRow[];
    missingTeams: string[];
    submittedCount: number;
  }>;
  /** Per team: what they have earned across the whole Fotoronde. */
  teamTotals: Array<{ groupId: number; name: string; credits: number; submitted: number; judged: number }>;
  submissionCount: number;
  judgedCount: number;
  totalCredits: number;
  acceptsUploads: boolean;
  acceptsAwards: boolean;
  /** When the host opened submissions, and when the window shuts. Null before either. */
  submissionOpenedAt: string | null;
  submissionClosesAt: string | null;
  /** Milliseconds left on the window, or null when this round has no deadline. */
  submissionMsRemaining: number | null;
  /** The deadline has passed. Distinct from CLOSED, which is the host's own decision. */
  submissionExpired: boolean;
};

/**
 * How a photo's credits were shared out, in words.
 *
 * For a judged photo this reads the amounts that were actually credited, so it stays
 * truthful after the team's membership changes. For one not yet judged it projects the
 * split across the team as it stands, which is what the Admin needs before deciding.
 */
function describeActualSplit(amounts: number[] | undefined, credits: number | null, memberCount: number) {
  if (!amounts || !amounts.length) {
    return credits == null ? describeDistribution(0, memberCount) : describeDistribution(credits, memberCount);
  }
  const high = Math.max(...amounts);
  const low = Math.min(...amounts);
  const highs = amounts.filter(a => a === high).length;
  if (high === low) return `${amounts.length} × ${high}`;
  return `${highs} × ${high} + ${amounts.length - highs} × ${low}`;
}



/**
 * How long this round gives teams to submit.
 *
 * Read from the round's own settings row, falling back to the default for a round created
 * before the setting existed — so opening always has a duration and never has to guess.
 */
export async function submissionMinutesForRound(db: Queryable, gameId: number, roundId: number) {
  const { rows } = await db.query(
    'SELECT submission_duration_minutes FROM fotoronde_rounds WHERE round_id=$1 AND game_night_id=$2',
    [roundId, gameId],
  );
  return Number(rows[0]?.submission_duration_minutes ?? DEFAULT_SUBMISSION_MINUTES);
}

/**
 * Which team a player is on for this round.
 *
 * Derived from the round's groups, never sent by the phone: a player belongs to at most
 * one group per round (`UNIQUE(round_id, player_id)`), which is exactly what makes
 * "uploading on behalf of your own team" enforceable rather than a matter of trust.
 */
export async function playerTeamForRound(db: Queryable, roundId: number, playerId: number) {
  const { rows } = await db.query(
    `SELECT g.id,g.name
     FROM round_group_members gm JOIN round_groups g ON g.id=gm.group_id
     WHERE gm.round_id=$1 AND gm.player_id=$2`,
    [roundId, playerId],
  );
  if (!rows[0]) return null;
  return { groupId: Number(rows[0].id), name: rows[0].name as string };
}

/** Load one Fotoronde with everything any surface needs. Null when the round has none. */
export async function loadPhotoRound(
  db: Queryable,
  gameId: number,
  roundId: number,
  subjects: PhotoSubject[],
): Promise<PhotoRound | null> {
  const rounds = await db.query(
    `SELECT id,round_id,status,opened_at,submission_closes_at,
            -- The window is judged against the database's clock, not this container's, so
            -- a skewed function host cannot hold a shut window open or close an open one.
            (submission_closes_at IS NOT NULL AND submission_closes_at<=NOW()) AS expired,
            GREATEST(0,EXTRACT(EPOCH FROM (submission_closes_at-NOW()))*1000)::bigint AS ms_remaining
     FROM photo_rounds WHERE game_night_id=$1 AND round_id=$2`,
    [gameId, roundId],
  );
  const row = rounds.rows[0];
  if (!row) return null;
  const id = Number(row.id);

  const [teams, submissions, paid] = await Promise.all([
    // Active members only: an inactive player is not paid, so they must not count
    // toward the split either.
    roundId
      ? db.query(
        `SELECT g.id,g.name,
                COALESCE(json_agg(json_build_object('id',p.id,'name',p.display_name)
                  ORDER BY p.display_name,p.id) FILTER (WHERE p.id IS NOT NULL),'[]') AS members
         FROM round_groups g
         LEFT JOIN round_group_members gm ON gm.group_id=g.id
         LEFT JOIN players p ON p.id=gm.player_id AND p.active=TRUE
         WHERE g.round_id=$1 GROUP BY g.id ORDER BY g.name,g.id`,
        [roundId],
      )
      : Promise.resolve({ rows: [] } as any),
    db.query(
      `SELECT s.id,s.subject_key,s.group_id,s.uploaded_by,s.media_key,s.credits_awarded,
              s.awarded_at,s.created_at,g.name AS team_name,p.display_name AS uploader_name,
              (SELECT COUNT(*)::int FROM round_group_members m
               JOIN players mp ON mp.id=m.player_id AND mp.active=TRUE
               WHERE m.group_id=s.group_id) AS member_count
       FROM photo_submissions s
       JOIN round_groups g ON g.id=s.group_id
       LEFT JOIN players p ON p.id=s.uploaded_by
       WHERE s.photo_round_id=$1
       ORDER BY g.name,g.id`,
      [id],
    ),
    // What each judged photo actually paid, per player. Read rather than recomputed: a
    // team's membership can change after an award, and the split shown for a photo has
    // to be the split that happened, not what today's team would receive.
    db.query(
      `SELECT l.photo_submission_id,l.amount
       FROM ledger_entries l
       JOIN photo_submissions s ON s.id=l.photo_submission_id
       WHERE s.photo_round_id=$1 AND l.transaction_type='PHOTO_ROUND_REWARD'
       ORDER BY l.photo_submission_id,l.amount DESC`,
      [id],
    ),
  ]);

  // submissionId -> the amounts actually credited, largest first.
  const paidBySubmission = new Map<number, number[]>();
  for (const row of paid.rows) {
    const submissionId = Number(row.photo_submission_id);
    paidBySubmission.set(submissionId, [...(paidBySubmission.get(submissionId) || []), Number(row.amount)]);
  }

  const teamRows: PhotoTeam[] = teams.rows.map((t: any) => ({
    groupId: Number(t.id),
    name: t.name,
    memberIds: (t.members || []).map((m: any) => Number(m.id)),
    memberNames: (t.members || []).map((m: any) => m.name),
  }));

  const submissionRows: PhotoSubmissionRow[] = submissions.rows.map((s: any) => ({
    id: Number(s.id),
    subjectKey: s.subject_key,
    groupId: Number(s.group_id),
    teamName: s.team_name,
    uploadedBy: s.uploaded_by == null ? null : Number(s.uploaded_by),
    uploaderName: s.uploader_name ?? null,
    mediaKey: s.media_key,
    creditsAwarded: s.credits_awarded == null ? null : Number(s.credits_awarded),
    awardedAt: s.awarded_at,
    uploadedAt: s.created_at,
    distribution: describeActualSplit(
      paidBySubmission.get(Number(s.id)),
      s.credits_awarded == null ? null : Number(s.credits_awarded),
      Number(s.member_count || 0),
    ),
  }));

  const status = row.status as PhotoRoundStatus;
  // Two reasons a window can be shut, combined here once. The phase is the host's own
  // decision; `expired` was answered by the database's clock in the query above, which is
  // why it is used rather than re-deciding from a timestamp against this container's.
  const uploadsOpen = acceptsUploads(status) && !row.expired;
  const msRemaining = row.submission_closes_at == null
    ? null
    : (row.expired ? 0 : Number(row.ms_remaining ?? 0));

  const bySubject = subjects.map(subject => {
    const forSubject = submissionRows.filter(s => s.subjectKey === subject.key);
    const submittedGroupIds = new Set(forSubject.map(s => s.groupId));
    return {
      subject,
      submissions: forSubject,
      // Named rather than counted: the Admin needs to know who is missing, not how many.
      missingTeams: teamRows.filter(t => !submittedGroupIds.has(t.groupId)).map(t => t.name),
      submittedCount: forSubject.length,
    };
  });

  const teamTotals = teamRows.map(team => {
    const own = submissionRows.filter(s => s.groupId === team.groupId);
    return {
      groupId: team.groupId,
      name: team.name,
      credits: own.reduce((sum, s) => sum + (s.creditsAwarded ?? 0), 0),
      submitted: own.length,
      judged: own.filter(s => s.creditsAwarded != null).length,
    };
  }).sort((a, b) => b.credits - a.credits || a.name.localeCompare(b.name));

  return {
    id,
    roundId,
    status,
    subjects,
    teams: teamRows,
    submissions: submissionRows,
    bySubject,
    teamTotals,
    submissionCount: submissionRows.length,
    judgedCount: submissionRows.filter(s => s.creditsAwarded != null).length,
    totalCredits: submissionRows.reduce((sum, s) => sum + (s.creditsAwarded ?? 0), 0),
    acceptsUploads: uploadsOpen,
    acceptsAwards: status === 'CLOSED' || status === 'COMPLETED',
    submissionOpenedAt: row.opened_at ?? null,
    submissionClosesAt: row.submission_closes_at ?? null,
    submissionMsRemaining: msRemaining,
    submissionExpired: Boolean(row.expired),
  };
}

/**
 * Pay a photo's credits to its team.
 *
 * The award is split across the team's **active** members by `distributeCredits`, so the
 * amounts always add back up to exactly what the Admin awarded — nothing is lost to
 * rounding and nothing is invented by it.
 *
 * Paying twice is impossible rather than guarded against: the ledger's partial unique
 * index on (photo_submission_id, player_id) means a second attempt conflicts instead of
 * crediting again, and the conflict is verified against the row that already exists
 * rather than swallowed. The caller must already hold the submission row.
 */
export async function payPhotoSubmission(
  client: PoolClient,
  gameId: number,
  submissionId: number,
  credits: number,
  actor: string,
) {
  const submission = await client.query(
    `SELECT s.id,s.group_id,s.round_id,s.subject_key,g.name AS team_name
     FROM photo_submissions s JOIN round_groups g ON g.id=s.group_id
     WHERE s.id=$1 AND s.game_night_id=$2 FOR UPDATE OF s`,
    [submissionId, gameId],
  );
  if (!submission.rows[0]) throw new HttpError(404, 'Photo submission not found');
  const row = submission.rows[0];

  // Active members only, in a stable order — that order decides who receives the extra
  // credit when the amount does not divide evenly, so it must not vary between runs.
  const members = await client.query(
    `SELECT p.id,p.display_name
     FROM round_group_members gm JOIN players p ON p.id=gm.player_id
     WHERE gm.group_id=$1 AND p.active=TRUE
     ORDER BY p.display_name,p.id
     FOR UPDATE OF p`,
    [row.group_id],
  );
  if (!members.rowCount) throw new HttpError(409, 'This team has no active players to pay');

  const memberIds = members.rows.map((m: any) => Number(m.id));
  const shares = distributeCredits(credits, memberIds);

  let paid = 0;
  for (const share of shares) {
    if (share.amount <= 0) continue;
    const wallet = await client.query(
      'SELECT current_balance FROM wallets WHERE player_id=$1 AND game_night_id=$2 FOR UPDATE',
      [share.playerId, gameId],
    );
    if (!wallet.rows[0]) throw new HttpError(409, 'A team member has no wallet to credit');

    const ledger = await client.query(
      `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,
        attributed_round_id,round_group_id,photo_submission_id,created_by,idempotency_key,metadata)
       VALUES($1,$2,$3,'PHOTO_ROUND_REWARD',$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT DO NOTHING RETURNING id`,
      [
        gameId, share.playerId, share.amount,
        `Fotoronde: ${row.team_name}`,
        row.round_id, row.group_id, submissionId, actor,
        `photo:${submissionId}:reward:${share.playerId}`,
        JSON.stringify({ subjectKey: row.subject_key, teamCredits: credits, teamName: row.team_name }),
      ],
    );

    if (ledger.rows[0]) {
      await client.query(
        'UPDATE wallets SET current_balance=current_balance+$1,updated_at=NOW() WHERE player_id=$2',
        [share.amount, share.playerId],
      );
      paid += share.amount;
    } else {
      const existing = await client.query(
        `SELECT amount FROM ledger_entries
         WHERE photo_submission_id=$1 AND player_id=$2 AND transaction_type='PHOTO_ROUND_REWARD'`,
        [submissionId, share.playerId],
      );
      if (!existing.rows[0] || Number(existing.rows[0].amount) !== share.amount) {
        throw new HttpError(409, 'Photo credits conflict with an existing transaction');
      }
    }
  }

  return { paid, shares, memberCount: memberIds.length, distribution: describeDistribution(credits, memberIds.length) };
}

/**
 * Stop uploads on a Fotoronde that is still open.
 *
 * Used when the host moves to another content block or completes the round. Deliberately
 * CLOSED rather than cancelled: the photos and the chance to award credits for them are
 * the point of the block, so ending the upload window must not throw away work that has
 * not been judged yet. A round that is already judged and completed is left alone.
 */
export async function closePhotoRoundForRound(client: PoolClient, gameId: number, roundId: number) {
  const { rowCount } = await client.query(
    `UPDATE photo_rounds
     SET status='CLOSED',closed_at=COALESCE(closed_at,NOW()),updated_at=NOW()
     WHERE game_night_id=$1 AND round_id=$2 AND status IN ('DRAFT','OPEN')`,
    [gameId, roundId],
  );
  return { closed: rowCount ?? 0 };
}
