/**
 * Send one admin action and refresh.
 *
 * Resolves to the server's reply on success and to `false` on failure, so the common
 * `if (await run(...))` still reads as "did it work" while a caller that needs a value
 * from the reply can take one.
 */
export type RunMutation = (path: string, body: Record<string, unknown>, idempotent?: boolean, idempotencyKey?: string) => Promise<any>;
export type AdminState=any;
