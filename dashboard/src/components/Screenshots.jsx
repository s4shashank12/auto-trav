import { useEffect, useState } from 'react';
import { usePoll } from '../util.js';

// Screenshots the bot saved when something went wrong (CAPTCHA, failed login, errors).
export default function Screenshots({ client, id }) {
  const { data: files, error } = usePoll(() => client.screenshots(id), 30_000, [client, id]);
  const [open, setOpen] = useState(null);
  const [src, setSrc] = useState(null);

  useEffect(() => {
    if (!open) return undefined;
    let url;
    client.screenshotUrl(id, open).then((u) => {
      url = u;
      setSrc(u);
    }, () => setSrc(null));
    return () => {
      if (url) URL.revokeObjectURL(url);
      setSrc(null);
    };
  }, [client, id, open]);

  return (
    <div className="card">
      <h3>Screenshots</h3>
      {error && <p className="error">{error.message}</p>}
      {files?.length === 0 && <p className="muted small">None yet. The bot saves one when a round fails.</p>}
      <div className="shots">
        <ul>
          {files?.map((f) => (
            <li key={f}>
              <button type="button" className={`link ${open === f ? 'active' : ''}`} onClick={() => setOpen(f)}>{f.replace(/\.png$/, '')}</button>
            </li>
          ))}
        </ul>
        {open && (src ? <img src={src} alt={open} /> : <p className="muted small">Loading…</p>)}
      </div>
    </div>
  );
}
