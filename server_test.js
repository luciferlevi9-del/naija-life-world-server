// Protocol/logic tests for server.js using real WebSocket clients. Supabase is replaced by a tiny local HTTP stub (only /auth/v1/user).
const { spawn } = require('child_process');
const http = require('http');
const WS = require('ws');
const fs = require('fs');
const path = require('path');

const nav = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'lagos_nav.json')));
let ok = 0, bad = [];
const chk = (n, c, v) => {
  if (c) {
    ok++;
    console.log('PASS', n);
  } else {
    bad.push(n);
    console.log('FAIL', n, v === undefined ? '' : JSON.stringify(v));
  }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const stub = http.createServer((req, res) => {
  if (req.url === '/auth/v1/user' && req.headers.authorization === 'Bearer good' && req.headers.apikey === 'pub') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'user-1', email: 'a@b.c' }));
  } else {
    res.writeHead(401);
    res.end('{}');
  }
}).listen(8791);

const SAVE = '/tmp/nl-test-players.json';
try { fs.unlinkSync(SAVE); } catch (e) {}

function start(port, env) {
  const p = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, { PORT: port, SAVE_FILE: SAVE }, env), stdio: 'ignore' });
  return p;
}

function client(port, join, opt) {
  return new Promise((res, rej) => {
    const ws = new WS('ws://127.0.0.1:' + port, opt);
    const c = { ws, msgs: [], snap: null, w: null, fix: [], chat: [], err: [] };

    ws.on('message', d => {
      const m = JSON.parse(d);
      c.msgs.push(m);
      if (m.t === 'welcome') c.w = m;
      if (m.t === 'snap') c.snap = m;
      if (m.t === 'fix') c.fix.push(m);
      if (m.t === 'chat') c.chat.push(m);
      if (m.t === 'err') c.err.push(m);
    });

    ws.on('open', () => {
      if (join) ws.send(JSON.stringify(Object.assign({ t: 'join' }, join)));
      res(c);
    });

    ws.on('error', e => rej(e));
    ws.on('close', (code) => { c.closed = code; });
    c.send = o => ws.send(JSON.stringify(o));
  });
}

(async () => {
  const s1 = start(8790, { SUPABASE_URL: 'http://127.0.0.1:8791', SUPABASE_ANON_KEY: 'pub', CITIZENS: 20 });
  await sleep(900);

  try {
    const A = await client(8790, { name: 'Ada', guest: 'guestaaaaaaaa1' });
    const B = await client(8790, { name: 'Bayo', guest: 'guestbbbbbbbb2' });
    await sleep(500);

    chk('guest joins with welcome', A.w && A.w.id && A.w.verified === false, A.w);
    A.send({ t: 'tp', x: 10, z: 20, why: 'join' });
    B.send({ t: 'tp', x: 14, z: 24, why: 'join' });
    await sleep(300);

    A.send({ t: 'in', x: 10, z: 20, h: 0, v: 0, ty: 'foot', c: 0, a: 0, loc: 'out' });
    B.send({ t: 'in', x: 14, z: 24, h: 1, v: 2, ty: 'sedan', c: 255, a: 0, loc: 'out' });
    await sleep(500);

    chk('A sees B (name, vehicle type)', A.snap && A.snap.p.some(p => p[1] === 'Bayo' && p[6] === 'sedan'), A.snap && A.snap.p);
    chk('citizens delivered near the players', A.snap && A.snap.c.length > 0, A.snap && A.snap.c.length);

    chk('snapshot carries world time and weather', A.snap && typeof A.snap.time === 'number' && ['clear', 'cloudy', 'rain', 'storm'].includes(A.snap.wx), A.snap);
    const t1 = A.snap.time;
    await sleep(3200);
    chk('clock advances (1.1 game min per real second)', A.snap.time - t1 > 2.5 && A.snap.time - t1 < 5, [t1, A.snap.time]);
    chk('both clients see the same time', Math.abs(A.snap.time - B.snap.time) < 2.5, [A.snap.time, B.snap.time]);

    const c0 = JSON.stringify(A.snap.c.slice(0, 5));
    await sleep(3000);
    chk('citizens move', JSON.stringify(A.snap.c.slice(0, 5)) !== c0);

    A.fix.length = 0;
    A.send({ t: 'in', x: 310, z: 20, h: 0, v: 0, ty: 'foot', c: 0, a: 0, loc: 'out' });
    await sleep(300);
    chk('teleport-by-speed rejected and corrected', A.fix.some(f => f.why === 'speed' && Math.abs(f.x - 10) < 1), A.fix);

    const b = nav.col.find(o => o[1] - o[0] > 6 && o[3] - o[2] > 6 && Math.abs(o[0]) < 150 && Math.abs(o[2]) < 150);
    const bx = (b[0] + b[1]) / 2;
    const bz = (b[2] + b[3]) / 2;
    A.send({ t: 'tp', x: b[0] - 0.6, z: bz, why: 'test' });
    await sleep(300);
    A.fix.length = 0;
    A.send({ t: 'in', x: b[0] + 0.3, z: bz, h: 0, v: 3, ty: 'foot', c: 0, a: 0, loc: 'out' });
    await sleep(300);
    chk('walking into a building is rejected', A.fix.some(f => f.why === 'wall'), A.fix);

    A.send({ t: 'tp', x: 10, z: 20, why: 'a' });
    await sleep(100);
    A.fix.length = 0;
    A.send({ t: 'tp', x: 12, z: 20, why: 'b' });
    await sleep(200);
    chk('teleport spam is rate-limited', A.fix.some(f => f.why === 'tp-rate'), A.fix);

    B.chat.length = 0;
    A.send({ t: 'chat', text: 'hello nearby', scope: 'local' });
    await sleep(300);
    chk('local chat reaches nearby player', B.chat.some(m => m.text === 'hello nearby' && m.from === 'Ada'));

    const C = await client(8790, { name: 'Chi', guest: 'guestcccccccc3' });
    await sleep(400);
    C.send({ t: 'tp', x: 150, z: -150, why: 'join' });
    await sleep(200);
    C.send({ t: 'in', x: 150, z: -150, h: 0, v: 0, ty: 'foot', c: 0, a: 0, loc: 'out' });
    await sleep(300);

    A.send({ t: 'chat', text: 'local only', scope: 'local' });
    await sleep(1000);
    A.send({ t: 'chat', text: 'for everyone', scope: 'world' });
    await sleep(400);
    chk('local chat does not reach a far player', !C.chat.some(m => m.text === 'local only'));
    chk('world chat reaches everyone', C.chat.some(m => m.text === 'for everyone'));

    await sleep(1000);
    A.send({ t: 'chat', text: '<b>x</b>\u0007' + 'y'.repeat(200), scope: 'world' });
    await sleep(1100);
    const long = C.chat.find(m => m.text.includes('x') && m.text.includes('y'));
    chk('chat is sanitised and capped at 80', long && long.text.length <= 80 && !/[<>\u0007]/.test(long.text), long && long.text);

    for (let i = 0; i < 200; i++) B.send({ t: 'ping', n: i });
    await sleep(500);
    chk('message flood gets the connection closed', B.closed === 4005 || B.ws.readyState > 1, B.closed);

    const A2 = await client(8790, { name: 'Ada2', guest: 'guestaaaaaaaa1' });
    await sleep(500);
    chk('second login on the same account kicks the first', A.closed === 4004 || A.ws.readyState > 1, A.closed);

    A2.send({ t: 'tp', x: 50, z: 60, why: 'join' });
    await sleep(200);
    A2.send({ t: 'in', x: 50, z: 60, h: 0, v: 0, ty: 'foot', c: 0, a: 0, loc: 'out' });
    await sleep(300);
    A2.ws.close();
    await sleep(500);

    const A3 = await client(8790, { name: 'Ada', guest: 'guestaaaaaaaa1' });
    await sleep(500);
    chk('position remembered by the server across sessions', A3.w && Math.abs(A3.w.x - 50) < 1 && Math.abs(A3.w.z - 60) < 1, A3.w);

    const V = await client(8790, { name: 'Vee', token: 'good' });
    await sleep(500);
    chk('valid Supabase token gives a verified player', V.w && V.w.verified === true, V.w);

    const V2 = await client(8790, { name: 'Fake', token: 'bad', guest: 'guestdddddddd4' });
    await sleep(500);
    chk('bad token falls back to guest (guests allowed)', V2.w && V2.w.verified === false, V2.w);

    const G = await client(8790, null);
    G.ws.send('not json');
    G.ws.send(JSON.stringify({ t: 'in', x: 1, z: 1 }));
    await sleep(300);
    chk('garbage before join is ignored (no welcome, no crash)', !G.w);

    const h = await (await fetch('http://127.0.0.1:8790/health')).json();
    chk('health endpoint', h.ok && h.players >= 3, h);

    for (const c of [A, B, C, A3, V, V2, G]) {
      try { c.ws.close(); } catch (e) {}
    }
  } catch (e) {
    chk('no exception: ' + e.message, false);
  }

  s1.kill();

  const s2 = start(8792, { ALLOW_GUESTS: '0', SUPABASE_URL: 'http://127.0.0.1:8791', SUPABASE_ANON_KEY: 'pub' });
  await sleep(900);

  try {
    const X = await client(8792, { name: 'Guest', guest: 'guesteeeeeeee5' });
    await sleep(600);
    chk('guests refused when ALLOW_GUESTS=0', !X.w && X.err.length > 0 && X.closed === 4003, [X.err, X.closed]);

    const Y = await client(8792, { name: 'Real', token: 'good' });
    await sleep(600);
    chk('signed-in player allowed when guests blocked', Y.w && Y.w.verified === true, Y.w);
  } catch (e) {
    chk('no exception 2: ' + e.message, false);
  }

  s2.kill();

  const s3 = start(8793, { ALLOWED_ORIGINS: 'https://mygame.example', MAX_PER_IP: '2' });
  await sleep(900);

  try {
    let blocked = false;
    try {
      await client(8793, { name: 'x' }, { origin: 'https://evil.example' });
      await sleep(300);
    } catch (e) {
      blocked = true;
    }
    chk('foreign origin refused', blocked);

    const o1 = await client(8793, { name: 'a', guest: 'guestffffffff6' }, { origin: 'https://mygame.example' });
    const o2 = await client(8793, { name: 'b', guest: 'guestgggggggg7' }, { origin: 'https://mygame.example' });
    await sleep(400);

    let third = false;
    try {
      await client(8793, { name: 'c', guest: 'guesthhhhhhhh8' }, { origin: 'https://mygame.example' });
      await sleep(300);
    } catch (e) {
      third = true;
    }
    chk('per-address connection cap', o1.w && o2.w && third);
  } catch (e) {
    chk('no exception 3: ' + e.message, false);
  }

  s3.kill();
  stub.close();

  console.log(ok, 'passed', bad.length, 'failed', bad);
  process.exit(bad.length ? 1 : 0);
})();
