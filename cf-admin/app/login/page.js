'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, humanise } from '../../lib/api';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/login', { email, password });
      // replace(), not push() — the back button should not return to the login form.
      router.replace(params.get('next') || '/');
    } catch (err) {
      setError(humanise(err));
      setBusy(false);
    }
  }

  return (
    <main className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>Chevella Farms</h1>
        <p className="tag">Stall console — events, contact QRs and visiting-card leads.</p>

        {error && <div className="banner banner-err">{error}</div>}

        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <button type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="hint" style={{ marginTop: 16, textAlign: 'center' }}>
          Staff at the stall use the Android app and need no login.
        </p>
      </form>
    </main>
  );
}

export default function LoginPage() {
  // useSearchParams (for the ?next= redirect) opts the page out of prerendering unless
  // it sits behind a Suspense boundary.
  return (
    <Suspense fallback={<main className="login-wrap"><div className="login-card" /></main>}>
      <LoginForm />
    </Suspense>
  );
}
