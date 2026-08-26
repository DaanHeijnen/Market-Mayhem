import { getStore } from '@netlify/blobs';
import { requireAdmin } from '../lib/auth';
import { ok, intValue, HttpError } from '../lib/http';
import { randomToken } from '../lib/security';
import { BLOB_STORE, assertAcceptableMedia, buildMediaKey, mediaKindValue } from '../lib/media';
import { wrap } from './_wrap';

// Upload a picture-round image or a music-round audio file. Returns the blob key,
// which the Admin then saves onto the block via upsert-round-block. Deliberately not
// coupled to a block id, so a file can be picked before the block exists.
export default wrap(async request => {
  await requireAdmin(request);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, 'Expected a multipart form upload');
  }

  const gameId = intValue(form.get('gameId'), 'gameId', { min: 1 });
  const kind = mediaKindValue(form.get('kind'));
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(400, 'No file was attached');

  const contentType = assertAcceptableMedia(kind, file.type, file.size, file.name);
  const key = buildMediaKey(gameId, kind, contentType, randomToken(8));

  const store = getStore(BLOB_STORE);
  await store.set(key, await file.arrayBuffer(), {
    metadata: { contentType, name: file.name || '', gameId, uploadedAt: new Date().toISOString() },
  });

  return ok({ key, name: file.name || '', contentType, size: file.size });
});
