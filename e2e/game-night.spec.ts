import { test, expect, type Page } from '@playwright/test';

const enabled = Boolean(process.env.E2E_BASE_URL && process.env.E2E_ADMIN_PASSWORD);
test.skip(!enabled, 'requires deployed/local Netlify database and E2E_ADMIN_PASSWORD');

async function post(page: Page, path: string, data: any, idempotent = false) {
  const r = await page.request.post(path, {
    data,
    headers: idempotent ? { 'Idempotency-Key': crypto.randomUUID() } : undefined,
  });
  expect(r.ok(), `${path}: ${await r.text()}`).toBeTruthy();
  return r.json();
}

async function getJson(page: Page, path: string) {
  const r = await page.request.get(path);
  expect(r.ok(), `${path}: ${await r.text()}`).toBeTruthy();
  return r.json();
}

test('admin + screen + two players complete prediction, ledger and roulette flow', async ({ browser }) => {
  const admin = await browser.newPage();
  await admin.goto('/admin/1/settings');
  await admin.getByPlaceholder('Username').fill(process.env.E2E_ADMIN_USERNAME || 'admin');
  await admin.getByPlaceholder('Password').fill(process.env.E2E_ADMIN_PASSWORD!);
  await admin.getByRole('button', { name: 'SIGN IN' }).click();
  await expect(admin).toHaveURL(/\/admin\/1\/settings/);

  // Settings + reset safety.
  const wrongReset = await admin.request.post('/api/reset-game', { data: { gameId: 1, confirmation: 'YES DELETE' } });
  expect(wrongReset.status()).toBe(400);
  await post(admin, '/api/reset-game', { gameId: 1, confirmation: 'yes delete' });
  await post(admin, '/api/update-settings', {
    gameId: 1,
    name: 'E2E Market Mayhem',
    startingBalance: 100,
    predictionDurationSeconds: 5,
    minimumPredictionStake: 5,
    maximumPredictionStake: 100,
    maximumWalletPercentage: 50,
  });

  // Players inherit the configured starting balance.
  const a = await post(admin, '/api/create-player', { gameId: 1, displayName: 'Player A', color: '#3D5AFE' });
  const b = await post(admin, '/api/create-player', { gameId: 1, displayName: 'Player B', color: '#DFF24C' });
  const la = await post(admin, '/api/player-join-link', { gameId: 1, playerId: a.playerId });
  const lb = await post(admin, '/api/player-join-link', { gameId: 1, playerId: b.playerId });

  const round = await post(admin, '/api/create-round', { gameId: 1, roundNumber: 7, title: 'E2E Round', description: 'Integration flow' });
  await post(admin, '/api/upsert-round-block', { gameId: 1, roundId: round.roundId, type: 'TEXT', title: 'Welcome', body: 'E2E content' });
  await post(admin, '/api/upsert-round-block', { gameId: 1, roundId: round.roundId, type: 'QUESTION', title: 'What happens next?', body: 'Supporting copy' });
  const rouletteBlock = await post(admin, '/api/upsert-round-block', { gameId: 1, roundId: round.roundId, type: 'ROULETTE', title: 'Roulette', body: '' });

  // Signed manual adjustments, mandatory reason and round attribution.
  const missingReason = await admin.request.post('/api/adjust-coins', {
    data: { gameId: 1, playerId: a.playerId, amount: 25, reason: '', roundId: round.roundId },
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  });
  expect(missingReason.status()).toBe(400);
  await post(admin, '/api/adjust-coins', { gameId: 1, playerId: a.playerId, amount: 25, reason: 'Won challenge', roundId: round.roundId }, true);
  await post(admin, '/api/adjust-coins', { gameId: 1, playerId: a.playerId, amount: -10, reason: 'Correction', roundId: null }, true);
  const roundLedger = await getJson(admin, `/api/ledger-state?gameId=1&round=${round.roundId}`);
  expect(roundLedger.entries.some((x: any) => x.description === 'Won challenge' && x.amount === 25)).toBe(true);
  expect(roundLedger.entries.some((x: any) => x.description === 'Correction')).toBe(false);

  // Scheduled prediction: fixed custom odds and automatic opening on round start.
  const prediction = await post(admin, '/api/create-prediction', {
    gameId: 1,
    question: 'Will Player A win?',
    roundId: round.roundId,
    yesOdds: 2.5,
    noOdds: 1.5,
    scheduled: true,
  });
  const beforeStart = await getJson(admin, '/api/admin-state?gameId=1');
  expect(beforeStart.predictions.find((x: any) => x.id === prediction.predictionId).status).toBe('SCHEDULED');
  await post(admin, '/api/start-round', { gameId: 1, roundId: round.roundId });
  const afterStart = await getJson(admin, '/api/admin-state?gameId=1');
  const opened = afterStart.predictions.find((x: any) => x.id === prediction.predictionId);
  expect(opened.status).toBe('OPEN');
  expect(Number(opened.yes_odds)).toBe(2.5);
  expect(Number(opened.no_odds)).toBe(1.5);
  expect(new Date(opened.closes_at).getTime() - new Date(opened.opened_at).getTime()).toBe(5000);

  const pa = await browser.newPage();
  const pb = await browser.newPage();
  await post(pa, '/api/join-player', { token: la.path.split('/').pop() });
  await post(pb, '/api/join-player', { token: lb.path.split('/').pop() });
  const joinedAdminState = await getJson(admin, '/api/admin-state?gameId=1');
  expect(joinedAdminState.players.find((x: any) => x.id === a.playerId).joined).toBe(true);
  expect(joinedAdminState.players.find((x: any) => x.id === b.playerId).joined).toBe(true);
  const initialA = await getJson(pa, '/api/player-state?gameId=1');
  const initialB = await getJson(pb, '/api/player-state?gameId=1');
  expect(initialA.player.balance).toBe(115);
  expect(initialB.player.balance).toBe(100);

  await pa.goto('/play/1/predictions');
  await expect(pa.getByText('Will Player A win?')).toBeVisible();
  await post(pa, '/api/place-bet', { gameId: 1, predictionId: prediction.predictionId, side: 'YES', stake: 20 }, true);

  // Player B abstains; deadline is enforced server-side even if their UI were stale.
  const beforeB = await getJson(pb, '/api/player-state?gameId=1');
  await new Promise((resolve) => setTimeout(resolve, 5500));
  await admin.request.get('/api/game-version?gameId=1');
  const late = await pb.request.post('/api/place-bet', {
    data: { gameId: 1, predictionId: prediction.predictionId, side: 'NO', stake: 10 },
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  });
  expect(late.status()).toBe(409);
  const afterB = await getJson(pb, '/api/player-state?gameId=1');
  expect(afterB.player.balance).toBe(beforeB.player.balance);

  await post(admin, '/api/set-prediction-result', { gameId: 1, predictionId: prediction.predictionId, result: 'YES' });
  await post(admin, '/api/settle-prediction', { gameId: 1, predictionId: prediction.predictionId }, true);
  const duplicatePredictionSettle = await post(admin, '/api/settle-prediction', { gameId: 1, predictionId: prediction.predictionId }, true);
  expect(duplicatePredictionSettle.duplicate).toBe(true);
  const afterA = await getJson(pa, '/api/player-state?gameId=1');
  expect(afterA.player.balance).toBe(145); // 115 - 20 + round(20 * 2.5)

  // Cancellation refunds the stake exactly once.
  const cancelPrediction = await post(admin, '/api/create-prediction', {
    gameId: 1,
    question: 'Cancellation test',
    roundId: round.roundId,
    yesOdds: 2,
    noOdds: 2,
    scheduled: false,
  });
  await post(admin, '/api/open-prediction', { gameId: 1, predictionId: cancelPrediction.predictionId });
  await post(pb, '/api/place-bet', { gameId: 1, predictionId: cancelPrediction.predictionId, side: 'NO', stake: 10 }, true);
  expect((await getJson(pb, '/api/player-state?gameId=1')).player.balance).toBe(90);
  await post(admin, '/api/cancel-prediction', { gameId: 1, predictionId: cancelPrediction.predictionId }, true);
  expect((await getJson(pb, '/api/player-state?gameId=1')).player.balance).toBe(100);

  await post(admin, '/api/screen-mode', { gameId: 1, mode: 'DASHBOARD' });
  const screen = await browser.newPage();
  await screen.goto('/screen/1');
  await expect(screen.getByText('LIVE VALUE GRAPH')).toBeVisible();
  await expect(screen.getByText('PREDICTION #1').first()).toBeVisible();

  // Roulette: valid/invalid/insufficient bets, winner/loser payouts and double settlement.
  await post(admin, '/api/set-active-round-block', { gameId: 1, roundId: round.roundId, blockId: rouletteBlock.blockId });
  const state = await getJson(admin, '/api/admin-state?gameId=1');
  const rg = state.activeRoulette;
  await post(admin, '/api/roulette-action', { gameId: 1, rouletteGameId: rg.id, action: 'OPEN' });

  const invalidRoulette = await pa.request.post('/api/place-roulette-bet', {
    data: { gameId: 1, rouletteGameId: rg.id, betType: 'NUMBER', selection: 37, stake: 10 },
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  });
  expect(invalidRoulette.status()).toBe(400);
  const insufficient = await pa.request.post('/api/place-roulette-bet', {
    data: { gameId: 1, rouletteGameId: rg.id, betType: 'COLOR', selection: 'RED', stake: 999999 },
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  });
  expect(insufficient.status()).toBe(409);

  await post(pa, '/api/place-roulette-bet', { gameId: 1, rouletteGameId: rg.id, betType: 'COLOR', selection: 'RED', stake: 10 }, true);
  await post(pb, '/api/place-roulette-bet', { gameId: 1, rouletteGameId: rg.id, betType: 'COLOR', selection: 'BLACK', stake: 10 }, true);
  await post(admin, '/api/roulette-action', { gameId: 1, rouletteGameId: rg.id, action: 'CLOSE' });
  await post(admin, '/api/roulette-action', { gameId: 1, rouletteGameId: rg.id, action: 'SET_RESULT', resultNumber: 1 });
  await post(admin, '/api/roulette-action', { gameId: 1, rouletteGameId: rg.id, action: 'SETTLE' }, true);
  const duplicateRouletteSettle = await post(admin, '/api/roulette-action', { gameId: 1, rouletteGameId: rg.id, action: 'SETTLE' }, true);
  expect(duplicateRouletteSettle.duplicate).toBe(true);

  const finalA = await getJson(pa, '/api/player-state?gameId=1');
  const finalB = await getJson(pb, '/api/player-state?gameId=1');
  expect(finalA.player.balance).toBe(155); // 145 - 10 + 20
  expect(finalB.player.balance).toBe(90);  // 100 - 10, losing bet pays zero
  await expect(screen.getByText('1', { exact: true })).toBeVisible();
});
