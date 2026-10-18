'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const CFG = {
  port: +process.env.PORT || 8787,
  maxPlayers: +process.env.MAX_PLAYERS || 40,
  perIp: +process.env.MAX_PER_IP || 5,
  supabaseUrl: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
  anonKey: process.env.SUPABASE_ANON_KEY || '',
  allowGuests: process.env.ALLOW_GUESTS !== '0',
  saveFile: process.env.SAVE_FILE || path.join(__dirname, 'data', 'players.json'),
  citizens: +process.env.CITIZENS || 28,
  origins: (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  tick: 100,
};

const NAV = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'lagos_nav.json'), 'utf8'));
const BOX = NAV.col.map(b => ({ minX: b[0], maxX: b[1], minZ: b[2], maxZ: b[3] }));
const MINUTES_PER_SEC = NAV.minutes || 1.1;
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function inBox(x, z, m) {
  for (const b of BOX) {
    if (x > b.minX - m && x < b.maxX + m && z > b.minZ - m && z < b.maxZ + m) return true;
  }
  return false;
}

function inLagos(x, z) {
  return Math.abs(x) < 195 && Math.abs(z) < 195;
}

function pushOut(p, r) {
  let hit = false;
  for (const b of BOX) {
    const cx = clamp(p.x, b.minX, b.maxX);
    const cz = clamp(p.z, b.minZ, b.maxZ);
    const dx = p.x - cx;
    const dz = p.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 < r * r) {
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        p.x = cx + (dx / d) * r;
        p.z = cz + (dz / d) * r;
      } else {
        const l = p.x - b.minX;
        const rr = b.maxX - p.x;
        const t = p.z - b.minZ;
        const bt = b.maxZ - p.z;
        const m = Math.min(l, rr, t, bt);
        if (m === l) p.x = b.minX - r;
        else if (m === rr) p.x = b.maxX + r;
        else if (m === t) p.z = b.minZ - r;
        else p.z = b.maxZ + r;
      }
      hit = true;
    }
  }
  return hit;
}

const WORLD = { time: 8 * 60, day: 1, wx: 'clear', wxT: 0, wxNext: 300, t0: Date.now() };

function pickWeather() {
  const r = Math.random();
  return r < 0.5 ? 'clear' : r < 0.75 ? 'cloudy' : r < 0.93 ? 'rain' : 'storm';
}

function stepWorld(dt) {
  const m = dt * MINUTES_PER_SEC;
  WORLD.time += m;
  while (WORLD.time >= 1440) {
    WORLD.time -= 1440;
    WORLD.day++;
  }
  WORLD.wxT += m;
  if (WORLD.wxT > WORLD.wxNext) {
    WORLD.wxT = 0;
    WORLD.wxNext = rand(120, 420);
    WORLD.wx = pickWeather();
  }
}

const CIT = [];

function randomFreePoint() {
  for (let i = 0; i < 200; i++) {
    const x = rand(-180, 180);
    const z = rand(-180, 180);
    if (!inBox(x, z, 1.2)) return { x, z };
  }
  return { x: 0, z: 0 };
}

for (let i = 0; i < CFG.citizens; i++) {
  const p = randomFreePoint();
  CIT.push({
    id: 'c' + i,
    x: p.x,
    z: p.z,
    h: rand(0, 6.28),
    v: 0,
    sp: rand(1.1, 1.8),
    tx: p.x,
    tz: p.z,
    wait: rand(0, 6),
    stuck: 0,
    look: Math.floor(Math.random() * 1e6),
  });
}

function stepCitizens(dt) {
  for (const c of CIT) {
    if (c.wait > 0) {
      c.wait -= dt;
      c.v = 0;
      continue;
    }
    const dx = c.tx - c.x;
    const dz = c.tz - c.z;
    const d = Math.hypot(dx, dz);
    if (d < 1) {
      c.wait = rand(2, 9);
      const a = rand(0, 6.28);
      const r = rand(15, 60);
      let tx = clamp(c.x + Math.sin(a) * r, -185, 185);
      let tz = clamp(c.z + Math.cos(a) * r, -185, 185);
      if (inBox(tx, tz, 1.2)) {
        const p = randomFreePoint();
        tx = p.x;
        tz = p.z;
      }
      c.tx = tx;
      c.tz = tz;
      c.stuck = 0;
      continue;
    }
    const px = c.x;
    const pz = c.z;
    c.x += (dx / d) * c.sp * dt;
    c.z += (dz / d) * c.sp * dt;
    pushOut(c, 0.4);
    c.h = Math.atan2(dx, dz);
    c.v = c.sp;
    if (Math.hypot(c.x - px, c.z - pz) < c.sp * dt * 0.3) {
      c.stuck += dt;
      if (c.stuck > 2) {
        c.wait = 1;
        c.tx = c.x;
        c.tz = c.z;
      }
    } else {
      c.stuck = 0;
    }
  }
}

const saved = (() => {
  try {
    return JSON.parse(fs.readFileSync(CFG.saveFile, 'utf8'));
  } catch (e) {
    return {};
  }
})();

function saveAll() {
  try {
    fs.mkdirSync(path.dirname(CFG.saveFile), { recursive: true });
    const tmp = CFG.saveFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(saved));
    fs.renameSync(tmp, CFG.saveFile);
  } catch (e) {
    console.error('save failed', e.message);
  }
}

const players = new Map();
const VMAX = {
  foot: 9,
  sedan: 62,
  suv: 60,
  hatch: 60,
  luxury: 66,
  taxi: 60,
  van: 55,
  pickup: 58,
  danfo: 50,
  keke: 40,
  okada: 48,
  heli: 60,
  tank: 16,
};

const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').slice(0, n);

async function verifyToken(tok) {
  if (!tok || !CFG.supabaseUrl || !CFG.anonKey) return null;
  try {
    const r = await fetch(CFG.supabaseUrl + '/auth/v1/user', {
      headers: {
        apikey: CFG.anonKey,
        authorization: 'Bearer ' + tok,
      },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? 'u:' + u.id : null;
  } catch (e) {
    return null;
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ ok: true, players: players.size, citizens: CIT.length, day: WORLD.day, time: Math.round(WORLD.time), wx: WORLD.wx }));
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({
  server,
  maxPayload: 4096,
  verifyClient: (info, cb) => {
    const o = info.origin || '';
    if (CFG.origins.length && !CFG.origins.includes(o)) {
      return cb(false, 403, 'origin');
    }
    const ip = info.req.socket.remoteAddress;
    let n = 0;
    for (const p of players.values()) if (p.ip === ip) n++;
    if (n >= CFG.perIp) return cb(false, 429, 'too many from this address');
    cb(true);
  },
});

function send(ws, o) {
  if (ws.readyState === 1) ws.send(JSON.stringify(o));
}

function sysAll(text) {
  for (const p of players.values()) send(p.ws, { t: 'sys', text });
}

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  let me = null;
  ws.isAlive = true;

  const authTimer = setTimeout(() => {
    if (!me) ws.close(4001, 'join timeout');
  }, 6000);

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', async raw => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!m || typeof m.t !== 'string') return;

    if (!me) {
      if (m.t !== 'join' || ws.joining) return;
      ws.joining = true;

      if (players.size >= CFG.maxPlayers) {
        send(ws, { t: 'err', text: 'World is full (' + CFG.maxPlayers + ' players). Try again later.' });
        return ws.close(4002, 'full');
      }

      let key = await verifyToken(m.token);
      let verified = !!key;

      if (!key) {
        if (!CFG.allowGuests) {
          send(ws, { t: 'err', text: 'Sign in to join this world.' });
          return ws.close(4003, 'auth');
        }
        const g = clean(m.guest, 24).replace(/[^\w-]/g, '');
        key = 'g:' + (g.length >= 8 ? g : crypto.randomBytes(6).toString('hex'));
      }

      for (const p of players.values()) {
        if (p.key === key) {
          send(p.ws, { t: 'err', text: 'Signed in somewhere else.' });
          p.ws.close(4004, 'dup');
          players.delete(p.id);
        }
      }

      clearTimeout(authTimer);
      const rec = saved[key] || {};
      const id = crypto.randomBytes(4).toString('hex');
      const name = clean(m.name, 14).trim() || rec.name || 'Player';
      let x = rec.x,
        z = rec.z;
      if (typeof x !== 'number' || typeof z !== 'number' || (inLagos(x, z) && inBox(x, z, 0.3))) {
        x = 7.4 + rand(-2, 2);
        z = 24 + rand(-2, 2);
      }

      me = { id, key, verified, name, ws, ip, x, z, h: rec.h || 0, v: 0, ty: 'foot', c: 0, a: 0, loc: 'out', last: Date.now(), tpAt: 0, chatAt: 0, msgs: 0, msgT: Date.now(), strikes: 0, sent: 0 };
      players.set(id, me);
      send(ws, { t: 'welcome', id, name, x, z, verified, time: WORLD.time, day: WORLD.day, wx: WORLD.wx, tick: CFG.tick, players: players.size });
      sysAll(name + ' entered the world');
      return;
    }

    const now = Date.now();
    if (now - me.msgT > 1000) {
      me.msgT = now;
      me.msgs = 0;
    }
    if (++me.msgs > 60) {
      if (++me.strikes > 5) ws.close(4005, 'flood');
      return;
    }

    if (m.t === 'in') onInput(me, m);
    else if (m.t === 'chat') onChat(me, m);
    else if (m.t === 'tp') onTeleport(me, m);
    else if (m.t === 'rename') me.name = clean(m.name, 14).trim() || me.name;
    else if (m.t === 'ping') send(ws, { t: 'pong', n: m.n });
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (me && players.get(me.id) === me) {
      players.delete(me.id);
      saved[me.key] = { name: me.name, x: me.x, z: me.z, h: me.h, seen: Date.now() };
      saveAll();
      sysAll(me.name + ' left');
    }
  });

  ws.on('error', () => {});
});

function onInput(p, m) {
  const x = +m.x, z = +m.z;
  if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > 20000 || Math.abs(z) > 20000) return;
  const now = Date.now();
  const dt = clamp((now - p.last) / 1000, 0.02, 2);
  p.last = now;

  const ty = VMAX[m.ty] ? m.ty : 'foot';
  const vmax = VMAX[ty];
  const moved = Math.hypot(x - p.x, z - p.z);
  const allowed = vmax * dt * 1.6 + 1.5;

  if (moved > allowed) {
    p.strikes++;
    send(p.ws, { t: 'fix', x: p.x, z: p.z, why: 'speed' });
    return;
  }

  const alt = clamp(+m.a || 0, 0, 500);
  if (inLagos(x, z) && alt < 3 && ty !== 'heli' && m.loc === 'out' && inBox(x, z, 0.25) && !inBox(p.x, p.z, 0.25)) {
    send(p.ws, { t: 'fix', x: p.x, z: p.z, why: 'wall' });
    return;
  }

  p.x = x;
  p.z = z;
  p.h = +m.h || 0;
  p.v = clamp(+m.v || 0, -80, 80);
  p.ty = ty;
  p.c = (m.c >>> 0) & 0xffffff;
  p.a = alt;
  p.loc = m.loc === 'out' ? 'out' : 'in';

  if (p.strikes > 0 && Math.random() < 0.02) p.strikes--;
  if (p.strikes > 40) {
    send(p.ws, { t: 'err', text: 'Disconnected: repeated impossible movement.' });
    p.ws.close(4006, 'cheat');
  }
}

function onTeleport(p, m) {
  const now = Date.now();
  if (now - p.tpAt < 4000) return send(p.ws, { t: 'fix', x: p.x, z: p.z, why: 'tp-rate' });
  const x = +m.x, z = +m.z;
  if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > 20000 || Math.abs(z) > 20000) return;
  p.tpAt = now;
  p.x = x;
  p.z = z;
  p.last = now;
  console.log('tp', p.name, Math.round(x), Math.round(z), clean(m.why, 20));
}

function onChat(p, m) {
  const now = Date.now();
  if (now - p.chatAt < 900) return;
  p.chatAt = now;

  const text = clean(m.text, 80).trim();
  if (!text) return;

  const world = m.scope === 'world';
  const msg = { t: 'chat', from: p.name, id: p.id, text, scope: world ? 'world' : 'local' };

  for (const o of players.values()) {
    if (world || Math.hypot(o.x - p.x, o.z - p.z) < 70) send(o.ws, msg);
  }
}

let last = Date.now();
let snapN = 0;

setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.5, (now - last) / 1000);
  last = now;
  stepWorld(dt);
  stepCitizens(dt);
  snapN++;

  for (const p of players.values()) {
    const near = [];
    const R = 320;
    for (const o of players.values()) {
      if (o === p) continue;
      if (Math.abs(o.x - p.x) < R && Math.abs(o.z - p.z) < R) {
        near.push([o.id, o.name, +o.x.toFixed(1), +o.z.toFixed(1), +o.h.toFixed(2), +o.v.toFixed(1), o.ty, o.c, +o.a.toFixed(1), o.loc]);
      }
    }

    const cit = [];
    if (inLagos(p.x, p.z) || Math.abs(p.x) < 400) {
      for (const c of CIT) {
        if (Math.abs(c.x - p.x) < 150 && Math.abs(c.z - p.z) < 150) {
          cit.push([c.id, +c.x.toFixed(1), +c.z.toFixed(1), +c.h.toFixed(2), +c.v.toFixed(1), c.look]);
        }
      }
    }

    const o = { t: 'snap', p: near, c: cit };
    if (snapN % 10 === 0) {
      o.time = WORLD.time;
      o.day = WORLD.day;
      o.wx = WORLD.wx;
      o.n = players.size;
    }
    send(p.ws, o);
  }
}, CFG.tick);

setInterval(() => {
  for (const p of players.values()) {
    saved[p.key] = { name: p.name, x: p.x, z: p.z, h: p.h, seen: Date.now() };
  }
  saveAll();
}, 30000);

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (e) {}
  }
}, 20000);

server.listen(CFG.port, () => console.log('Naija Life world server on :' + CFG.port + ' (guests ' + (CFG.allowGuests ? 'allowed' : 'blocked') + ', logins ' + (CFG.supabaseUrl ? 'verified via Supabase' : 'not verified') + ')'));

process.on('SIGTERM', () => {
  saveAll();
  process.exit(0);
});

process.on('SIGINT', () => {
  saveAll();
  process.exit(0);
});
