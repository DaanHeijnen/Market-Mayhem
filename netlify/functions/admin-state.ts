import { getAdminState } from '../lib/queries';
import { requireAdmin } from '../lib/auth';
import { ok } from '../lib/http';
import { wrap, gameIdFrom } from './_wrap';

export default wrap(async (request) => {
  await requireAdmin(request);
  return ok(await getAdminState(gameIdFrom(request)));
}, 'GET');
