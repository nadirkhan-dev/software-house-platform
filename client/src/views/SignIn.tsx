import { useState } from 'react';
import { useSession } from '../lib/session';
import { ApiError } from '../lib/api';
import { Field } from '../components/ui';

const DEMO = [
  ['ayesha@kdc.pk', 'Ayesha Siddiqui', 'admin · everything'],
  ['nadia@kdc.pk', 'Nadia Farooq', 'finance · invoicing and payments'],
  ['sana@kdc.pk', 'Sana Malik', 'developer · no money at all'],
  ['procurement@northwind.example', 'Dana Whitfield', 'client · one client only'],
  ['rehan@lahorelabs.pk', 'Rehan Aslam', 'a second agency entirely'],
] as const;

export function SignIn() {
  const { signIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const go = async (e: string, p: string) => {
    setBusy(true); setError('');
    try { await signIn(e, p); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Could not sign in'); }
    finally { setBusy(false); }
  };

  return (
    <div className="signin">
      <div className="signin-card">
        <div className="brand"><b>Marginly</b><span>v1.0</span></div>
        <div className="brandrule" />
        <form onSubmit={e => { e.preventDefault(); void go(email, password); }}>
          {error && <div className="err">{error}</div>}
          <Field label="Email">
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              autoComplete="username" required autoFocus /></Field>
          <Field label="Password">
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              autoComplete="current-password" required /></Field>
          <button className="btn pri" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>

          <div className="demo">
            <div className="eyebrow">Or sign in as someone from the demo agency</div>
            {DEMO.map(([e, name, hint]) => (
              <button key={e} type="button" disabled={busy} onClick={() => void go(e, 'marginly')}>
                <b>{name}</b><span>{hint}</span>
              </button>
            ))}
          </div>
        </form>
      </div>
    </div>
  );
}
