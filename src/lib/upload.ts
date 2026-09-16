/**
 * Getting a phone photo to the server, and reading what comes back.
 *
 * Two problems live here, and they produced the same symptom: "Failed to execute 'json' on
 * 'Response': Unexpected end of JSON input".
 *
 * The first is size. A Netlify Function request body is capped at roughly 6 MB, and the
 * platform rejects an oversized upload *before the handler runs* — so the reply is not our
 * JSON error, it is an empty or HTML platform response. A modern phone camera produces
 * 3–8 MB per shot, so this was not an edge case, it was most photos. Downscaling in the
 * browser is the actual fix: a 4000px original becomes a ~1600px JPEG of a few hundred
 * kilobytes, which also uploads far faster on venue wifi.
 *
 * The second is that the client called `response.json()` unconditionally, before checking
 * `response.ok`. Any non-JSON reply — the platform's, a proxy's, a gateway timeout —
 * became a parse error rather than the message it actually carried. That is worth fixing on
 * its own: a client should never turn a server's "too large" into a stack trace.
 */

/** Comfortably inside the platform's body limit, with room for multipart overhead. */
export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

/** Long edge of a downscaled photo. Plenty for a projector; a fraction of the bytes. */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.82;

/**
 * Parse a response without assuming it is JSON.
 *
 * Returns the decoded body when it is JSON and a usable message when it is not, so a
 * platform rejection reads as "that photo is too large" rather than as a parse failure.
 * This does not paper over a broken server contract — ours always returns JSON — it covers
 * the replies that never reach our code at all.
 */
export async function readJsonResponse(response: Response): Promise<{ ok: boolean; data: any; error: string }> {
  const text = await response.text().catch(() => '');
  let data: any = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (response.ok && data) return { ok: true, data, error: '' };
  if (response.ok) return { ok: true, data: null, error: '' };

  if (data && typeof data.error === 'string') return { ok: false, data, error: data.error };
  if (response.status === 413) return { ok: false, data: null, error: 'Die foto is te groot voor de server.' };
  if (response.status === 401 || response.status === 403) return { ok: false, data: null, error: 'Je sessie is verlopen — open je join-link opnieuw.' };
  return { ok: false, data: null, error: `Uploaden mislukt (${response.status}).` };
}

/**
 * Shrink a photo so it fits, in the browser, before anything is sent.
 *
 * Returns the original untouched when it is already small enough or is not something the
 * canvas can decode — a file that cannot be drawn is better refused by the server with a
 * real message than mangled here.
 */
export async function prepareImageForUpload(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  if (file.size <= MAX_UPLOAD_BYTES) return file;

  const bitmap = await loadBitmap(file);
  if (!bitmap) return file;

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return file;
  context.drawImage(bitmap as CanvasImageSource, 0, 0, width, height);

  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
  if (!blob || blob.size >= file.size) return file;

  const name = file.name.replace(/\.[^.]+$/, '') || 'photo';
  return new File([blob], `${name}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement | null> {
  // createImageBitmap handles EXIF orientation on every browser that has it, which an
  // <img> does not always do — a portrait photo uploaded sideways is its own bug report.
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' } as any); } catch { /* fall through */ }
  }
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    image.src = url;
  });
}
