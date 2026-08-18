import { useCallback, useEffect, useRef, useState } from 'react';
import { LIVE_CONFIG } from '../config/live';
import { api } from '../lib/api';

type Kind = 'screen' | 'admin' | 'mobile';

export function useGamePolling<T>(gameId: number, kind: Kind, endpoint: string, active = false) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const version = useRef<number | null>(null);
  const latestData = useRef<T | null>(null);
  const busy = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const stats = useRef({ polls: 0, refreshes: 0, lastPoll: 0, lastRefresh: 0 });

  const refresh = useCallback(async () => {
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;

    try {
      const next = await api<T>(endpoint, { signal: nextController.signal });
      latestData.current = next;
      setData(next);
      const nextVersion = (next as { version?: unknown })?.version;
      if (typeof nextVersion === 'number') version.current = nextVersion;
      stats.current.refreshes += 1;
      stats.current.lastRefresh = Date.now();
      setError('');
      return next;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null;
      throw err;
    }
  }, [endpoint]);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;

    const mobileIsActive = () => {
      if (active) return true;
      if (kind !== 'mobile') return false;
      const status = (latestData.current as any)?.prediction?.status;
      return status === 'VOTING' || status === 'BETTING';
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
      if (busy.current) {
        schedule(interval());
        return;
      }

      busy.current = true;
      let failed = false;
      try {
        stats.current.polls += 1;
        stats.current.lastPoll = Date.now();
        const current = await api<{ version: number }>(`/api/game-version?gameId=${gameId}`);
        if (version.current === null || current.version !== version.current) await refresh();
        setError('');
      } catch (err) {
        failed = true;
        setError(err instanceof Error ? err.message : 'LIVE CONNECTION INTERRUPTED');
      } finally {
        busy.current = false;
        schedule(failed ? LIVE_CONFIG.ERROR_RETRY_MS : interval());
      }
    };

    void refresh().catch((err: unknown) => {
      if (!stopped) setError(err instanceof Error ? err.message : 'LIVE CONNECTION INTERRUPTED');
    });

    if (LIVE_CONFIG.ENABLE_POLLING) schedule(interval());

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refresh().catch((err: unknown) => {
          if (!stopped) setError(err instanceof Error ? err.message : 'LIVE CONNECTION INTERRUPTED');
        });
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller.current?.abort();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [active, gameId, kind, refresh]);

  return { data, error, refresh, stats: stats.current };
}
