import { useEffect, useMemo, useState } from 'react';
import {
  APP_VERSION, createClient, isAndroid, loadConnection, saveConnection,
} from './api.js';
import Connect from './components/Connect.jsx';
import ServerDetail from './components/ServerDetail.jsx';
import ServerForm from './components/ServerForm.jsx';
import ServerList from './components/ServerList.jsx';
import { Icon, StatusBadge } from './components/ui.jsx';
import { hostOf, navigate, usePoll } from './util.js';

// Hash routes: #/ (servers), #/new, #/servers/:id[/tab]
function useRoute() {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

const THEMES = ['auto', 'light', 'dark'];
function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('auto-travian.theme') ?? 'auto';
    } catch {
      return 'auto';
    }
  });
  useEffect(() => {
    if (theme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('auto-travian.theme', theme);
    } catch { /* private mode */ }
  }, [theme]);
  return [theme, () => setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length])];
}

function Sidebar({
  client, meta, current, open, onClose, onDisconnect, theme, nextTheme,
}) {
  const { data: servers } = usePoll(() => client.servers(), 10_000, [client]);
  return (
    <>
      <div className={`scrim ${open ? 'show' : ''}`} onClick={onClose} aria-hidden="true" />
      <nav className={`sidebar ${open ? 'open' : ''}`} aria-label="Servers">
        <a className="brand" href="#/" onClick={onClose}>
          <img src="/favicon.svg" alt="" width="26" height="26" />
          <span>Travian Bot</span>
        </a>
        <div className="side-section">
          <div className="side-title">
            <span>Servers</span>
            <a className="icon-btn" href="#/new" onClick={onClose} title="Add server" aria-label="Add server"><Icon name="plus" /></a>
          </div>
          <a className={`side-link ${current == null ? 'active' : ''}`} href="#/" onClick={onClose}>All servers</a>
          {servers?.map((s) => (
            <a key={s.id} className={`side-link server ${current === s.id ? 'active' : ''}`} href={`#/servers/${s.id}`} onClick={onClose}>
              <span className="side-name">{s.name}</span>
              <StatusBadge status={s.status} />
            </a>
          ))}
        </div>
        <div className="side-foot">
          <button type="button" className="btn ghost small" onClick={nextTheme} title="Theme">
            <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
            {theme === 'auto' ? 'Auto' : theme === 'dark' ? 'Dark' : 'Light'}
          </button>
          <div className="muted small side-meta">
            {isAndroid
              ? <span title="The bot runs on this phone">This phone</span>
              : <span title={`Backend ${client.base}`}>{hostOf(client.base)}</span>}
            <span className="version" title={`Dashboard ${APP_VERSION} · Backend ${meta?.version ?? '…'}`}>
              v{APP_VERSION}
              {meta?.version && meta.version !== APP_VERSION ? ` · API v${meta.version}` : ''}
            </span>
          </div>
          {!isAndroid && <button type="button" className="link small" onClick={onDisconnect}>Disconnect</button>}
        </div>
      </nav>
    </>
  );
}

export default function App() {
  const [connection, setConnection] = useState(loadConnection);
  const [meta, setMeta] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, nextTheme] = useTheme();
  const route = useRoute();
  const client = useMemo(() => (connection ? createClient(connection) : null), [connection]);

  useEffect(() => {
    if (!client) return;
    client.meta().then(setMeta, (err) => {
      if (err.status === 401) disconnect();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  function connect(conn) {
    saveConnection(conn);
    setConnection(conn);
    navigate('/');
  }

  function disconnect() {
    saveConnection(null);
    setConnection(null);
    setMeta(null);
  }

  if (!client) return <Connect onConnect={connect} />;

  let page;
  let current = null;
  if (route[0] === 'new') page = <ServerForm client={client} meta={meta} />;
  else if (route[0] === 'servers' && route[1]) {
    current = Number(route[1]);
    page = <ServerDetail key={route[1]} client={client} meta={meta} id={current} tab={route[2] ?? 'overview'} />;
  } else page = <ServerList client={client} />;

  return (
    <div className="shell">
      <Sidebar
        client={client}
        meta={meta}
        current={current}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onDisconnect={disconnect}
        theme={theme}
        nextTheme={nextTheme}
      />
      <div className="main">
        <header className="mobilebar">
          <button type="button" className="icon-btn" aria-label="Open menu" onClick={() => setMenuOpen(true)}><Icon name="menu" size={20} /></button>
          <a className="brand" href="#/"><img src="/favicon.svg" alt="" width="22" height="22" /><span>Travian Bot</span></a>
          <span className="version">v{APP_VERSION}</span>
        </header>
        <main className="content">{page}</main>
      </div>
    </div>
  );
}
