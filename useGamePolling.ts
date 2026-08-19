import { useCallback, useEffect, useRef, useState } from 'react';
import { LIVE_CONFIG } from '../config/live';
import { api, ApiError } from '../lib/api';

type Kind = 'screen' | 'admin' | 'mobile';

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

export function useGamePolling<T>(gameId: number, kind: Kind, endpoint: string, active = false) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const version = useRef<number | null>(null);
  const latestData = useRef<T | null>(null);
  const polling = useRef(false);
  const pollController = useRef<AbortController | null>(null);
  const snapshotController = useRef<AbortController | null>(null);
  const snapshotPromise = useRef<Promise<T | null> | null>(null);
  const stats = useRef({ polls: 0, refreshes: 0, lastPoll: 0, lastRefresh: 0 });

  const loadSnapshot = useCallback((force = false) => {
    if (snapshotPromise.current && !force) return snapshotPromise.current;
    if (force) snapshotController.current?.abort();

    const controller = new AbortController();
    snapshotController.current = controller;
    let run!: Promise<T | null>;
    run = api<T>(endpoint, { signal: controller.signal })
      .then((next) => {
        if (controller.signal.aborted) return null;
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
      return Boolean((latestData.current as any)?.actionable);
    };

    const interval = () => {
      if (document.visibilityState === 'hidden') return LIVE_CONFIG.HIDDEN_TAB_POLL_MS;
      if (kind === 'screen') return LIVE_CONFIG.BIG_SCREEN_POLL_MS;
      if (kind === 'admin') return LIVE_CONFIG.ADMIN_POLL_MS;
      return mobileIsActive() ? LIVE_CONFIG.MOBILE_ACTIVE_POLL_MS : LIVE_CONFIG.MOBILE_IDLE_POLL_MS;
    };

    const schedule = (delay: number) => {
      if (!stopped) timer = window.setTimeout(tick, delay);
    };

    const tick = async () => {
      if (stopped) return;
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
        const current = await api<{ version: number }>(`/api/game-version?gameId=${gameId}`, { signal: controller.signal });
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
        schedule(failed ? LIVE_CONFIG.ERROR_RETRY_MS : interval());
      }
    };

    void loadSnapshot(false).catch((err: unknown) => {
      if (!stopped) setError(err instanceof Error ? err.message : 'LIVE CONNECTION INTERRUPTED');
    });
    if (LIVE_CONFIG.ENABLE_POLLING) schedule(interval());

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        pollController.current?.abort();
        void loadSnapshot(false).catch((err: unknown) => {
          if (!stopped) setError(err instanceof Error ? err.message : 'LIVE CONNECTION INTERRUPTED');
        });
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      pollController.current?.abort();
      snapshotController.current?.abort();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [active, gameId, kind, loadSnapshot]);

  return { data, error, refresh, stats: stats.current };
}
