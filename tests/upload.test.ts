import { describe, expect, it } from 'vitest';
import { readJsonResponse, MAX_UPLOAD_BYTES } from '../src/lib/upload';

/**
 * Reading an upload response.
 *
 * The bug this covers produced "Failed to execute 'json' on 'Response': Unexpected end of
 * JSON input" on every photo a phone took. Two causes, one symptom: the file was larger
 * than the platform accepts, so the rejection came from Netlify rather than from our
 * handler and carried no JSON body — and the client called `response.json()` before it
 * checked whether the request had even succeeded.
 *
 * Our own endpoints always return JSON. These are the replies that never reach them.
 */
const reply = (status: number, body: string, ok = status >= 200 && status < 300) => ({
  ok,
  status,
  text: async () => body,
}) as unknown as Response;

describe('reading an upload response', () => {
  it('returns the body when the server answered with JSON', async () => {
    const result = await readJsonResponse(reply(200, JSON.stringify({ submissionId: 4, mediaKey: '1/image/abc.jpg' })));
    expect(result).toEqual({ ok: true, data: { submissionId: 4, mediaKey: '1/image/abc.jpg' }, error: '' });
  });

  it('uses the server’s own message when it refuses', async () => {
    const result = await readJsonResponse(reply(409, JSON.stringify({ error: 'Submissions are closed' })));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Submissions are closed');
  });

  // The actual failure: the platform rejected the body before our handler ran, so there is
  // no JSON to read. This used to throw a parse error; now it says what happened.
  it('explains an empty rejection instead of throwing', async () => {
    const result = await readJsonResponse(reply(413, ''));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/te groot/i);
  });

  it('survives a reply that is HTML rather than JSON', async () => {
    const result = await readJsonResponse(reply(502, '<html><body>Bad gateway</body></html>'));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('502');
  });

  it('survives a truncated JSON body', async () => {
    const result = await readJsonResponse(reply(500, '{"error":'));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('500');
  });

  it('points an expired session at the join link rather than at a status code', async () => {
    for (const status of [401, 403]) {
      const result = await readJsonResponse(reply(status, ''));
      expect(result.error, String(status)).toMatch(/join-link/i);
    }
  });

  // A 204 is a success with no body. Rare here, but it must not read as a failure.
  it('treats a successful empty response as success', async () => {
    const result = await readJsonResponse(reply(204, ''));
    expect(result.ok).toBe(true);
    expect(result.error).toBe('');
  });
});

describe('the upload size ceiling', () => {
  // Comfortably inside the platform's ~6 MB request cap, with room for the multipart
  // envelope — anything at or under this reaches our handler, where our own limits apply.
  it('leaves room under the platform limit', () => {
    expect(MAX_UPLOAD_BYTES).toBeLessThan(6 * 1024 * 1024);
    expect(MAX_UPLOAD_BYTES).toBeGreaterThan(1024 * 1024);
  });
});
