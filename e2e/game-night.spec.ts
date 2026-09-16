import { test, expect, type Page } from '@playwright/test';

const enabled = Boolean(process.env.E2E_BASE_URL && process.env.E2E_ADMIN_PASSWORD);
test.skip(!enabled, 'requires deployed/local Netlify database and E2E_ADMIN_PASSWORD');

async function post(page: Page, path: string, data: any, idempotent = false) {
  const r = await page.request.post(path, { data, headers: idempotent ? { 'Idempotency-Key': crypto.randomUUID() } : undefined });
  expect(r.ok(), `${path}: ${await r.text()}`).toBeTruthy();
  return r.json();
}
async function getJson(page: Page, path: string) {
  const r = await page.request.get(path);
  expect(r.ok(), `${path}: ${await r.text()}`).toBeTruthy();
  return r.json();
}
const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

/** Full-stack smoke flow for the backlog architecture. */
test('prediction deposits, live question, groups and roulette stay ledger-backed end to end', async ({ browser }) => {
  const admin = await browser.newPage();
  await admin.goto('/admin/1/settings');
  await admin.getByPlaceholder('Username').fill(process.env.E2E_ADMIN_USERNAME || 'admin');
  await admin.getByPlaceholder('Password').fill(process.env.E2E_ADMIN_PASSWORD!);
  await admin.getByRole('button', { name: 'SIGN IN' }).click();
  // Signing in POSTs then reloads. Without waiting for the shell to actually appear,
  // the requests below race the session cookie and fail as 401.
  await expect(admin.locator('.admin-sidebar')).toBeVisible({ timeout: 20_000 });

  const wrongReset = await admin.request.post('/api/reset-game', { data: { gameId: 1, confirmation: 'YES DELETE' } });
  expect(wrongReset.status()).toBe(400);
  await post(admin, '/api/reset-game', { gameId: 1, confirmation: 'yes delete' });
  await post(admin, '/api/update-settings', { gameId: 1, name: 'E2E Market Mayhem', startingBalance: 100, maximumWalletPercentage: 50 });

  const a = await post(admin, '/api/create-player', { gameId: 1, displayName: 'Player A', color: '#6366F1' });
  const b = await post(admin, '/api/create-player', { gameId: 1, displayName: 'Player B', color: '#10B981' });
  const la = await post(admin, '/api/player-join-link', { gameId: 1, playerId: a.playerId });
  const lb = await post(admin, '/api/player-join-link', { gameId: 1, playerId: b.playerId });

  const pa = await browser.newPage();
  const pb = await browser.newPage();
  await post(pa, '/api/join-player', { token: la.path.split('/').pop() });
  await post(pb, '/api/join-player', { token: lb.path.split('/').pop() });

  // A round has exactly one type, so the quiz and the roulette are two rounds. Mixing
  // them was the thing the block model allowed and this model deliberately does not.
  const round = await post(admin, '/api/create-round', {
    gameId: 1, type: 'LIVE_QUIZ', title: 'E2E Quiz', description: 'Backlog flow', defaultPoints: 10,
  });
  const question = await post(admin, '/api/upsert-quiz-question', {
    gameId: 1, roundId: round.roundId, prompt: 'Which city is the capital of the Netherlands?',
    points: 10,
    options: [
      { text: 'Amsterdam', isCorrect: true },
      { text: 'Brussels', isCorrect: false },
      { text: 'Paris', isCorrect: false },
      { text: 'Berlin', isCorrect: false },
    ],
  });
  const rouletteRound = await post(admin, '/api/create-round', { gameId: 1, type: 'ROULETTE', title: 'E2E Roulette' });

  const group = await post(admin, '/api/upsert-round-group', { gameId: 1, roundId: round.roundId, name: 'Team Alpha' });
  await post(admin, '/api/set-round-group-members', { gameId: 1, groupId: group.groupId, playerIds: [a.playerId, b.playerId] });

  const prediction = await post(admin, '/api/create-prediction', {
    gameId: 1, question: 'Will Player A win?', roundId: round.roundId, probabilityPercent: 40,
    predictionTimeSeconds: 5, minimumStake: 5, maximumStake: 100, scheduled: true,
  });
  await post(admin, '/api/start-round', { gameId: 1, roundId: round.roundId });
  await post(admin, '/api/adjust-group-coins', { gameId: 1, groupId: group.groupId, amount: 5, reason: 'Team warmup' }, true);
  const started = await getJson(admin, '/api/admin-state?gameId=1');
  const opened = started.predictions.find((x: any) => x.id === prediction.predictionId);
  expect(opened.status).toBe('OPEN');
  expect(Number(opened.yes_odds)).toBe(2.5);
  expect(new Date(opened.closes_at).getTime() - new Date(opened.opened_at).getTime()).toBe(5000);
  // Starting a round changes progression only: the projector stays where it was.
  expect(started.screen.mode).toBe('DASHBOARD');
  expect(started.screen.questionId).toBeNull();
  // The round's own cursor did move — that is game state, not presentation.
  expect(started.roundRuntime.currentQuizQuestionId).toBe(question.questionId);

  const initialA = await getJson(pa, '/api/player-state?gameId=1');
  expect(initialA.player.balance).toBe(105);
  await post(pa, '/api/place-bet', { gameId: 1, predictionId: prediction.predictionId, side: 'YES', stake: 20 }, true);
  const depositedA = await getJson(pa, '/api/player-state?gameId=1');
  expect(depositedA.player.balance).toBe(85);
  expect(depositedA.player.lockedPrediction).toBe(20);
  expect(depositedA.player.totalValue).toBe(105);

  const beforeB = await getJson(pb, '/api/player-state?gameId=1');
  await new Promise(resolve => setTimeout(resolve, 5500));
  await admin.request.get('/api/game-version?gameId=1');
  const late = await pb.request.post('/api/place-bet', { data: { gameId: 1, predictionId: prediction.predictionId, side: 'NO', stake: 10 }, headers: { 'Idempotency-Key': crypto.randomUUID() } });
  expect(late.status()).toBe(409);
  expect((await getJson(pb, '/api/player-state?gameId=1')).player.balance).toBe(beforeB.player.balance); // abstention is no-op

  await post(admin, '/api/set-prediction-result', { gameId: 1, predictionId: prediction.predictionId, result: 'YES' });
  await post(admin, '/api/settle-prediction', { gameId: 1, predictionId: prediction.predictionId }, true);
  expect((await getJson(pa, '/api/player-state?gameId=1')).player.balance).toBe(135); // 105 - 20 + full 50 return

  // The live question becomes the phone controller. Which option is correct never
  // reaches a phone before the reveal — the field is simply absent.
  await post(admin, '/api/show-on-screen', { gameId: 1, kind: 'quizQuestion', roundId: round.roundId, questionId: question.questionId });
  await post(admin, '/api/quiz-question-action', { gameId: 1, questionId: question.questionId, action: 'OPEN' });
  const playerQuestion = await getJson(pa, '/api/player-state?gameId=1');
  expect(playerQuestion.quizQuestion.status).toBe('OPEN');
  expect(playerQuestion.quizQuestion.myAnswerCorrect).toBeNull();
  for (const option of playerQuestion.quizQuestion.options) {
    expect(option.isCorrect).toBeUndefined();
  }
  const optionIds = playerQuestion.quizQuestion.options.map((o: any) => o.id);
  await post(pa, '/api/submit-quiz-answer', { gameId: 1, questionId: question.questionId, optionId: optionIds[0] });
  await post(pb, '/api/submit-quiz-answer', { gameId: 1, questionId: question.questionId, optionId: optionIds[1] });
  const duplicateAnswer = await pa.request.post('/api/submit-quiz-answer', { data: { gameId: 1, questionId: question.questionId, optionId: optionIds[2] } });
  expect(duplicateAnswer.status()).toBe(409);
  await post(admin, '/api/quiz-question-action', { gameId: 1, questionId: question.questionId, action: 'CLOSE' });
  await post(admin, '/api/quiz-question-action', { gameId: 1, questionId: question.questionId, action: 'REVEAL' });
  expect((await getJson(pa, '/api/player-state?gameId=1')).player.balance).toBe(145);
  expect((await getJson(pb, '/api/player-state?gameId=1')).player.balance).toBe(105);
  // A replayed reveal pays nobody twice — the ledger's unique index is what guarantees it.
  await post(admin, '/api/quiz-question-action', { gameId: 1, questionId: question.questionId, action: 'REVEAL' });
  expect((await getJson(pa, '/api/player-state?gameId=1')).player.balance).toBe(145);
  await post(admin, '/api/quiz-question-action', { gameId: 1, questionId: question.questionId, action: 'SETTLE' });

  // Leaving the quiz round for the roulette round runs the quiz round's exit policy.
  await post(admin, '/api/complete-round', { gameId: 1, roundId: round.roundId });
  await post(admin, '/api/start-round', { gameId: 1, roundId: rouletteRound.roundId });

  // Roulette chips are batch-placed on canonical regions. The server selects the spin number.
  await post(admin, '/api/show-on-screen', { gameId: 1, kind: 'round', roundId: rouletteRound.roundId });
  let adminState = await getJson(admin, '/api/admin-state?gameId=1');
  const rg = adminState.activeRoulette;
  await post(admin, '/api/roulette-action', { gameId: 1, rouletteGameId: rg.id, action: 'OPEN' });
  await post(pa, '/api/place-roulette-bets', { gameId: 1, rouletteGameId: rg.id, bets: [{ betType: 'COLOR', selection: 'RED', stake: 10 }] }, true);
  await post(pb, '/api/place-roulette-bets', { gameId: 1, rouletteGameId: rg.id, bets: [{ betType: 'COLOR', selection: 'BLACK', stake: 10 }] }, true);

  const screen = await browser.newPage();
  await screen.goto('/screen/1');
  await expect(screen.getByText('Player A')).toBeVisible();
  await expect(screen.getByText('Player B')).toBeVisible();

  await post(admin, '/api/roulette-action', { gameId: 1, rouletteGameId: rg.id, action: 'CLOSE' });
  await post(admin, '/api/roulette-action', { gameId: 1, rouletteGameId: rg.id, action: 'SPIN' });
  adminState = await getJson(admin, '/api/admin-state?gameId=1');
  expect(adminState.activeRoulette.result_number).toBeNull(); // Admin does not get an early reveal while the wheel animates.
  await new Promise(resolve => setTimeout(resolve, 5800));
  await admin.request.get('/api/game-version?gameId=1');
  adminState = await getJson(admin, '/api/admin-state?gameId=1');
  const result = Number(adminState.activeRoulette.result_number);
  expect(result).toBeGreaterThanOrEqual(0); expect(result).toBeLessThanOrEqual(36);
  await post(admin, '/api/roulette-action', { gameId: 1, rouletteGameId: rg.id, action: 'SETTLE' }, true);
  const duplicateSettle = await post(admin, '/api/roulette-action', { gameId: 1, rouletteGameId: rg.id, action: 'SETTLE' }, true);
  expect(duplicateSettle.duplicate).toBe(true);

  const afterRouletteA = await getJson(pa, '/api/player-state?gameId=1');
  const afterRouletteB = await getJson(pb, '/api/player-state?gameId=1');
  expect(afterRouletteA.player.balance).toBe(135 + (RED.has(result) ? 20 : 0));
  expect(afterRouletteB.player.balance).toBe(95 + (result !== 0 && !RED.has(result) ? 20 : 0));

  await post(admin, '/api/complete-round', { gameId: 1, roundId: rouletteRound.roundId });
  // Group adjustments stay available after a round is completed, so a correction is
  // still possible once the evening has moved on.
  await post(admin, '/api/adjust-group-coins', { gameId: 1, groupId: group.groupId, amount: 3, reason: 'Retroactive correction' }, true);
  const ledger = await getJson(admin, `/api/ledger-state?gameId=1&round=${round.roundId}`);
  expect(ledger.entries.filter((x: any) => x.description === 'Retroactive correction')).toHaveLength(2);
  expect(ledger.entries.every((x: any) => x.description !== 'Retroactive correction' || x.group_name === 'Team Alpha')).toBe(true);

  await post(admin, '/api/show-on-screen', { gameId: 1, kind: 'dashboard' });
  await screen.reload();
  await expect(screen.getByText('LIVE VALUE GRAPH')).toBeVisible();
  await expect(screen.getByText('Prediction results')).toBeVisible();
});
