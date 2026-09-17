import { requireAdmin } from '../lib/auth';
import { database } from '../lib/db';
import { ok, HttpError } from '../lib/http';
import { previewNavigation } from '../lib/screen-preview';
import type { NavigationDirection } from '../lib/screen-flow';
import { wrap, gameIdFrom } from './_wrap';

/**
 * What the projector will show if the host presses VOLGENDE — or VORIGE.
 *
 * Nothing but auth, parameters and the pool: the preview itself is assembled in
 * `screen-preview.ts`, where it can be tested against the screen it predicts.
 *
 * `planStep` only reads, so this runs on the pool rather than opening a transaction for a
 * question the Admin asks on every poll.
 */
export default wrap(async request => {
  await requireAdmin(request);
  const gameId = gameIdFrom(request);
  const url = new URL(request.url);
  const direction = String(url.searchParams.get('direction') || 'NEXT').toUpperCase() as NavigationDirection;
  if (!['NEXT', 'PREVIOUS'].includes(direction)) throw new HttpError(400, 'direction must be NEXT or PREVIOUS');

  return ok(await previewNavigation(database().pool as any, gameId, direction));
}, 'GET');
