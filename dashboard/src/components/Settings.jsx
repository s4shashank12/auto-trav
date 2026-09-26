import { useMemo, useState } from 'react';
import {
  getPath, sameJson, setPath, unsetPath,
} from '../util.js';

// Edits a server's settings. Only values that differ from the defaults are saved (as overrides),
// so future default changes still reach settings you never touched.
export default function Settings({
  client, meta, server, onSaved,
}) {
  const defaults = meta?.defaults;
  const [overrides, setOverrides] = useState(server.config ?? {});
  const [drafts, setDrafts] = useState({}); // raw text of JSON fields being edited
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [rawText, setRawText] = useState('');

  const sections = useMemo(() => {
    const out = new Map();
    for (const f of meta?.fields ?? []) {
      if (!out.has(f.section)) out.set(f.section, []);
      out.get(f.section).push(f);
    }
    return [...out.entries()];
  }, [meta]);

  if (!defaults) return <p className="muted">Loading settings…</p>;

  const value = (path) => {
    const own = getPath(overrides, path);
    return own !== undefined ? own : getPath(defaults, path);
  };
  const isOverridden = (path) => getPath(overrides, path) !== undefined && !sameJson(getPath(overrides, path), getPath(defaults, path));

  function change(path, next) {
    setSaved(null);
    setOverrides((o) => (sameJson(next, getPath(defaults, path)) ? unsetPath(o, path) : setPath(o, path, next)));
  }

  function reset(path) {
    setDrafts(({ [path]: _, ...rest }) => rest);
    change(path, getPath(defaults, path));
  }

  function changeJson(path, text) {
    setDrafts((d) => ({ ...d, [path]: text }));
    try {
      change(path, JSON.parse(text));
      setError(null);
    } catch {
      setError(`"${path}" is not valid JSON yet.`);
    }
  }

  async function save() {
    setError(null);
    setBusy(true);
    try {
      let body = overrides;
      if (advanced) body = JSON.parse(rawText || '{}');
      const updated = await client.updateServer(server.id, { config: body });
      setOverrides(updated.config ?? {});
      setDrafts({});
      setAdvanced(false);
      setSaved('Saved. Changes apply from the next round.');
      onSaved?.();
    } catch (err) {
      setError(err instanceof SyntaxError ? 'The JSON is not valid.' : err.message);
    } finally {
      setBusy(false);
    }
  }

  function toggleAdvanced() {
    if (!advanced) setRawText(JSON.stringify(overrides, null, 2));
    setAdvanced(!advanced);
  }

  const dirty = !sameJson(overrides, server.config ?? {}) || advanced;

  return (
    <div className="stack">
      <div className="card sticky-bar">
        <div className="row between wrap">
          <p className="muted small">
            Highlighted settings differ from the defaults. Everything else follows the defaults.
          </p>
          <div className="row">
            <button type="button" className="btn ghost small" onClick={toggleAdvanced}>{advanced ? 'Form view' : 'Edit as JSON'}</button>
            <button type="button" className="btn primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save settings'}</button>
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        {saved && <p className="notice">{saved}</p>}
      </div>

      {advanced ? (
        <div className="card">
          <h3>Overrides (JSON)</h3>
          <p className="muted small">Only the settings you want to change. Defaults are in the form view.</p>
          <textarea className="code" rows={24} value={rawText} onChange={(e) => setRawText(e.target.value)} spellCheck={false} />
        </div>
      ) : sections.map(([section, fields]) => (
        <div key={section} className="card">
          <h3>{section}</h3>
          <div className="settings">
            {fields.map((f) => {
              const v = value(f.path);
              const changed = isOverridden(f.path);
              return (
                <div key={f.path} className={`setting ${f.type === 'json' ? 'wide' : ''} ${changed ? 'changed' : ''}`}>
                  <div className="setting-head">
                    <label htmlFor={f.path}>{f.label}</label>
                    {changed && <button type="button" className="link small" onClick={() => reset(f.path)}>Reset</button>}
                  </div>
                  {f.type === 'boolean' && (
                    <label className="switch">
                      <input id={f.path} type="checkbox" checked={Boolean(v)} onChange={(e) => change(f.path, e.target.checked)} />
                      <span>{v ? 'On' : 'Off'}</span>
                    </label>
                  )}
                  {f.type === 'number' && (
                    <input
                      id={f.path}
                      type="number"
                      step={f.step ?? 1}
                      value={v}
                      onChange={(e) => e.target.value !== '' && change(f.path, Number(e.target.value))}
                    />
                  )}
                  {f.type === 'string' && (
                    <input id={f.path} value={v} onChange={(e) => change(f.path, e.target.value)} />
                  )}
                  {f.type === 'json' && (
                    <textarea
                      id={f.path}
                      className="code"
                      rows={Math.min(14, JSON.stringify(v, null, 2).split('\n').length + 1)}
                      value={drafts[f.path] ?? JSON.stringify(v, null, 2)}
                      onChange={(e) => changeJson(f.path, e.target.value)}
                      spellCheck={false}
                    />
                  )}
                  {f.help && <small className="muted">{f.help}</small>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
