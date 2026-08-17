export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store, max-age=0');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function ok(data: unknown, init: ResponseInit = {}) {
  return json(data, { status: 200, ...init });
}

export function created(data: unknown, init: ResponseInit = {}) {
  return json(data, { status: 201, ...init });
}

export function errorResponse(error: unknown) {
  if (error instanceof HttpError) {
    return json({ error: error.message, details: error.details }, { status: error.status });
  }
  console.error(error);
  return json({ error: 'Internal server error' }, { status: 500 });
}

export async function body<T extends Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

export function requireMethod(request: Request, ...allowed: string[]) {
  if (!allowed.includes(request.method.toUpperCase())) {
    throw new HttpError(405, `Method ${request.method} not allowed`);
  }
}

export function intValue(value: unknown, field: string, options: { min?: number; max?: number } = {}) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed)) throw new HttpError(400, `${field} must be an integer`);
  if (options.min !== undefined && parsed < options.min) throw new HttpError(400, `${field} must be at least ${options.min}`);
  if (options.max !== undefined && parsed > options.max) throw new HttpError(400, `${field} must be at most ${options.max}`);
  return parsed;
}

export function textValue(value: unknown, field: string, max = 500) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} is required`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new HttpError(400, `${field} is too long`);
  return trimmed;
}

export function requestIdempotencyKey(request: Request, fallback?: unknown) {
  const key = request.headers.get('idempotency-key') || (typeof fallback === 'string' ? fallback : '');
  if (!key || key.length > 160) throw new HttpError(400, 'A valid Idempotency-Key header is required');
  return key;
}
