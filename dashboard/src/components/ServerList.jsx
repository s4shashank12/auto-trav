import { useState } from 'react';
import {
  hostOf, timeAgo, timeUntil, usePoll,
} from '../util.js';
import { Icon, StatTile, StatusBadge } from './ui.jsx';

function summary(snapshot) {
  const villages = snapshot?.villages ?? [];
  const pop = villages.reduce((n, v) => n + (v.population ?? 0), 0);
  const raids = snapshot?.raids ?? [];
  const running = raids.reduce((n, r) => n + r.running, 0);
  const targets = raids.reduce((n, r) => n + r.targets, 0);
  return { villages: villages.length, pop, running, targets };
}

export default function ServerList({ client }) {
  const [tick, setTick] = useState(0);
  const { data: servers, error, loading } = usePoll(() => client.servers(), 10_000, [client, tick]);
  const [busy, setBusy] = useState(null);

  async function toggle(server) {
    setBusy(server.id);
    try {
      if (server.enabled) await client.stop(server.id);
      else await client.start(server.id);
      setTick((t) => t + 1);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Servers</h1>
          <p className="muted small">Every Travian account this backend plays.</p>
        </div>
        <a className="btn primary" href="#/new"><Icon name="plus" /> Add server</a>
      </div>
      {error && <p className="error">{error.message}</p>}
      {loading && !servers && <p className="muted">Loading…</p>}
      {servers?.length === 0 && (
        <div className="card empty">
          <p>No Travian accounts yet.</p>
          <a className="btn primary" href="#/new">Add your first server</a>
        </div>
      )}
      <div className="grid">
        {servers?.map((s) => {
          const sum = summary(s.snapshot);
          return (
            <article key={s.id} className="card server-card">
              <div className="server-card-head">
                <a className="server-name" href={`#/servers/${s.id}`}>{s.name}</a>
                <StatusBadge status={s.status} />
              </div>
              <p className="muted small">{hostOf(s.url)} · {s.username}</p>
              {s.statusMessage && <p className={`small ${s.status === 'error' || s.status === 'captcha' ? 'error' : 'muted'}`}>{s.statusMessage}</p>}
              <div className="kpis mini">
                <StatTile label="Villages" value={sum.villages || '—'} />
                <StatTile label="Population" value={sum.pop || '—'} />
                <StatTile label="Oases raided" value={sum.targets ? `${sum.running}/${sum.targets}` : '—'} />
              </div>
              <p className="muted small">
                Last round {timeAgo(s.lastPassAt)}
                {s.nextRunAt && s.enabled ? ` · next ${timeUntil(s.nextRunAt)}` : ''}
                {s.config?.dryRun ? ' · dry run' : ''}
              </p>
              <div className="row">
                <button type="button" className={`btn ${s.enabled ? '' : 'primary'}`} disabled={busy === s.id} onClick={() => toggle(s)}>
                  <Icon name={s.enabled ? 'stop' : 'play'} />
                  {s.enabled ? 'Stop' : 'Start'}
                </button>
                <a className="btn ghost" href={`#/servers/${s.id}`}>Open</a>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
