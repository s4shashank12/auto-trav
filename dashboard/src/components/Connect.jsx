import { useState } from 'react';
import { APP_VERSION, createClient, defaultApiUrl } from '../api.js';

export default function Connect({ onConnect }) {
  const [url, setUrl] = useState(defaultApiUrl());
  const [token, setToken] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const conn = { url: url.trim().replace(/\/+$/, ''), token: token.trim() };
    try {
      await createClient(conn).meta();
      onConnect(conn);
    } catch (err) {
      setError(err.status === 401 ? 'The API token is wrong.' : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="connect">
      <form className="card connect-card" onSubmit={submit}>
        <div className="brand large">
          <img src="/favicon.svg" alt="" width="32" height="32" />
          <span>Travian Bot Control</span>
        </div>
        <p className="muted">Connect to your bot backend. The URL and token are kept in this browser only.</p>
        <label className="field">
          <span>Backend URL</span>
          <input type="url" required placeholder="https://api.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="field">
          <span>API token</span>
          <input type="password" required autoComplete="current-password" value={token} onChange={(e) => setToken(e.target.value)} />
          <small className="muted">The ADMIN_TOKEN from the backend&apos;s .env file.</small>
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</button>
        <p className="muted small center">Dashboard v{APP_VERSION}</p>
      </form>
    </div>
  );
}
