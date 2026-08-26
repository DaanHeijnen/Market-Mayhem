import { getStore } from '@netlify/blobs';
import { HttpError } from '../lib/http';
import { BLOB_STORE, mediaKeyValue } from '../lib/media';
import { wrap } from './_wrap';

// Serve a round-block image or audio file.
//
// Public and deliberately touches no database: the projector, the Admin preview and
// every phone may all request the same image at once, and none of that should turn into
// database load. Keys carry a random segment so they are not guessable from a block id.
export default wrap(async request => {
  const key = mediaKeyValue(new URL(request.url).searchParams.get('key'));
  const store = getStore(BLOB_STORE);
  const blob = await store.getWithMetadata(key, { type: 'arrayBuffer' });
  if (!blob) throw new HttpError(404, 'Media not found');

  const contentType = typeof blob.metadata?.contentType === 'string' ? blob.metadata.contentType : 'application/octet-stream';
  return new Response(blob.data as ArrayBuffer, {
    headers: {
      'content-type': contentType,
      // Keys are content-addressed by their random segment, so a key's bytes never
      // change and this can be cached hard.
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
}, 'GET');
