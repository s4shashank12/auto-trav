// A tiny stand-in for a Travian game world, with the page structure src/travian.js reads: login
// (a React-style form whose state follows input events), resource view, village centre, build
// pages with the hero "transfer" dialog, marketplace, profile and the GraphQL API. Each account
// (by username) has its own state, so cookie isolation between accounts can be checked.
import http from 'node:http';

const page = (body, script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>Travian</title></head>
<body>${body}<script>${script}</script></body></html>`;

function newAccount(username) {
  return {
    username,
    active: 101,
    villages: [
      { did: 101, name: `${username}-Alpha`, x: 1, y: 2, pop: 120, capital: true },
      { did: 102, name: `${username}-Beta`, x: -3, y: 4, pop: 900, capital: false },
    ],
    fields: Object.fromEntries(Array.from({ length: 18 }, (_, i) => [i + 1, { gid: (i % 4) + 1, level: 2 }])),
    buildings: { 26: { gid: 15, name: 'Main Building', level: 3 }, 39: { gid: 16, name: 'Rally Point', level: 1 } },
    queue: [],
    short: new Set(), // slots whose build page shows "not enough resources"
    builds: [],
    heroTransfers: [],
    shipments: [],
    heroSent: [],
    captcha: false,
  };
}

export async function startMockTravian({ password = 'secret' } = {}) {
  const accounts = new Map();
  const sessions = new Map();
  let nextSid = 1;
  const log = [];

  const account = (req) => {
    const sid = /(?:^|;\s*)sid=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
    return sid ? sessions.get(sid) : null;
  };

  const loginPage = () => page(`
    <div id="cmp" style="position:fixed;bottom:0;left:0;right:0;background:#eee">We use cookies
      <button type="button" id="accept">Accept all</button><button type="button" id="reject">Reject all</button></div>
    <form id="loginForm">
      <input name="name" type="text"><input name="password" type="password">
      <button type="submit">Login</button>
    </form>`, `
    const state = { name: '', password: '' };
    for (const i of document.querySelectorAll('#loginForm input')) i.addEventListener('input', (e) => { state[e.target.name] = e.target.value; });
    document.getElementById('reject').addEventListener('click', () => document.getElementById('cmp').remove());
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) });
      if (r.ok) setTimeout(() => { location.href = '/dorf1.php'; }, 150);
      else document.body.insertAdjacentHTML('beforeend', '<p class="error">Wrong password</p>');
    });`);

  const village = (a, did = a.active) => a.villages.find((v) => v.did === did);
  const header = (a) => {
    const v = village(a);
    return `<div id="stockBar"><span id="l1">500</span></div>
      <input class="villageInput" data-did="${v.did}" value="${v.name}">
      <div id="sidebarBoxActiveVillage"><div class="population"><span>${v.pop}</span></div></div>
      ${a.captcha ? '<div class="captcha">Please solve the CAPTCHA</div>' : ''}`;
  };
  const resources = (a) => {
    const big = village(a).pop >= 500 ? 20000 : 600;
    return `window.resources = { storage: { l1: ${big}, l2: ${big}, l3: ${big}, l4: ${big} },
      maxStorage: { l1: 80000, l2: 80000, l3: 80000, l4: 80000 }, production: { l1: 30, l2: 30, l3: 30, l4: 40 } };`;
  };
  const queueHtml = (a) => `<div class="buildingList"><ul>${a.queue.map((q) => `<li><div class="name">${q.name} <span class="lvl">Level ${q.level}</span></div><span class="timer" value="${q.seconds}">0:10:00</span></li>`).join('')}</ul></div>`;

  const dorf1 = (a) => page(`${header(a)}
    <div id="resourceFieldContainer" class="village1 tribe1">
      ${Object.entries(a.fields).map(([id, f]) => `<a href="/build.php?id=${id}" class="good level${f.level} gid${f.gid} buildingSlot${id}${a.queue.some((q) => q.slot === Number(id)) ? ' underConstruction' : ''}">${f.level}</a>`).join('')}
    </div>${queueHtml(a)}`, resources(a));

  const dorf2 = (a) => {
    const slots = Array.from({ length: 22 }, (_, i) => 19 + i).map((id) => {
      const b = a.buildings[id];
      return `<div class="buildingSlot" data-aid="${id}" data-gid="${b?.gid ?? 0}" data-name="${b?.name ?? ''}">
        <a class="${b ? `good level${b.level}` : ''}"></a>${b ? `<div class="labelLayer">${b.level}</div>` : ''}</div>`;
    });
    return page(`${header(a)}<div id="villageContent">${slots.join('')}</div>${queueHtml(a)}`, resources(a));
  };

  const fieldName = { 1: 'Woodcutter', 2: 'Clay Pit', 3: 'Iron Mine', 4: 'Cropland' };
  const buildPage = (a, id) => {
    const short = a.short.has(id);
    const level = id <= 18 ? a.fields[id].level : (a.buildings[id]?.level ?? 0);
    return page(`${header(a)}
      <div id="build" class="gid${id <= 18 ? a.fields[id].gid : a.buildings[id]?.gid ?? 0}">
        <div id="contract">
          <div class="resource">120 ${short ? '<a href="#" class="inlineIcon resource transfer fillUp" id="fillUp">transfer</a>' : ''}</div>
        </div>
        <div class="upgradeButtonsContainer"><div class="section1">
          <button type="button" class="textButtonV1 green build${short ? ' disabled' : ''}"
            onclick="window.location.href = '/dorf1.php?id=${id}&amp;action=build&amp;checksum=c0ffee'; return false;">Upgrade to level ${level + 1}</button>
        </div><div class="section2"><button type="button" class="textButtonV1 gold">Build with master builder</button></div></div>
      </div>`, `
      document.getElementById('fillUp')?.addEventListener('click', (e) => {
        e.preventDefault();
        setTimeout(() => {
          document.body.insertAdjacentHTML('beforeend', '<div class="dialogWrapper"><div class="dialog">'
            + '<input name="lumber" value="120" readonly><input name="clay" value="0" readonly><input name="iron" value="0" readonly><input name="crop" value="0" readonly>'
            + '<button type="button" class="transferMax">Transfer maximum</button><button type="button" class="transfer"> Transfer </button></div></div>');
          document.querySelector('.dialog button.transfer').addEventListener('click', () => {
            fetch('/api/v1/hero/v2/inventory/use-item', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slot: ${id}, amounts: { lumber: 120 } }) })
              .then(() => document.querySelector('.dialogWrapper').remove());
          });
        }, 200);
      });`);
  };

  const profile = (a) => page(`${header(a)}
    <table class="villages"><tbody>${a.villages.map((v) => `<tr><td class="name"><a href="#">${v.name}</a>${v.capital ? '<span class="additionalInfo">(Capital)</span>' : ''}</td><td class="inhabitants">${v.pop}</td></tr>`).join('')}</tbody></table>
    <div class="villageList">${a.villages.map((v) => `<div class="listEntry" data-did="${v.did}"><span class="name">${v.name}</span><span class="coordinateX">(${String(v.x).replace('-', '−')}</span><span class="coordinateY">${String(v.y).replace('-', '−')})</span></div>`).join('')}</div>`);

  const marketplace = (a) => page(`${header(a)}
    <div id="content"><form id="send">
      <input name="lumber"><input name="clay"><input name="iron"><input name="crop"><input name="x"><input name="y">
      <button type="button" class="send">Send</button></form></div>`, `
    document.querySelector('button.send').addEventListener('click', () => {
      const f = Object.fromEntries([...document.querySelectorAll('#send input')].map((i) => [i.name, Number(i.value)]));
      fetch('/api/v1/marketplace/resources/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(f) });
    });`);

  // Rally point: the send form, then the confirmation page the bot checks before confirming.
  const rallyPoint = (a) => page(`${header(a)}
    <form method="POST" action="/build.php?id=39&amp;gid=16&amp;tt=2">
      <table><tbody><tr>${Array.from({ length: 11 }, (_, i) => `<td><input name="troop[t${i + 1}]" value=""> / ${i === 10 ? 1 : 0}</td>`).join('')}</tr></tbody></table>
      <input name="x" value=""><input name="y" value="">
      <label><input type="radio" name="eventType" value="5">Reinforcement</label>
      <label><input type="radio" name="eventType" value="3">Attack: Normal</label>
      <label><input type="radio" name="eventType" value="4">Attack: Raid</label>
      <button type="submit" name="ok" value="ok" id="ok">Send</button>
    </form>`);
  const confirmation = (a, f) => page(`${header(a)}
    <form method="POST" action="/build.php?id=39&amp;gid=16&amp;tt=2&amp;confirm=1">
      <table class="troop_details"><thead><tr><td class="troopHeadline">${f.get('eventType') === '4' ? 'Raid' : 'Attack'} against Unoccupied oasis (${f.get('x')}|${f.get('y')})</td></tr></thead></table>
      <input type="hidden" name="eventType" value="${f.get('eventType')}"><input type="hidden" name="x" value="${f.get('x')}"><input type="hidden" name="y" value="${f.get('y')}">
      ${Array.from({ length: 11 }, (_, i) => `<input type="hidden" name="troops[0][t${i + 1}]" value="${Number(f.get(`troop[t${i + 1}]`) || 0)}">`).join('')}
      <input type="hidden" name="troops[0][villageId]" value="${a.active}">
      <button type="submit" id="confirmSendTroops">Confirm</button>
    </form>`);

  const graphql = (a, query) => {
    if (/adventures/.test(query)) {
      const home = a.villages[0];
      return {
        ownPlayer: {
          hero: {
            isAlive: true,
            health: 90,
            isRegenerating: false,
            homeVillage: {
              id: home.did, name: home.name, x: home.x, y: home.y,
            },
            status: {
              status: 'home', inVillage: { id: home.did, name: home.name }, arrivalIn: null, onWayTo: null,
            },
            adventures: [],
          },
        },
      };
    }
    if (/tribeId/.test(query)) return { ownPlayer: { tribeId: 1 } };
    if (/merchantsInfo/.test(query)) {
      return {
        ownPlayer: {
          villages: a.villages.map((v) => ({
            id: v.did,
            name: v.name,
            resources: {
              lumberStock: v.pop >= 500 ? 20000 : 100, clayStock: v.pop >= 500 ? 20000 : 100, ironStock: v.pop >= 500 ? 20000 : 100, cropStock: v.pop >= 500 ? 20000 : 100,
            },
            marketplace: { merchantsInfo: { total: 5, capacity: 1000, available: 5 }, merchantsMovements: { edges: [] } },
          })),
        },
      };
    }
    if (/farmLists/.test(query)) return { ownPlayer: { farmLists: [] } };
    if (/ownTroopsAtTown/.test(query)) return { ownPlayer: { villages: a.villages.map((v) => ({ id: v.did, troops: { ownTroopsAtTown: { units: { t1: 0 } } } })) } };
    return { ownPlayer: {} };
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      log.push(`${req.method} ${url.pathname}${url.search}`);
      const send = (status, text, type = 'text/html; charset=utf-8', headers = {}) => {
        res.writeHead(status, { 'content-type': type, ...headers });
        res.end(text);
      };
      const json = (status, data, headers) => send(status, JSON.stringify(data), 'application/json', headers);

      if (url.pathname === '/api/v1/auth/login' && req.method === 'POST') {
        const { name, password: pw } = JSON.parse(body || '{}');
        if (!name || pw !== password) return json(401, { error: 'wrong' });
        if (!accounts.has(name)) accounts.set(name, newAccount(name));
        const sid = `s${nextSid++}`;
        sessions.set(sid, accounts.get(name));
        return json(200, { ok: true }, { 'set-cookie': `sid=${sid}; Path=/; HttpOnly` });
      }
      const a = account(req);
      if (!a) {
        if (url.pathname.startsWith('/api/')) return json(401, { error: 'not logged in' });
        return send(200, loginPage());
      }
      const did = Number(url.searchParams.get('newdid'));
      if (did && a.villages.some((v) => v.did === did)) a.active = did;

      if (url.pathname === '/dorf1.php') {
        if (url.searchParams.get('action') === 'build') {
          const id = Number(url.searchParams.get('id'));
          a.builds.push({ did: a.active, id });
          const name = id <= 18 ? fieldName[a.fields[id].gid] : a.buildings[id]?.name;
          const level = (id <= 18 ? a.fields[id].level : a.buildings[id]?.level ?? 0) + 1;
          a.queue.push({ slot: id, name, level, seconds: 600 + a.queue.length * 60 });
        }
        return send(200, dorf1(a));
      }
      if (url.pathname === '/dorf2.php') return send(200, dorf2(a));
      if (url.pathname === '/profile') return send(200, profile(a));
      if (url.pathname === '/build.php' && url.searchParams.get('gid') === '16') {
        if (req.method === 'POST' && url.searchParams.get('confirm')) {
          const f = new URLSearchParams(body);
          a.heroSent.push({
            x: Number(f.get('x')), y: Number(f.get('y')), eventType: f.get('eventType'), hero: f.get('troops[0][t11]'),
          });
          res.writeHead(302, { location: '/build.php?gid=16&tt=1' });
          return res.end();
        }
        if (req.method === 'POST') return send(200, confirmation(a, new URLSearchParams(body)));
        if (url.searchParams.get('tt') === '2') return send(200, rallyPoint(a));
        return send(200, page(`${header(a)}<div id="build" class="gid16"><p>Troops overview</p></div>`));
      }
      if (url.pathname === '/api/v1/hero/v2/screen/attributes') {
        return json(200, { hero: { attributes: { power: { value: 1000 } }, equipment: {} } });
      }
      if (url.pathname === '/api/v1/map/position') {
        const { data } = JSON.parse(body || '{}');
        // One unoccupied oasis with 3 rats, two fields east of the first village, in every window.
        const tiles = [{ position: { x: 3, y: 2 }, title: '{k.fo}', text: '<i class="unit u31"></i><span class="value ">3</span>' }];
        return json(200, { tiles: tiles.filter((t) => Math.abs(t.position.x - data.x) <= 15 && Math.abs(t.position.y - data.y) <= 15) });
      }
      if (url.pathname === '/build.php') {
        const gid = url.searchParams.get('gid');
        if (gid === '17') return send(200, marketplace(a));
        const id = Number(url.searchParams.get('id'));
        // Training, Academy, Smithy...: this mock's villages have none of those buildings.
        if (!id || (id > 18 && !a.buildings[id] && gid)) return send(200, page(`${header(a)}<div id="build" class="gid0"><p>No such building yet.</p></div>`));
        return send(200, buildPage(a, id));
      }
      if (url.pathname === '/api/v1/graphql') return json(200, { data: graphql(a, JSON.parse(body || '{}').query ?? '') });
      if (url.pathname === '/api/v1/hero/v2/inventory/use-item') {
        const { slot } = JSON.parse(body || '{}');
        a.heroTransfers.push(slot);
        a.short.delete(slot);
        return json(200, { ok: true });
      }
      if (url.pathname === '/api/v1/marketplace/resources/send') {
        a.shipments.push(JSON.parse(body || '{}'));
        return json(200, { ok: true });
      }
      if (url.pathname === '/map.sql') return send(200, '', 'text/plain');
      return send(404, page('<h1>Not found</h1>'));
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    accounts,
    log,
    account: (name) => {
      if (!accounts.has(name)) accounts.set(name, newAccount(name));
      return accounts.get(name);
    },
    close: () => new Promise((resolve) => { server.close(resolve); }),
  };
}
