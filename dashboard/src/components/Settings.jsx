import { useMemo, useState } from 'react';

// Settings with their own editors elsewhere (names instead of codes, drag and drop).
const EDITED_ELSEWHERE = {
  'train.units': 'army',
  'train.overrides': 'army',
  'research.units': 'army',
  'research.overrides': 'army',
  'research.fromTraining': 'army',
  'build.buildings': 'buildings',
  'build.populationLimit': 'buildings',
  'build.queueMax': 'buildings',
  'raid.units': 'raiding',
  'raid.everyMinutes': 'raiding',
  'raid.radius': 'raiding',
  'raid.listSize': 'raiding',
  'inactive.units': 'raiding',
};

// Every other setting, as a form. Changes go into the same unsaved draft as the other tabs.
export default function Settings({ meta, draft }) {
  const [jsonDrafts, setJsonDrafts] = useState({}); // raw text of JSON fields being edited
  const [error, setError] = useState(null);
  const [advanced, setAdvanced] = useState(false);
  const [rawText, setRawText] = useState('');

  const sections = useMemo(() => {
    const out = new Map();
    for (const f of meta?.fields ?? []) {
      if (EDITED_ELSEWHERE[f.path]) continue;
      if (!out.has(f.section)) out.set(f.section, []);
      out.get(f.section).push(f);
    }
    return [...out.entries()];
  }, [meta]);

  if (!draft.defaults) return <p className="muted">Loading settings…</p>;

  function changeJson(path, text) {
    setJsonDrafts((d) => ({ ...d, [path]: text }));
    try {
      draft.change(path, JSON.parse(text));
      setError(null);
    } catch {
      setError('That is not valid JSON yet.');
    }
  }

  function toggleAdvanced() {
    if (!advanced) setRawText(JSON.stringify(draft.draft, null, 2));
    setAdvanced(!advanced);
    setError(null);
  }

  function applyRaw() {
    try {
      draft.replace(JSON.parse(rawText || '{}'));
      setAdvanced(false);
      setError(null);
    } catch {
      setError('The JSON is not valid.');
    }
  }

  return (
    <div className="stack">
      <div className="card row between wrap">
        <p className="muted small">
          Highlighted settings differ from the defaults. Training, research, the build list and raid troops are on the
          {' '}<a href="#army" onClick={(e) => { e.preventDefault(); window.location.hash = window.location.hash.replace(/[^/]+$/, 'army'); }}>Army</a>,
          {' '}<a href="#buildings" onClick={(e) => { e.preventDefault(); window.location.hash = window.location.hash.replace(/[^/]+$/, 'buildings'); }}>Buildings</a> and
          {' '}<a href="#raiding" onClick={(e) => { e.preventDefault(); window.location.hash = window.location.hash.replace(/[^/]+$/, 'raiding'); }}>Raiding</a> tabs.
        </p>
        <button type="button" className="btn ghost small" onClick={toggleAdvanced}>{advanced ? 'Form view' : 'Edit all as JSON'}</button>
      </div>
      {error && <p className="error">{error}</p>}

      {advanced ? (
        <div className="card">
          <h3>Overrides (JSON)</h3>
          <p className="muted small">Only the settings that differ from the defaults. Apply, then save.</p>
          <textarea className="code" rows={24} value={rawText} onChange={(e) => setRawText(e.target.value)} spellCheck={false} />
          <div className="row"><button type="button" className="btn primary" onClick={applyRaw}>Apply</button></div>
        </div>
      ) : sections.map(([section, fields]) => (
        <div key={section} className="card">
          <h3>{section}</h3>
          <div className="settings">
            {fields.map((f) => {
              const v = draft.value(f.path);
              const changed = draft.isChanged(f.path);
              return (
                <div key={f.path} className={`setting ${f.type === 'json' ? 'wide' : ''} ${changed ? 'changed' : ''}`}>
                  <div className="setting-head">
                    <label htmlFor={f.path}>{f.label}</label>
                    {changed && (
                      <button
                        type="button"
                        className="link small"
                        onClick={() => {
                          setJsonDrafts(({ [f.path]: _, ...rest }) => rest);
                          draft.reset(f.path);
                        }}
                      >
                        Reset
                      </button>
                    )}
                  </div>
                  {f.type === 'boolean' && (
                    <label className="switch">
                      <input id={f.path} type="checkbox" checked={Boolean(v)} onChange={(e) => draft.change(f.path, e.target.checked)} />
                      <span>{v ? 'On' : 'Off'}</span>
                    </label>
                  )}
                  {f.type === 'number' && (
                    <input id={f.path} type="number" step={f.step ?? 1} value={v} onChange={(e) => e.target.value !== '' && draft.change(f.path, Number(e.target.value))} />
                  )}
                  {f.type === 'string' && <input id={f.path} value={v} onChange={(e) => draft.change(f.path, e.target.value)} />}
                  {f.type === 'json' && (
                    <textarea
                      id={f.path}
                      className="code"
                      rows={Math.min(10, JSON.stringify(v, null, 2).split('\n').length + 1)}
                      value={jsonDrafts[f.path] ?? JSON.stringify(v, null, 2)}
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
