import { errorResponse, HttpError, intValue } from '../lib/http';

type Handler = (request: Request) => Promise<Response>;
type Method = 'GET' | 'POST';

export const wrap = (fn: Handler, method: Method = 'POST') => async (request: Request) => {
  try {
    if (request.method.toUpperCase() !== method) {
      throw new HttpError(405, `Method ${request.method} not allowed`);
    }
    return await fn(request);
  } catch (error) {
    return errorResponse(error);
  }
};

export const gameIdFrom = (request: Request) => {
  const value = new URL(request.url).searchParams.get('gameId');
  return intValue(value, 'gameId', { min: 1 });
};
