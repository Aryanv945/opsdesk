import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Subscribes to the server's activity stream (SSE).
 *
 * Detail views and counts refresh immediately. Lists do NOT reshuffle under the
 * user's cursor: they collect a count of incoming changes and offer a refresh,
 * so a row never jumps away right before someone clicks it.
 */
const LiveContext = createContext({ status: 'connecting', listChanges: 0, resetListChanges: () => {} });

export function LiveProvider({ me, children }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState('connecting');
  const [listChanges, setListChanges] = useState(0);
  const pending = useRef({ dashboard: false, notifications: false, timer: null });

  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onopen = () => setStatus('live');
    es.onerror = () => setStatus(es.readyState === EventSource.CLOSED ? 'offline' : 'reconnecting');

    const flush = () => {
      const p = pending.current;
      if (p.dashboard) qc.invalidateQueries({ queryKey: ['dashboard'] });
      if (p.notifications) qc.invalidateQueries({ queryKey: ['notifications'] });
      p.dashboard = p.notifications = false;
      p.timer = null;
    };

    es.addEventListener('activity', (msg) => {
      const ev = JSON.parse(msg.data);
      qc.invalidateQueries({ queryKey: ['item', ev.itemId] });
      qc.invalidateQueries({ queryKey: ['activity', ev.itemId] });
      const p = pending.current;
      p.dashboard = true;
      p.notifications = true;
      // Coalesce bursts (e.g. many people working at once) into one refetch.
      if (!p.timer) p.timer = setTimeout(flush, 1500);
      if (ev.actor.id !== me.id) setListChanges((n) => n + 1);
    });

    return () => { es.close(); clearTimeout(pending.current.timer); };
  }, [qc, me.id]);

  const resetListChanges = useCallback(() => setListChanges(0), []);
  return <LiveContext.Provider value={{ status, listChanges, resetListChanges }}>{children}</LiveContext.Provider>;
}

export const useLive = () => useContext(LiveContext);
