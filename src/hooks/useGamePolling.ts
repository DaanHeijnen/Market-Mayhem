import { useCallback, useEffect, useRef, useState } from 'react';
import { getLivePollDelay, LIVE_CONFIG, type LivePollKind } from '../config/live';
import { api, ApiError } from '../lib/api';

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

export function useGamePolling<T>(gameId: number, kind: LivePollKind, endpoint: string, active = false) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const version = useRef<number | null>(null);
  const latestData = useRef<T | null>(null);
  const polling = useRef(false);
  const accessBlocked = useRef(false);
  const pollController = useRef<AbortController | null>(null);
  const snapshotController = useRef<AbortController | null>(null);
  const snapshotPromise = useRef<Promise<T | null> | null>(null);
  // Server-reported "nothing can change on its own" signal, used to pick the poll
  // interval. Starts false so a fresh client polls at the live rate until told otherwise.
  const gameIdle = useRef(false);
  // Last time anyone touched this tab. A tab left open on a desk is visible, so the
  // visibility check never fires and it would otherwise poll forever.
  const lastInteraction = useRef(Date.now());
  const stats = useRef({ polls: 0, refreshes: 0, lastPoll: 0, lastRefresh: 0 });

  const loadSnapshot = useCallback((force = false) => {
    // Deduplicate concurrent callers onto one in-flight request — but never onto an
    // aborted one. An aborted snapshot resolves to null, so a caller that piggybacked on
    // it would get no data and then sit idle until the next poll tick. That is how the
    // projector could come up showing only "MARKET MAYHEM": React's development
    // double-mount aborts the first snapshot, the second mount reused that same dead
    // promise, and nothing rendered until a whole poll interval later.
    const inFlightAborted = snapshotController.current?.signal.aborted ?? false;
    if (snapshotPromise.current && !force && !inFlightAborted) return snapshotPromise.current;
    if (force) snapshotController.current?.abort();

    const controller = new AbortController();
    snapshotController.current = controller;
    let run!: Promise<T | null>;
    run = api<T>(endpoint, { signal: controller.signal })
      .then((next) => {
        if (controller.signal.aborted) return null;
        accessBlocked.current = false;
        latestData.current = next;
        setData(next);
        const nextVersion = (next as { version?: unknown })?.version;
        if (typeof nextVersion === 'number') version.current = nextVersion;
        stats.current.refreshes += 1;
        stats.current.lastRefresh = Date.now();
        setError('');
        return next;
      })
      .catch((err: unknown) => {
        if (isAbort(err)) return null;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          accessBlocked.current = true;
          latestData.current = null;
          version.current = null;
          setData(null);
        }
        throw err;
      })
      .finally(() => {
        if (snapshotPromise.current === run) snapshotPromise.current = null;
        if (snapshotController.current === controller) snapshotController.current = null;
      });
    snapshotPromise.current = run;
    return run;
  }, [endpoint]);

  // User actions need a fresh post-mutation snapshot. Abort a stale version poll
  // and any older snapshot before starting that authoritative refresh.
  const refresh = useCallback(() => {
    pollController.current?.abort();
    return loadSnapshot(true);
  }, [loadSnapshot]);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;

    const mobileIsActive = () => {
      if (active) return true;
      if (kind !== 'mobile') return false;
      return Boolean((latestData.current as { actionable?: unknown } | null)?.actionable);
    };

    const isVisible = () => document.visibilityState !== 'hidden';
    const interval = () => getLivePollDelay(
      kind,
      mobileIsActive(),
      document.visibilityState,
      gameIdle.current,
      Date.now() - lastInteraction.current,
    );

    const clearTimer = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const schedule = (delay: number | null) => {
      clearTimer();
      if (!stopped && !accessBlocked.current && delay !== null) timer = window.setTimeout(tick, delay);
    };

    const tick = async () => {
      timer = undefined;
      if (stopped || accessBlocked.current || !isVisible()) return;
      if (polling.current) {
        schedule(interval());
        return;
      }

      polling.current = true;
      let failed = false;
      const controller = new AbortController();
      pollController.current = controller;
      try {
        stats.current.polls += 1;
        stats.current.lastPoll = Date.now();
        const current = await api<{ version: number; idle?: boolean }>(`/api/game-version?gameId=${gameId}`, { signal: controller.signal });
        gameIdle.current = Boolean(current.idle);
        if (version.current === null || current.version !== version.current) await loadSnapshot(false);
        if (!controller.signal.aborted) setError('');
      } catch (err) {
        if (!isAbort(err)) {
          failed = true;
          setError(err instanceof Error ? err.message : 'LIVE CONNECTION INTERRUPTED');
        }
      } finally {
        if (pollController.current === controller) pollController.current = null;
        polling.current = false;
        if (!stopped && !accessBlocked.current && isVisible()) {
          schedule(failed ? LIVE_CONFIG.ERROR_RETRY_MS : interval());
        }
      }
    };

    const resume = async () => {
      clearTimer();
      if (stopped || accessBlocked.current || !isVisible()) return;
      try {
        await loadSnapshot(false);
        if (!stopped && !accessBlocked.current && LIVE_CONFIG.ENABLE_POLLING) schedule(interval());
      } catch (err) {
        if (!stopped) setError(err instanceof Error ? err.message : 'LIVE CONNECTION INTERRUPTED');
        if (!stopped && !accessBlocked.current && LIVE_CONFIG.ENABLE_POLLING) schedule(LIVE_CONFIG.ERROR_RETRY_MS);
      }
    };

    void resume();

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        clearTimer();
        pollController.current?.abort();
        return;
      }
      lastInteraction.current = Date.now();
      pollController.current?.abort();
      void resume();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    // Any sign of a person restarts the clock, and restarts polling if the away rule had
    // stopped it. Without this a tab that went dormant would never come back on its own.
    const onInteraction = () => {
      const wasAway = Date.now() - lastInteraction.current >= LIVE_CONFIG.AWAY_AFTER_MS;
      lastInteraction.current = Date.now();
      if (wasAway && timer === undefined && !polling.current) void resume();
    };
    const INTERACTION_EVENTS = ['pointerdown', 'keydown', 'focus', 'wheel', 'touchstart'] as const;
    // passive: these must never delay input, and the handler is trivial.
    INTERACTION_EVENTS.forEach(name => window.addEventListener(name, onInteraction, { passive: true }));

    return () => {
      stopped = true;
      clearTimer();
      pollController.current?.abort();
      snapshotController.current?.abort();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      INTERACTION_EVENTS.forEach(name => window.removeEventListener(name, onInteraction));
    };
  }, [active, gameId, kind, loadSnapshot]);

  return { data, error, refresh, stats: stats.current };
}
