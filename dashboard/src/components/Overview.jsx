import { timeAgo } from '../util.js';

function Table({ columns, rows, empty }) {
  if (!rows?.length) return <p className="muted small">{empty}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{columns.map(([key, label, cls]) => <th key={key} className={cls}>{label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <tr key={i}>{columns.map(([key, , cls, render]) => <td key={key} className={cls}>{render ? render(row) : row[key]}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Overview({ snapshot, config }) {
  if (!snapshot) {
    return <p className="muted">No data yet. Start the bot or press “Refresh villages”.</p>;
  }
  const queues = snapshot.queues ?? {};
  const villages = (snapshot.villages ?? []).map((v) => ({ ...v, queue: queues[v.name] }));
  const limit = config?.build?.populationLimit;
  return (
    <div className="stack">
      <p className="muted small">Updated {timeAgo(snapshot.updatedAt)}{snapshot.lastWaveAt ? ` · last raid wave ${timeAgo(snapshot.lastWaveAt)}` : ''}</p>

      <div className="card">
        <h3>Villages</h3>
        <Table
          empty="No villages seen yet."
          rows={villages}
          columns={[
            ['name', 'Village', '', (v) => <>{v.name}{v.capital && <span className="tag">capital</span>}</>],
            ['coords', 'Coordinates', 'num', (v) => `(${v.x}|${v.y})`],
            ['population', 'Population', 'num', (v) => v.population?.toLocaleString()],
            ['develop', 'Building', '', (v) => (v.develop ? 'developing' : <span className="muted">{limit ? `${limit}+ pop, left alone` : 'left alone'}</span>)],
            ['queue', 'Build queue', '', (v) => (v.queue?.length
              ? v.queue.map((q) => `${q.name}${q.minutes != null ? ` (${q.minutes} min)` : ''}`).join(' · ')
              : <span className="muted">{v.develop ? 'empty' : '—'}</span>)],
          ]}
        />
      </div>

      <div className="card">
        <h3>Raids (last wave)</h3>
        <Table
          empty="No raid wave yet. Run “Farm list setup” to create the bot's farm lists."
          rows={snapshot.raids}
          columns={[
            ['village', 'Village'],
            ['list', 'Farm list'],
            ['targets', 'Targets', 'num'],
            ['running', 'Being raided', 'num'],
            ['sent', 'Sent', 'num'],
            ['waiting', 'Waiting for troops', 'num'],
            ['unsafe', 'Skipped (animals/owner)', 'num'],
          ]}
        />
      </div>

      <div className="card">
        <h3>Training</h3>
        <Table
          empty="No training round yet."
          rows={snapshot.training}
          columns={[
            ['village', 'Village'],
            ['building', 'Building'],
            ['unit', 'Unit'],
            ['queuedMinutes', 'Queued (min)', 'num'],
            ['trained', 'Added', 'num'],
            ['note', 'Note', '', (r) => r.note ?? ''],
          ]}
        />
      </div>
    </div>
  );
}
