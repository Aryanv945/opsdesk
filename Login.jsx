import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export default function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const demo = useQuery({ queryKey: ['demo-users'], queryFn: () => api.get('/auth/demo-users'), retry: false });

  async function submit(e, creds = { email, password }) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.login(creds.email, creds.password);
      onLogin(user);
    } catch (err) {
      setError(err.status === 401 ? 'That email and password don\'t match an account.' : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <section className="login-card">
        <h1 className="wordmark">OpsDesk</h1>
        <p className="muted">Operational work, in one place.</p>
        <form onSubmit={submit} className="stack">
          <label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </section>
      {demo.data?.users?.length > 0 && (
        <section className="demo">
          <h2>Demo accounts</h2>
          <p className="muted">Each account has different team roles. Sign in as two people in separate browsers to see live updates and conflicts.</p>
          <ul>
            {demo.data.users.map((u) => (
              <li key={u.email}>
                <button className="demo-user" disabled={busy} onClick={() => submit(null, { email: u.email, password: 'password' })}>
                  <strong>{u.name}</strong>
                  <span className="muted">{u.is_admin ? 'Admin, all teams' : u.roles}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
