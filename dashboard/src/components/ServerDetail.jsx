import { useEffect, useState } from 'react';
import { useConfigDraft } from '../useConfigDraft.js';
import {
  hostOf, navigate, timeAgo, timeUntil, usePoll,
} from '../util.js';
import Army from './Army.jsx';
import BuildPlan from './BuildPlan.jsx';
import Inactives from './Inactives.jsx';
import Logs from './Logs.jsx';
import Overview from './Overview.jsx';
import Raiding from './Raiding.jsx';
import Screenshots from './Screenshots.jsx';
import ServerForm from './ServerForm.jsx';
import Settings from './Settings.jsx';
import {
  Icon, Menu, SaveBar, StatusBadge,
} from './ui.jsx';

const TABS = [
  ['overview', 'Overview', 'castle'],
  ['army', 'Army', 'foot'],
  ['buildings', 'Buildings', 'hammer'],
  ['raiding', 'Raiding', 'target'],
  ['inactives', 'Inactive players', 'target'],
  ['logs', 'Logs', 'book'],
  ['settings', 'Settings', 'bolt'],
  ['account', 'Account', 'lock'],
];

const ACTIONS = {
  villages: ['Refresh villages', 'Read villages and population'],
  build: ['Build now', 'Queue jobs in small villages'],
  train: ['Research & train now', 'Top up training queues'],
  research: ['Research now', 'Start missing Academy research'],
  smithy: ['Improve in Smithy', 'Start the next weapons and armour upgrade'],
  hero: ['Send hero', 'An adventure first, else an oasis with animals'],
  raid: ['Send a raid wave', 'From the oasis farm lists'],
  'farm-setup': ['Set up farm lists', 'Find and add empty oases'],
  'farm-rebuild': ['Rebuild farm lists', 'Empty the bot\'s lists and fill them again'],
  world: ['Import world data', 'For inactive player detection'],
  'inactive-raid': ['Raid inactive players', 'From the inactive farm lists'],
};

export default function ServerDetail({
  client, meta, id, tab,
}) {
  const [tick, setTick] = useState(0);
  const { data: server, error } = usePoll(() => client.server(id), 5000, [client, id, tick]);
  const [notice, setNotice] = useState(null);
  const refresh = () => setTick((t) => t + 1);
  const draft = useConfigDraft(client, server, meta?.defaults, refresh);

  // Unsaved settings survive switching tabs; warn before leaving the page with them.
  useEffect(() => {
    if (!draft.dirty) return undefined;
    const warn = (e) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [draft.dirty]);

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
  if (!server || !meta) return <p className="muted">Loading…</p>;

  // Rebuilding farm lists empties them first, so it lives on the Raiding tab behind a confirm.
  const actions = (meta.actions ?? Object.keys(ACTIONS)).filter((a) => a !== 'farm-rebuild').map((a) => ({
    key: a,
    label: ACTIONS[a]?.[0] ?? a,
    hint: ACTIONS[a]?.[1],
    onSelect: () => run(() => client.action(id, a), `${ACTIONS[a]?.[0] ?? a}: started. Follow it in Logs.`),
  }));
  const editorProps = { draft, server };

  return (
    <section className="server-page">
      <div className="page-head">
        <div>
          <h1>{server.name} <StatusBadge status={server.status} /></h1>
          <p className="muted small">
            <a href={server.url} target="_blank" rel="noreferrer">{hostOf(server.url)}</a> · {server.username}
            {' · '}last round {timeAgo(server.lastPassAt)}
            {server.enabled && server.nextRunAt ? ` · next ${timeUntil(server.nextRunAt)}` : ''}
            {draft.value('dryRun') ? <span className="tag warn">dry run</span> : null}
          </p>
          {server.statusMessage && <p className={`small ${['error', 'captcha'].includes(server.status) ? 'error' : 'muted'}`}>{server.statusMessage}</p>}
        </div>
        <div className="row">
          <Menu label="Run now" icon="bolt" items={actions} />
          {server.enabled
            ? <button type="button" className="btn" onClick={() => run(() => client.stop(id), 'Stopping after the current round…')}><Icon name="stop" /> Stop</button>
            : <button type="button" className="btn primary" onClick={() => run(() => client.start(id), 'Started.')}><Icon name="play" /> Start</button>}
        </div>
      </div>
      {notice && <p className="notice">{notice}</p>}

      <nav className="tabs" aria-label="Sections">
        {TABS.map(([key, label, icon]) => (
          <a key={key} href={`#/servers/${id}/${key}`} className={tab === key ? 'active' : ''} aria-current={tab === key ? 'page' : undefined}>
            <Icon name={icon} size={14} />{label}
          </a>
        ))}
      </nav>

      {tab === 'overview' && <Overview server={server} config={server.effectiveConfig} />}
      {tab === 'army' && <Army {...editorProps} />}
      {tab === 'buildings' && <BuildPlan {...editorProps} />}
      {tab === 'raiding' && (
        <Raiding
          {...editorProps}
          onAction={(a, message) => run(() => client.action(id, a), message)}
          canRebuild={(meta.actions ?? []).includes('farm-rebuild')}
          canSendHero={(meta.actions ?? []).includes('hero')}
        />
      )}
      {tab === 'inactives' && <Inactives client={client} server={server} onChanged={refresh} />}
      {tab === 'logs' && (
        <div className="stack">
          <Logs client={client} id={id} />
          <Screenshots client={client} id={id} />
        </div>
      )}
      {tab === 'settings' && <Settings meta={meta} draft={draft} />}
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

      <SaveBar draft={draft} />
    </section>
  );
}
