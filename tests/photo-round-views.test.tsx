import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { MobileViews } from '../src/components/mobile/MobileViews';
import { ControlPage } from '../src/components/admin/control/ControlPage';

const noop = () => {};
const run = async () => true;
const render = (node: any) => renderToStaticMarkup(node);
const renderRouted = (node: any) => renderToStaticMarkup(createElement(MemoryRouter, null, node));

const SUBJECTS = [
  { key: 'kunstigs', label: 'Iets kunstigs' },
  { key: 'lelijks', label: 'Iets lelijks' },
  { key: 'moois', label: 'Iets moois' },
];

/** The `photoRound` block of a player-state payload. */
function photo(overrides: Record<string, unknown> = {}) {
  return {
    roundId: 3,
    title: 'Fotoronde',
    instructions: 'Ga op jacht.',
    status: 'OPEN',
    open: true,
    team: { groupId: 7, name: 'Team Blauw' },
    subjects: SUBJECTS.map(s => ({ ...s, submitted: false, mediaKey: null, uploaderName: null, uploadedAt: null })),
    ...overrides,
  };
}

function playerState(overrides: Record<string, unknown> = {}) {
  return {
    version: 4,
    player: { id: 1, name: 'Daan', color: '#9B2FF2', rank: 1, balance: 340, startingBalance: 100, lockedPrediction: 0, lockedRoulette: 0, lockedSlot: 0, totalValue: 340 },
    settings: { maximumWalletPercentage: null },
    predictions: [],
    predictionAvailable: false,
    actionable: true,
    roulette: null,
    interactiveBlock: null,
    slotmachine: null,
    pakEenZes: null,
    photoRound: null,
    recentLedger: [],
    predictionRequests: { mine: [], remaining: 2, cooldownMinutesLeft: 0 },
    ...overrides,
  };
}

const mobile = (state: any) =>
  render(createElement(MobileViews, { state, gameId: 1, view: 'home', predictionId: null, busy: false, act: noop, go: noop }));

describe('Fotoronde on the phone', () => {
  it('takes over any view while the block is live', () => {
    const html = mobile(playerState({ photoRound: photo() }));
    expect(html).toContain('FOTORONDE');
    expect(html).toContain('Iets kunstigs');
    expect(html).not.toContain('AVAILABLE WALLET');
  });

  it('disappears again when no Fotoronde block is live', () => {
    const html = mobile(playerState());
    expect(html).toContain('AVAILABLE WALLET');
    expect(html).not.toContain('FOTO UPLOADEN');
  });

  // The team is derived from the session, so there is no picker to get wrong.
  it('names the player’s own team and offers no way to change it', () => {
    const html = mobile(playerState({ photoRound: photo() }));
    expect(html).toContain('Team Blauw');
    expect(html).not.toContain('<select');
  });

  it('lists every subject with its own upload button', () => {
    const html = mobile(playerState({ photoRound: photo() }));
    expect(html.match(/class="card photo-subject-card /g)?.length).toBe(3);
    expect(html.match(/FOTO UPLOADEN/g)?.length).toBe(3);
  });

  it('tells a player with no team that they cannot submit', () => {
    const html = mobile(playerState({ photoRound: photo({ team: null }) }));
    expect(html).toContain('niet in een team');
    expect(html).not.toContain('FOTO UPLOADEN');
  });

  // Any team-mate's photo is the team's photo — that is what a second member must see.
  it('shows a subject as sent, by whom, with a preview', () => {
    const html = mobile(playerState({
      photoRound: photo({
        subjects: [
          { ...SUBJECTS[0], submitted: true, mediaKey: '1/image/abc.png', uploaderName: 'Emma', uploadedAt: new Date().toISOString() },
          { ...SUBJECTS[1], submitted: false, mediaKey: null, uploaderName: null, uploadedAt: null },
          { ...SUBJECTS[2], submitted: false, mediaKey: null, uploaderName: null, uploadedAt: null },
        ],
      }),
    }));
    expect(html).toContain('Ingezonden');
    expect(html).toContain('door Emma');
    expect(html).toContain('photo-subject-preview');
    expect(html).toContain('abc.png');
    // Replacing is still possible while the round is open.
    expect(html).toContain('FOTO VERVANGEN');
  });

  it('offers no upload at all before the host opens submissions', () => {
    const html = mobile(playerState({ photoRound: photo({ status: 'DRAFT', open: false }) }));
    expect(html).toContain('Nog even wachten');
    expect(html).not.toContain('FOTO UPLOADEN');
  });

  // Closing is what makes judging meaningful, so the phone must stop offering replacements.
  it('offers no upload once submissions are closed', () => {
    const html = mobile(playerState({
      photoRound: photo({
        status: 'CLOSED',
        open: false,
        subjects: [{ ...SUBJECTS[0], submitted: true, mediaKey: '1/image/abc.png', uploaderName: 'Emma', uploadedAt: null }],
      }),
    }));
    expect(html).toContain('Inzenden is gesloten');
    expect(html).not.toContain('FOTO UPLOADEN');
    expect(html).not.toContain('FOTO VERVANGEN');
    // The photo it already sent stays visible.
    expect(html).toContain('Ingezonden');
  });

  it('says so once the round is finished', () => {
    const html = mobile(playerState({ photoRound: photo({ status: 'COMPLETED', open: false }) }));
    expect(html).toContain('afgerond');
  });
});

describe('Fotoronde in the Control Center', () => {
  const TEAMS = [
    { groupId: 7, name: 'Team Blauw', memberIds: [1, 2, 3, 4], memberNames: ['Bas', 'Daan', 'Emma', 'Twan'] },
    { groupId: 8, name: 'Team Rood', memberIds: [5, 6], memberNames: ['Jorrit', 'Sanne'] },
  ];
  const submission = (id: number, groupId: number, teamName: string, credits: number | null = null) => ({
    id,
    subjectKey: 'kunstigs',
    groupId,
    teamName,
    uploadedBy: 1,
    uploaderName: 'Daan',
    mediaKey: `1/image/p${id}.png`,
    creditsAwarded: credits,
    awardedAt: credits == null ? null : new Date().toISOString(),
    uploadedAt: new Date().toISOString(),
    distribution: credits == null ? 'no credits' : '1 × 7 + 3 × 6',
  });

  const PHOTO_ROUND = {
    id: 3, sortOrder: 3, title: 'Fotoronde', type: 'FOTORONDE', status: 'ACTIVE', description: '', instructions: '', defaultPoints: 10, subjects: [],
      groups: [
        { id: 7, round_id: 3, name: 'Team Blauw', members: [
          { id: 1, display_name: 'Bas', public_color: '#3D5AFE', active: true },
          { id: 2, display_name: 'Daan', public_color: '#9B2FF2', active: true },
          { id: 3, display_name: 'Emma', public_color: '#2FAF5B', active: true },
          { id: 4, display_name: 'Twan', public_color: '#E8352F', active: true },
        ] },
        { id: 8, round_id: 3, name: 'Team Rood', members: [
          { id: 5, display_name: 'Jorrit', public_color: '#FF7A1E', active: true },
          { id: 6, display_name: 'Sanne', public_color: '#1FD8E0', active: true },
        ] },
      ],
    };

  const state = (photoOverrides: Record<string, unknown> = {}) => ({
    version: 1,
    game: { id: 1, name: 'Game Night', starting_balance: 100, maximum_wallet_percentage: null, current_round_id: 3, current_screen_mode: 'FOTORONDE', game_state_version: 1 },
    screen: { mode: 'FOTORONDE', roundId: 3, questionId: null, slideId: null, predictionId: null, staged: { mode: 'FOTORONDE', roundId: 3, questionId: null, slideId: null, predictionId: null }, previous: { mode: null, roundId: null, questionId: null, slideId: null, predictionId: null } },
    roundRuntime: { currentQuizQuestionId: null, currentSlideId: null, revision: 0 },
    predictionRequests: [],
    rounds: [PHOTO_ROUND],
    activeRound: PHOTO_ROUND,
    players: [
      { id: 1, display_name: 'Bas', public_color: '#3D5AFE', active: true, current_balance: 290, locked_prediction: 0, rank: 1, joined: true },
      { id: 2, display_name: 'Daan', public_color: '#9B2FF2', active: true, current_balance: 280, locked_prediction: 0, rank: 2, joined: true },
    ],
    predictions: [],
    activePredictions: [],
    recentTransactions: [],
    activeRoulette: null,
    slotConfig: null,
    activeSlot: null,
    pakEenZes: null,
    photoRound: {
      roundId: 3,
      id: 3,
      status: 'CLOSED',
      instructions: '',
      subjects: SUBJECTS,
      teams: TEAMS,
      submissions: [submission(1, 7, 'Team Blauw'), submission(2, 8, 'Team Rood')],
      bySubject: [
        { subject: SUBJECTS[0], submissions: [submission(1, 7, 'Team Blauw'), submission(2, 8, 'Team Rood')], missingTeams: [], submittedCount: 2 },
        { subject: SUBJECTS[1], submissions: [], missingTeams: ['Team Blauw', 'Team Rood'], submittedCount: 0 },
        { subject: SUBJECTS[2], submissions: [], missingTeams: ['Team Rood'], submittedCount: 1 },
      ],
      teamTotals: [
        { groupId: 7, name: 'Team Blauw', credits: 0, submitted: 1, judged: 0 },
        { groupId: 8, name: 'Team Rood', credits: 0, submitted: 1, judged: 0 },
      ],
      submissionCount: 2,
      judgedCount: 0,
      totalCredits: 0,
      acceptsUploads: false,
      acceptsAwards: true,
      shownSubmissionId: null,
      ...photoOverrides,
    },
    ...({} as Record<string, unknown>),
  });

  const panel = (overrides: Record<string, unknown> = {}) =>
    renderRouted(createElement(ControlPage, { state: state(overrides), gameId: 1, run }));

  it('offers the phase controls in order and only one at a time', () => {
    expect(panel({ status: 'DRAFT', acceptsAwards: false })).toContain('OPEN INZENDEN');
    expect(panel({ status: 'OPEN', acceptsAwards: false })).toContain('SLUIT INZENDEN');
    expect(panel({ status: 'CLOSED' })).toContain('MARKEER AFGEROND');
  });

  it('lists the teams and who is in them', () => {
    const html = panel();
    expect(html).toContain('Team Blauw');
    expect(html).toContain('Bas, Daan, Emma, Twan');
    expect(html).toContain('Team Rood');
    expect(html).toContain('Jorrit, Sanne');
  });

  // Teams are Admin-created round groups, and the host makes them where they need
  // them — running the Fotoronde — rather than on a different page.
  it('lets the host create a team without leaving the panel', () => {
    const html = panel();
    expect(html).toContain('TEAMS · 2');
    expect(html).toContain('Teams aanpassen');
  });

  it('pushes hard for a first team when the round has none', () => {
    const html = renderRouted(createElement(ControlPage, {
      state: {
        ...state({ teams: [], bySubject: [], submissions: [], teamTotals: [] }),
        rounds: [{ ...PHOTO_ROUND, groups: [] }],
        activeRound: { ...PHOTO_ROUND, groups: [] },
      },
      gameId: 1,
      run,
    }));
    expect(html).toContain('Nog geen teams in deze ronde');
    expect(html).toContain('kan niet open zonder');
    // The create form is open by default when there is nothing yet.
    expect(html).toContain('Teamnaam');
    expect(html).toContain('+ TEAM');
  });

  it('groups the photos by subject and names the teams still missing', () => {
    const html = panel();
    expect(html).toContain('IETS KUNSTIGS');
    expect(html).toContain('IETS LELIJKS');
    expect(html).toContain('NOG GEEN FOTO');
    // Iets lelijks has nothing from either team.
    expect(html).toContain('2 / 2 teams');
  });

  // The split has to be visible before the award is confirmed, not after.
  it('offers a credit input per photo and shows how it would split', () => {
    const html = panel();
    expect(html.match(/class="field photo-credit-input"/g)?.length).toBe(2);
    expect(html).toContain('TOEKENNEN');
    // Team Blauw has four members, Team Rood two.
    expect(html).toContain('4 spelers');
    expect(html).toContain('2 spelers');
  });

  // The server refuses a second award, so offering one would be a lie.
  it('replaces the input with the award once a photo is judged', () => {
    const html = panel({
      submissions: [submission(1, 7, 'Team Blauw', 25)],
      bySubject: [{ subject: SUBJECTS[0], submissions: [submission(1, 7, 'Team Blauw', 25)], missingTeams: [], submittedCount: 1 }],
      judgedCount: 1,
      totalCredits: 25,
    });
    expect(html).toContain('25 credits');
    expect(html).toContain('1 × 7 + 3 × 6');
    expect(html).not.toContain('photo-credit-input');
  });

  it('refuses to judge before submissions are closed', () => {
    const html = panel({ status: 'OPEN', acceptsAwards: false });
    expect(html).toContain('Sluit het inzenden om te beoordelen');
    expect(html).not.toContain('photo-credit-input');
  });

  it('offers each photo to the Big Screen and can take it down again', () => {
    expect(panel()).toContain('OP BIG SCREEN');
    expect(panel({ shownSubmissionId: 1 })).toContain('VAN SCHERM HALEN');
  });

  it('shows each team what it has earned so far', () => {
    const html = panel({
      teamTotals: [
        { groupId: 7, name: 'Team Blauw', credits: 25, submitted: 2, judged: 1 },
        { groupId: 8, name: 'Team Rood', credits: 15, submitted: 1, judged: 1 },
      ],
    });
    expect(html).toContain('25 credits');
    expect(html).toContain('15 credits');
  });

  it('explains where the credits go', () => {
    expect(panel()).toContain('split across its active players');
  });
});
