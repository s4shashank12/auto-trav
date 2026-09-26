import { useEffect, useRef, useState } from 'react';

// Live tail of the bot's log for one server.
export default function Logs({ client, id }) {
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  const [showDebug, setShowDebug] = useState(false);
  const [follow, setFollow] = useState(true);
  const lastId = useRef(null);
  const box = useRef(null);

  useEffect(() => {
    let alive = true;
    let timer;
    lastId.current = null;
    setEvents([]);
    const poll = async () => {
      try {
        const batch = await client.events(id, lastId.current);
        if (!alive) return;
        if (batch.length) {
          lastId.current = batch.at(-1).id;
          setEvents((prev) => [...prev, ...batch].slice(-2000));
        }
        setError(null);
      } catch (err) {
        if (alive) setError(err.message);
      }
      if (alive) timer = setTimeout(poll, 4000);
    };
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [client, id]);

  const shown = events.filter((e) => showDebug || e.level !== 'debug');

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown.length, follow]);

  return (
    <div className="card">
      <div className="row between">
        <h3>Log</h3>
        <div className="row">
          <label className="check small"><input type="checkbox" checked={showDebug} onChange={(e) => setShowDebug(e.target.checked)} /> <span>Debug</span></label>
          <label className="check small"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> <span>Follow</span></label>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="log" ref={box}>
        {shown.length === 0 && <p className="muted small">Nothing logged yet.</p>}
        {shown.map((e) => (
          <div key={e.id} className={`log-line log-${e.level}`}>
            <time>{new Date(e.ts).toLocaleTimeString()}</time>
            <span>{e.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
