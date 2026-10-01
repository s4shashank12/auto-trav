import { useState } from 'react';
import { isAndroid } from '../api.js';
import { navigate } from '../util.js';

// Add a server (Travian account on one game world), or edit its name and credentials.
export default function ServerForm({ client, server = null, onSaved }) {
  const editing = Boolean(server);
  const [form, setForm] = useState({
    name: server?.name ?? '',
    url: server?.url ?? '',
    username: server?.username ?? '',
    password: '',
    dryRun: server?.config?.dryRun ?? true,
    start: false,
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body = {
        name: form.name, url: form.url, username: form.username, password: form.password,
      };
      if (editing) {
        const saved = await client.updateServer(server.id, body);
        onSaved?.(saved);
      } else {
        const created = await client.createServer({ ...body, config: form.dryRun ? { dryRun: true } : {}, enabled: form.start });
        navigate(`/servers/${created.id}`);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={editing ? '' : 'narrow'}>
      {!editing && <h1>Add server</h1>}
      <form className="card form" onSubmit={submit}>
        <label className="field">
          <span>Name</span>
          <input required maxLength={60} placeholder="International 4" value={form.name} onChange={set('name')} />
        </label>
        <label className="field">
          <span>Game world URL</span>
          <input required type="url" placeholder="https://ts4.x1.international.travian.com" value={form.url} onChange={set('url')} />
          <small className="muted">The address in your browser after logging in to that world.</small>
        </label>
        <label className="field">
          <span>Account name or email</span>
          <input required autoComplete="off" value={form.username} onChange={set('username')} />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="new-password"
            required={!editing}
            placeholder={editing ? 'Leave empty to keep the current password' : ''}
            value={form.password}
            onChange={set('password')}
          />
          <small className="muted">
            {isAndroid
              ? 'Stored encrypted on this phone (with a key in the Android Keystore); never shown again.'
              : 'Stored encrypted on your backend; never shown again.'}
          </small>
        </label>
        {!editing && (
          <>
            <label className="check">
              <input type="checkbox" checked={form.dryRun} onChange={set('dryRun')} />
              <span>Dry run: log what the bot would do without clicking (turn off in Settings)</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={form.start} onChange={set('start')} />
              <span>Start the bot right away</span>
            </label>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save' : 'Add server'}</button>
          {!editing && <a className="btn ghost" href="#/">Cancel</a>}
        </div>
      </form>
    </section>
  );
}
