import { useState } from 'react';
import {
  hostOf, navigate, timeAgo, timeUntil, usePoll,
} from '../util.js';
import Logs from './Logs.jsx';
import Overview from './Overview.jsx';
import Screenshots from './Screenshots.jsx';
import ServerForm from './ServerForm.jsx';
import Settings from './Settings.jsx';
import StatusBadge from './StatusBadge.jsx';

const TABS = [
  ['overview', 'Overview'],
  ['logs', 'Logs'],
  ['settings', 'Settings'],
  ['screenshots', 'Screenshots'],
  ['account', 'Account'],
];

const ACTION_LABELS = {
  build: 'Build now',
  train: 'Train now',
  raid: 'Raid wave now',
  'farm-setup': 'Farm list setup',
  villages: 'Refresh villages',
};

export default function ServerDetail({
  client, meta, id, tab,
}) {
  const [tick, setTick] = useState(0);
  const { data: server, error } = usePoll(() => client.server(id), 5000, [client, id, tick]);
  const [notice, setNotice] = useState(null);
  const refresh = () => setTick((t) => t + 1);

  async function run(fn, message) {
    setNotice(null);
    try {
      await fn();
      if (message) setNotice(message);
      refresh();
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete "${server.name}"? Its settings and logs are removed; the game account is not touched.`)) return;
    await run(() => client.deleteServer(id));
    navigate('/');
  }

  if (error && !server) return <p className="error">{error.message}</p>;
  if (!server) return <p className="muted">Loading…</p>;

  return (
    <section>
      <a className="muted small back" href="#/">← All servers</a>
      <div className="page-head">
        <div>
          <h1>{server.name} <StatusBadge status={server.status} /></h1>
          <p className="muted small">
            <a href={server.url} target="_blank" rel="noreferrer">{hostOf(server.url)}</a> · {server.username}
            {' · '}last round {timeAgo(server.lastPassAt)}
            {server.enabled && server.nextRunAt ? ` · next ${timeUntil(server.nextRunAt)}` : ''}
            {server.config?.dryRun ? ' · dry run' : ''}
          </p>
          {server.statusMessage && <p className={`small ${['error', 'captcha'].includes(server.status) ? 'error' : 'muted'}`}>{server.statusMessage}</p>}
        </div>
        <div className="row">
          {server.enabled
            ? <button type="button" className="btn" onClick={() => run(() => client.stop(id), 'Stopping after the current round…')}>Stop</button>
            : <button type="button" className="btn primary" onClick={() => run(() => client.start(id), 'Started.')}>Start</button>}
        </div>
      </div>

      <div className="row wrap actions">
        {(meta?.actions ?? Object.keys(ACTION_LABELS)).map((a) => (
          <button
            key={a}
            type="button"
            className="btn small"
            onClick={() => run(() => client.action(id, a), `${ACTION_LABELS[a] ?? a}: queued. Follow it in Logs.`)}
          >
            {ACTION_LABELS[a] ?? a}
          </button>
        ))}
      </div>
      {notice && <p className="notice">{notice}</p>}

      <nav className="tabs">
        {TABS.map(([key, label]) => (
          <a key={key} href={`#/servers/${id}/${key}`} className={tab === key ? 'active' : ''}>{label}</a>
        ))}
      </nav>

      {tab === 'overview' && <Overview snapshot={server.snapshot} config={server.effectiveConfig} />}
      {tab === 'logs' && <Logs client={client} id={id} />}
      {tab === 'settings' && <Settings client={client} meta={meta} server={server} onSaved={refresh} />}
      {tab === 'screenshots' && <Screenshots client={client} id={id} />}
      {tab === 'account' && (
        <div className="stack">
          <ServerForm client={client} server={server} onSaved={() => { setNotice('Saved.'); refresh(); }} />
          <div className="card danger">
            <h3>Delete server</h3>
            <p className="muted small">Removes it from the dashboard with its settings and logs. Nothing changes in the game.</p>
            <button type="button" className="btn danger" onClick={remove}>Delete</button>
          </div>
        </div>
      )}
    </section>
  );
}
