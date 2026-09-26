import { useEffect, useMemo, useState } from 'react';
import { createClient, loadConnection, saveConnection } from './api.js';
import Connect from './components/Connect.jsx';
import ServerDetail from './components/ServerDetail.jsx';
import ServerForm from './components/ServerForm.jsx';
import ServerList from './components/ServerList.jsx';
import { hostOf, navigate } from './util.js';

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

export default function App() {
  const [connection, setConnection] = useState(loadConnection);
  const [meta, setMeta] = useState(null);
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
  if (route[0] === 'new') page = <ServerForm client={client} meta={meta} />;
  else if (route[0] === 'servers' && route[1]) {
    page = <ServerDetail key={route[1]} client={client} meta={meta} id={Number(route[1])} tab={route[2] ?? 'overview'} />;
  } else page = <ServerList client={client} />;

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">
          <img src="/favicon.svg" alt="" width="22" height="22" />
          <span>Travian Bot Control</span>
        </a>
        <div className="topbar-right">
          <span className="muted small" title={client.base}>
            {hostOf(client.base)}
            {meta?.version ? ` · ${String(meta.version).slice(0, 7)}` : ''}
          </span>
          <button type="button" className="btn ghost" onClick={disconnect}>Disconnect</button>
        </div>
      </header>
      <main className="content">{page}</main>
    </div>
  );
}
