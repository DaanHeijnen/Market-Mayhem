import { requireAdmin } from '../lib/auth';
import { getSlotConfig } from '../lib/slot-store';
import { ok } from '../lib/http';
import { wrap, gameIdFrom } from './_wrap';

export default wrap(async (request) => {
  await requireAdmin(request);
  return ok(await getSlotConfig(gameIdFrom(request)));
}, 'GET');
