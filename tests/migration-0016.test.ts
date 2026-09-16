import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pgliteAvailable } from './helpers/pglite';

/**
 * Migration 0016, run against a database that still has the block model in it.
 *
 * The hard case is a round that mixed content types, because a round with one type
 * cannot hold a roulette block and a quiz block at once — it has to become several
 * rounds. What that conversion does with the runtime state hanging off those blocks is
 * the thing most likely to be wrong and least likely to be noticed, so it is asserted
 * here rather than discovered on a game night.
 */
const MIGRATIONS = join(__dirname, '..', 'netlify', 'database', 'migrations');
const available = await pgliteAvailable();

const FIXTURE = `
INSERT INTO game_nights(id,name,starting_balance,game_state_version) VALUES (900,'Fixture',1000,5);
INSERT INTO players(id,game_night_id,display_name,public_color,active,starting_balance_snapshot)
VALUES (901,900,'Daan','#f00',TRUE,1000),(902,900,'Twan','#0f0',TRUE,1000);
INSERT INTO wallets(game_night_id,player_id,current_balance) VALUES (900,901,1000),(900,902,1000);

INSERT INTO rounds(id,game_night_id,round_number,title,description,status,started_at)
VALUES (910,900,1,'Gemengde ronde','Alles door elkaar','ACTIVE',NOW()),
       (912,900,2,'Lege ronde',NULL,'UPCOMING',NULL);

-- One round holding a text block, two quiz questions, a roulette, a picture, a
-- slotmachine and a Pak een Zes: every conversion path at once.
INSERT INTO round_blocks(id,game_night_id,round_id,type,sort_order,title,payload,interactive_status,revealed_at) VALUES
 (920,900,910,'TEXT',0,'Welkom','{"body":"Zet je telefoon aan"}',NULL,NULL),
 (921,900,910,'DUOLINGO_QUESTION',1,'Hoofdstad van Peru?','{"answers":["Lima","La Paz","Quito","Bogota"],"correctAnswerIndex":0,"rewardCoins":40,"body":"Zuid-Amerika","contextImageKey":"ctx-1"}','SETTLED',NOW()),
 (922,900,910,'DUOLINGO_QUESTION',2,'Grootste oceaan?','{"answers":["Atlantische","Stille","Indische","Noordelijke"],"correctAnswerIndex":1,"rewardCoins":20}','OPEN',NULL),
 (923,900,910,'ROULETTE',3,'Rad van fortuin','{"body":"Zet je fiches in"}',NULL,NULL),
 (924,900,910,'PICTURE',4,'De Eiffeltoren','{"imageKey":"pic-1","body":"Welk gebouw?"}','REVEALED',NOW()),
 (925,900,910,'WAGER',5,'Wager','{"correctAnswer":"42"}',NULL,NULL),
 (926,900,910,'SLOTMACHINE',6,'Gokkast','{"body":"Spelen maar","maxSpins":7,"allowedPlayerIds":[901,902,99999]}',NULL,NULL);

INSERT INTO round_question_answers(game_night_id,round_id,round_block_id,player_id,selected_answer)
VALUES (900,910,921,901,0),(900,910,921,902,2);
INSERT INTO roulette_games(id,game_night_id,round_id,round_block_id,status,result_number) VALUES (940,900,910,923,'SETTLED',17);
INSERT INTO slot_series(id,game_night_id,round_id,round_block_id,player_id,stake_per_spin,total_spins,spins_remaining,total_stake,status,idempotency_key)
VALUES (950,900,910,926,901,10,5,2,50,'ACTIVE','seed-950');
INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,attributed_round_id,round_block_id,created_by)
VALUES (900,901,40,'QUESTION_REWARD','Goed antwoord',910,921,'admin');

UPDATE screen_state SET mode='ROUND_BLOCK', round_id=910, payload='{"blockId":922}'::jsonb,
  staged_mode='ROUND_BLOCK', staged_round_id=910, staged_payload='{"blockId":923}'::jsonb
WHERE game_night_id=900;
INSERT INTO screen_state(game_night_id,mode,round_id,payload,staged_mode,staged_round_id,staged_payload)
SELECT 900,'ROUND_BLOCK',910,'{"blockId":922}'::jsonb,'ROUND_BLOCK',910,'{"blockId":923}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM screen_state WHERE game_night_id=900);

UPDATE game_nights SET current_round_id=910, current_round_block_id=922, current_screen_mode='ROUND_BLOCK' WHERE id=900;

-- Explicit ids leave the sequences behind, which would make the rounds this migration
-- creates collide with the fixture's own.
SELECT setval(pg_get_serial_sequence('rounds','id'), 1000, false);
SELECT setval(pg_get_serial_sequence('round_blocks','id'), 1000, false);
`;

describe.skipIf(!available)('migration 0016 · rounds become the content', () => {
  let db: any;
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

  beforeAll(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    db = new PGlite();
    const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();
    const cut = files.indexOf('0016_round_is_the_content.sql');
    for (const file of files.slice(0, cut)) await db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
    await db.exec(FIXTURE);
    await db.exec(readFileSync(join(MIGRATIONS, files[cut]), 'utf8'));
  });
  afterAll(async () => { await db?.close(); });

  it('splits a mixed round into one round per game, keeping their order', async () => {
    const rounds = await q("SELECT sort_order,title,type,status FROM rounds WHERE game_night_id=900 ORDER BY sort_order");
    expect(rounds.map((r: any) => r.type)).toEqual([
      'PRESENTATIE', 'LIVE_QUIZ', 'ROULETTE', 'SLOTMACHINE', 'PRESENTATIE',
    ]);
    // The original round keeps its id, its status and its place; the split-off pieces
    // follow it and start as UPCOMING, because only one round may be active.
    expect(rounds[0]).toMatchObject({ title: 'Gemengde ronde', status: 'ACTIVE' });
    expect(rounds.slice(1, 4).every((r: any) => r.status === 'UPCOMING')).toBe(true);
  });

  it('names a split-off game round after the block it carries', async () => {
    const titles = await q("SELECT title FROM rounds WHERE game_night_id=900 AND type IN ('ROULETTE','SLOTMACHINE') ORDER BY sort_order");
    expect(titles.map((r: any) => r.title)).toEqual(['Rad van fortuin', 'Gokkast']);
  });

  it('converts each quiz block into a question with its own points and options', async () => {
    const questions = await q("SELECT id,prompt,points,context_media_key FROM live_quiz_questions ORDER BY sort_order");
    expect(questions.map((x: any) => [x.prompt, x.points])).toEqual([
      ['Hoofdstad van Peru?', 40],
      ['Grootste oceaan?', 20],
    ]);
    expect(questions[0].context_media_key).toBe('ctx-1');

    // correctAnswerIndex becomes a flag on one option, which is what lets a question
    // have more than one correct answer from here on.
    const options = await q('SELECT text,is_correct FROM live_quiz_question_options WHERE question_id=$1 ORDER BY sort_order', [questions[0].id]);
    expect(options.map((o: any) => o.text)).toEqual(['Lima', 'La Paz', 'Quito', 'Bogota']);
    expect(options.map((o: any) => o.is_correct)).toEqual([true, false, false, false]);
  });

  it('keeps each question’s phase', async () => {
    const states = await q(`SELECT q.prompt,s.status FROM live_quiz_question_state s
                            JOIN live_quiz_questions q ON q.id=s.question_id ORDER BY q.sort_order`);
    expect(states.map((r: any) => r.status)).toEqual(['SETTLED', 'OPEN']);
  });

  // The six presentational types collapse into slides, and what made them different —
  // whether their answer was secret — survives as fields.
  it('turns the presentational blocks into slides that keep their secrets', async () => {
    const slides = await q(`SELECT title,media_kind,reveal_text,hide_title_until_reveal
                            FROM presentation_slides ORDER BY round_id,sort_order`);
    expect(slides).toMatchObject([
      { title: 'Welkom', media_kind: null, reveal_text: null, hide_title_until_reveal: false },
      // A picture round's title IS the answer.
      { title: 'De Eiffeltoren', media_kind: 'IMAGE', hide_title_until_reveal: true },
      // A wager round's correct answer becomes the reveal line.
      { title: 'Wager', reveal_text: '42', hide_title_until_reveal: false },
    ]);
  });

  it('moves the slotmachine settings onto the round and drops an unknown player', async () => {
    const config = await q('SELECT max_spins FROM slotmachine_rounds');
    expect(config[0].max_spins).toBe(7);
    const participants = await q('SELECT player_id FROM slotmachine_round_participants ORDER BY player_id');
    expect(participants.map((p: any) => Number(p.player_id))).toEqual([901, 902]);
    // Dropped, but said out loud rather than silently.
    const note = await q("SELECT note FROM migration_notes WHERE subject='slot_participant_dropped'");
    expect(note[0].note).toContain('99999');
  });

  it('repoints every piece of runtime state at the round its game became', async () => {
    const [roulette] = await q('SELECT round_id FROM roulette_games');
    const [series] = await q('SELECT round_id FROM slot_series');
    const rounds = await q("SELECT id,type FROM rounds WHERE game_night_id=900");
    const byType = Object.fromEntries(rounds.map((r: any) => [r.type, Number(r.id)]));
    expect(Number(roulette.round_id)).toBe(byType.ROULETTE);
    expect(Number(series.round_id)).toBe(byType.SLOTMACHINE);
  });

  it('keeps every answer and attaches it to the option the player picked', async () => {
    const answers = await q(`SELECT a.player_id,o.text FROM quiz_answers a
                             JOIN live_quiz_question_options o ON o.id=a.option_id ORDER BY a.player_id`);
    expect(answers.map((a: any) => [Number(a.player_id), a.text])).toEqual([[901, 'Lima'], [902, 'Quito']]);
  });

  it('re-attributes the ledger to the round the payment now belongs to', async () => {
    const [entry] = await q("SELECT attributed_round_id,quiz_question_id FROM ledger_entries WHERE transaction_type='QUESTION_REWARD'");
    const [quizRound] = await q("SELECT id FROM rounds WHERE game_night_id=900 AND type='LIVE_QUIZ'");
    expect(Number(entry.attributed_round_id)).toBe(Number(quizRound.id));
    expect(entry.quiz_question_id).not.toBeNull();
  });

  it('carries what was on the projector across to the typed pointers', async () => {
    const [screen] = await q('SELECT mode,round_id,quiz_question_id,staged_mode,staged_round_id,payload FROM screen_state WHERE game_night_id=900');
    expect(screen.mode).toBe('QUIZ_QUESTION');
    expect(screen.quiz_question_id).not.toBeNull();
    // A staged roulette block follows its block to the round it became, rather than
    // collapsing to the dashboard.
    expect(screen.staged_mode).toBe('ROULETTE');
    expect(screen.payload).toEqual({});
  });

  it('archives every block rather than deleting it, and says what it decided', async () => {
    const [{ c }] = await q('SELECT COUNT(*)::int c FROM round_blocks_archive');
    expect(c).toBe(7);
    const splits = await q("SELECT note FROM migration_notes WHERE subject='round_split'");
    expect(splits.length).toBe(3); // LIVE_QUIZ, ROULETTE and SLOTMACHINE were cut out
    expect(splits.every((n: any) => n.note.includes('mixed content types'))).toBe(true);
  });

  it('gives a round that never had content a type rather than guessing or deleting it', async () => {
    const [empty] = await q("SELECT type FROM rounds WHERE game_night_id=900 AND title='Lege ronde'");
    expect(empty.type).toBe('PRESENTATIE');
  });

  it('seeds every round a runtime cursor', async () => {
    const [{ rounds, runtimes }] = await q(`SELECT
      (SELECT COUNT(*)::int FROM rounds WHERE game_night_id=900) AS rounds,
      (SELECT COUNT(*)::int FROM round_runtime WHERE game_night_id=900) AS runtimes`);
    expect(runtimes).toBe(rounds);
  });
});
