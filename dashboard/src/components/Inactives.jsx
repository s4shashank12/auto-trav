import { useState } from 'react';
import { timeAgo, usePoll } from '../util.js';

const TRIBES = {
  1: 'Romans', 2: 'Teutons', 3: 'Gauls', 4: 'Nature', 5: 'Natars', 6: 'Egyptians', 7: 'Huns', 8: 'Spartans', 9: 'Vikings',
};

// Inactive players near this account, from the game world's daily map.sql, and the controls for
// raiding them.
export default function Inactives({ client, server, onChanged }) {
  const { data, error } = usePoll(() => client.inactives(server.id), 60_000, [client, server.id, server.updatedAt]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const cfg = server.effectiveConfig?.inactive;
  const own = server.config?.inactive ?? {};
  const excluded = cfg?.excludePlayers ?? [];

  async function patchInactive(changes, message) {
    setBusy(true);
    setNotice(null);
    try {
      await client.updateServer(server.id, { config: { ...server.config, inactive: { ...own, ...changes } } });
      setNotice(message);
      onChanged?.();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function action(name, message) {
    setNotice(null);
    try {
      await client.action(server.id, name);
      setNotice(message);
    } catch (err) {
      setNotice(err.message);
    }
  }

  const exclude = (player) => patchInactive({ excludePlayers: [...new Set([...excluded, player])] }, `${player} will be skipped.`);
  const include = (player) => patchInactive({ excludePlayers: excluded.filter((p) => p !== player) }, `${player} can be raided again.`);
  const raids = server.snapshot?.inactiveRaids ?? [];

  return (
    <div className="stack">
      <div className="card">
        <div className="row between wrap">
          <div>
            <h3>Raiding inactive players is {cfg?.enabled ? 'on' : 'off'}</h3>
            <p className="muted small">
              A player counts as inactive when their total population has not grown for {cfg?.days} days.
              Villages within {cfg?.radius} fields with {cfg?.minPop}-{cfg?.maxPop} population are raided every
              {' '}{cfg?.everyMinutes} min{cfg?.hours ? `, between ${cfg.hours} h (${cfg.timezone})` : ''}.
              Tune it under Settings → Inactive players.
            </p>
          </div>
          <div className="row">
            <button type="button" className="btn small" onClick={() => action('world', 'Importing world data. Follow it in Logs.')}>Import world data</button>
            {cfg?.enabled && <button type="button" className="btn small" onClick={() => action('inactive-raid', 'Raiding inactives. Follow it in Logs.')}>Raid now</button>}
            <button
              type="button"
              className={`btn ${cfg?.enabled ? '' : 'primary'}`}
              disabled={busy}
              onClick={() => patchInactive({ enabled: !cfg?.enabled }, cfg?.enabled ? 'Inactive raiding switched off.' : 'Inactive raiding switched on; lists are set up after the next world import.')}
            >
              {cfg?.enabled ? 'Switch off' : 'Switch on'}
            </button>
          </div>
        </div>
        {notice && <p className="notice">{notice}</p>}
        {error && <p className="error">{error.message}</p>}
      </div>

      {data && !data.ready && (
        <div className="card">
          <h3>Collecting world data</h3>
          <p className="muted">
            {data.reason === 'no-villages'
              ? 'Refresh villages first so the bot knows where your villages are.'
              : `Inactive players show up once there are ${data.needDays} daily snapshots to compare (${data.days} so far). The bot imports one a day automatically.`}
          </p>
        </div>
      )}

      {data?.ready && (
        <div className="card">
          <div className="row between wrap">
            <h3>{data.targets.length} villages of {data.players.length} inactive players</h3>
            <p className="muted small">Compared {data.base} with {data.latest}{server.snapshot?.inactives?.updatedAt ? ` · lists updated ${timeAgo(server.snapshot.inactives.updatedAt)}` : ''}</p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Player</th><th>Alliance</th><th>Village</th><th className="num">Coordinates</th><th className="num">Population</th>
                  <th className="num">Player growth</th><th className="num">Distance</th><th>From</th><th />
                </tr>
              </thead>
              <tbody>
                {data.targets.map((t) => (
                  <tr key={t.vid}>
                    <td>{t.player} <span className="muted small">{TRIBES[t.tribe] ?? ''}</span></td>
                    <td>{t.alliance || <span className="muted">—</span>}</td>
                    <td>{t.village}</td>
                    <td className="num">({t.x}|{t.y})</td>
                    <td className="num">{t.population}</td>
                    <td className="num">{t.playerChange}</td>
                    <td className="num">{t.dist}</td>
                    <td>{t.from}</td>
                    <td><button type="button" className="link small" disabled={busy} onClick={() => exclude(t.player)}>Skip player</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {excluded.length > 0 && (
        <div className="card">
          <h3>Skipped players</h3>
          <div className="row wrap">
            {excluded.map((p) => (
              <span key={p} className="chip">{p} <button type="button" className="link small" onClick={() => include(p)}>undo</button></span>
            ))}
          </div>
        </div>
      )}

      {raids.length > 0 && (
        <div className="card">
          <h3>Last inactive raid {server.snapshot?.lastInactiveRaidAt ? <span className="muted small">{timeAgo(server.snapshot.lastInactiveRaidAt)}</span> : null}</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Village</th><th>Farm list</th><th className="num">Targets</th><th className="num">Being raided</th><th className="num">Sent</th><th className="num">Waiting for troops</th></tr></thead>
              <tbody>
                {raids.map((r) => (
                  <tr key={r.list + r.village}><td>{r.village}</td><td>{r.list}</td><td className="num">{r.targets}</td><td className="num">{r.running}</td><td className="num">{r.sent}</td><td className="num">{r.waiting}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
