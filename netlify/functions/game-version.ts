import { getGameVersion } from '../lib/queries';
import { ok } from '../lib/http';
import { wrap, gameIdFrom } from './_wrap';

export default wrap(async (request) => ok({ version: await getGameVersion(gameIdFrom(request)) }), 'GET');
