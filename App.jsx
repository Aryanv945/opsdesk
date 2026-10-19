import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './lib/api';
import { LiveProvider } from './lib/live';
import Login from './pages/Login';
import Shell from './components/Shell';
import Dashboard from './pages/Dashboard';
import Work from './pages/Work';

export default function App() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get('/me'), retry: false, staleTime: Infinity });

  useEffect(() => {
    const onUnauth = () => qc.setQueryData(['me'], null);
    window.addEventListener('opsdesk:unauthenticated', onUnauth);
    return () => window.removeEventListener('opsdesk:unauthenticated', onUnauth);
  }, [qc]);

  if (me.isPending) return <div className="boot">Loading OpsDesk…</div>;
  const user = me.data?.user;
  if (!user) return <Login onLogin={(u) => {
    // Drop anything cached for a previous user before showing the new one.
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    qc.setQueryData(['me'], { user: u });
  }} />;

  return (
    <LiveProvider me={user}>
      <Shell me={user}>
        <Routes>
          <Route path="/" element={<Dashboard me={user} />} />
          <Route path="/work" element={<Work me={user} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
    </LiveProvider>
  );
}
