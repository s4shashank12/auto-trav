import { timeAgo, timeUntil } from '../util.js';
import {
  Icon, Meter, StatTile,
} from './ui.jsx';

const sum = (list, key) => (list ?? []).reduce((n, x) => n + (x[key] ?? 0), 0);

function VillageCard({
  v, queue, training, raids, research, limit,
}) {
  const developing = v.develop;
  return (
    <article className="card village">
      <header className="village-head">
        <div>
          <h4>{v.name}{v.capital && <span className="tag">capital</span>}</h4>
          <span className="muted small">({v.x}|{v.y}) · {v.population?.toLocaleString()} pop</span>
        </div>
        <span className={`role ${developing ? 'role-build' : 'role-army'}`}>
          <Icon name={developing ? 'hammer' : 'castle'} size={12} />
          {developing ? 'Developing' : 'Army'}
        </span>
      </header>

      {developing && limit && (
        <div className="village-meter">
          <Meter value={v.population ?? 0} max={limit} label={`${v.name} population towards ${limit}`} />
          <span className="muted small">{v.population} / {limit} population</span>
        </div>
      )}

      {developing && (
        <ul className="lines">
          {queue?.length ? queue.map((q, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <li key={i}><Icon name="hammer" size={12} /> <span>{q.name}</span><span className="muted">{q.minutes != null ? `${q.minutes} min` : 'planned'}</span></li>
          )) : <li className="empty muted">Build queue empty</li>}
        </ul>
      )}

      {!developing && (
        <ul className="lines">
          {training.length ? training.map((t) => (
            <li key={t.building}>
              <Icon name="foot" size={12} />
              <span>{t.building}: {t.unit}</span>
              <span className="muted">{t.note ?? (t.trained ? `+${t.trained}` : `${t.queuedMinutes} min queued`)}</span>
            </li>
          )) : <li className="empty muted">No training round yet</li>}
        </ul>
      )}

      {research?.started && <p className="small st st-good"><Icon name="book" size={12} /> Researching {research.started}</p>}

      {raids.length > 0 && (
        <p className="small muted">
          <Icon name="target" size={12} /> {raids.length} farm list{raids.length > 1 ? 's' : ''} · {sum(raids, 'running')} of {sum(raids, 'targets')} oases being raided
        </p>
      )}
    </article>
  );
}

export default function Overview({ server, config }) {
  const snapshot = server.snapshot;
  if (!snapshot?.villages) {
    return (
      <div className="card empty">
        <Icon name="castle" size={28} />
        <p>No data yet. Start the bot, or use Run now → Refresh villages.</p>
      </div>
    );
  }
  const villages = snapshot.villages;
  const queues = snapshot.queues ?? {};
  const raids = snapshot.raids ?? [];
  const training = snapshot.training ?? [];
  const research = new Map((snapshot.research ?? []).map((r) => [r.village, r]));
  const limit = config?.build?.populationLimit;
  const jobs = Object.values(queues).reduce((n, q) => n + q.length, 0);

  return (
    <div className="stack">
      <div className="kpis">
        <StatTile label="Villages" value={villages.length} sub={`${villages.filter((v) => v.develop).length} developing`} />
        <StatTile label="Population" value={sum(villages, 'population')} />
        <StatTile label="Oases being raided" value={raids.length ? `${sum(raids, 'running')} / ${sum(raids, 'targets')}` : '—'} sub={snapshot.lastWaveAt ? `last wave ${timeAgo(snapshot.lastWaveAt)}` : null} />
        <StatTile label="Build jobs queued" value={jobs} />
        <StatTile label="Next round" value={server.enabled && server.nextRunAt ? timeUntil(server.nextRunAt) : '—'} sub={`updated ${timeAgo(snapshot.updatedAt)}`} />
      </div>

      <div className="village-grid">
        {villages.map((v) => (
          <VillageCard
            key={v.did ?? v.name}
            v={v}
            limit={limit}
            queue={queues[v.name]}
            training={training.filter((t) => t.village === v.name)}
            raids={raids.filter((r) => r.village === v.name)}
            research={research.get(v.name)}
          />
        ))}
      </div>

      {raids.length > 0 && (
        <section className="card">
          <h3>Last raid wave</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Village</th><th>Farm list</th><th className="num">Targets</th><th className="num">Being raided</th><th className="num">Sent</th><th className="num">Waiting for troops</th><th className="num">Skipped</th></tr>
              </thead>
              <tbody>
                {raids.map((r) => (
                  <tr key={r.list + r.village}>
                    <td>{r.village}</td><td>{r.list}</td><td className="num">{r.targets}</td><td className="num">{r.running}</td>
                    <td className="num">{r.sent}</td><td className="num">{r.waiting}</td><td className="num">{r.unsafe}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
