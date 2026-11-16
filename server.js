/**
 * 청팀 vs 홍팀 실시간 모션 센서 타격 대결 - 서버
 *
 *  실행:   npm start          (HTTPS, 자체 서명 인증서 자동 생성)
 *          npm run start:http (HTTP / 클라우드 배포용)
 *
 *  경기방(Room) 구조
 *    점수판을 열 때마다 독립된 경기방이 만들어지고, 점수·타이머·접속자는 방마다 따로 관리됩니다.
 *    Socket.io 방 이름:  <방ID>:scoreboard / <방ID>:team:blue / <방ID>:team:red
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

/* ------------------------------ 설정 ------------------------------ */
const PORT = Number(process.env.PORT) || 3000;
const USE_HTTP = process.argv.includes('--http') || process.env.USE_HTTP === '1';
const DEFAULT_ROUND_SEC = Number(process.env.ROUND_SEC) || 180; // 라운드 기본 3분
const DEFAULT_REST_SEC = Number(process.env.REST_SEC) || 60;    // 휴식 기본 1분
const ALLOWED_DURATIONS = [180, 60, 30];                        // 선택 가능한 시간: 3분 / 1분 / 30초
const HIT_MIN_INTERVAL_MS = 250;                                // 서버측 연타 방지
const TEAMS = ['blue', 'red'];
const ROOM_ID_RE = /^[A-Z0-9]{4,12}$/;
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000;                       // 접속자가 없는 방은 30분 뒤 삭제

/* ------------------------- 접근 제어 (코드 방식) -------------------------
 *  ADMIN_PASSWORD : PC 점수판에 들어갈 때 필요한 관리자 비밀번호
 *  ACCESS_CODE    : 모바일 패드에 들어갈 때 필요한 참가 코드
 *  둘 다 비워 두면 해당 보호는 꺼집니다(누구나 접속 가능).
 */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ACCESS_CODE = process.env.ACCESS_CODE || '';

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
// 틀린 코드를 5번 입력하면 해당 IP를 60초간 잠금
const MAX_FAILS = 5;
const LOCK_MS = 60 * 1000;
const failures = new Map();
const ipOf = (socket) =>
  (socket.handshake.headers['x-forwarded-for'] || '').split(',')[0].trim() || socket.handshake.address;
const isLocked = (ip) => { const f = failures.get(ip); return !!(f && f.until > Date.now()); };
function recordFail(ip) {
  const f = failures.get(ip) || { count: 0, until: 0 };
  if (f.until && f.until <= Date.now()) { f.count = 0; f.until = 0; }
  f.count += 1;
  if (f.count >= MAX_FAILS) { f.until = Date.now() + LOCK_MS; f.count = 0; }
  failures.set(ip, f);
}

/* ------------------------- 로컬 IP 자동 감지 ------------------------- */
function getLanIPs() {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      const family = typeof a.family === 'string' ? a.family : a.family === 4 ? 'IPv4' : 'IPv6';
      if (family === 'IPv4' && !a.internal) found.push({ name, address: a.address });
    }
  }
  const rank = ({ name, address }) => {
    let r = 3;
    if (address.startsWith('192.168.')) r = 0;
    else if (address.startsWith('10.')) r = 1;
    else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) r = 2;
    else if (address.startsWith('169.254.')) r = 9;
    if (/vmware|virtualbox|vbox|docker|vethernet|hyper-v|wsl|tailscale|zerotier|vpn/i.test(name)) r += 5;
    return r;
  };
  found.sort((x, y) => rank(x) - rank(y));
  const ips = found.map((f) => f.address);
  if (process.env.HOST_IP) ips.unshift(process.env.HOST_IP);
  return [...new Set(ips)];
}
const LAN_IPS = getLanIPs();

/* --------------------- HTTPS 인증서 (자체 서명) --------------------- */
function loadOrCreateCert(ips) {
  const dir = path.join(__dirname, 'certs');
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  const metaPath = path.join(dir, 'ips.json');

  let needNew = true;
  if (fs.existsSync(keyPath) && fs.existsSync(certPath) && fs.existsSync(metaPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      needNew = ips.some((ip) => !saved.includes(ip));
    } catch (_) { /* 손상 시 재발급 */ }
  }
  if (needNew) {
    const selfsigned = require('selfsigned');
    const altNames = [
      { type: 2, value: 'localhost' },
      { type: 7, ip: '127.0.0.1' },
      ...ips.map((ip) => ({ type: 7, ip })),
    ];
    const pems = selfsigned.generate([{ name: 'commonName', value: 'strike-battle.local' }], {
      days: 825,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames }],
    });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyPath, pems.private);
    fs.writeFileSync(certPath, pems.cert);
    fs.writeFileSync(metaPath, JSON.stringify(ips));
    console.log('🔐 자체 서명 인증서를 새로 생성했습니다. (./certs)');
  }
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

/* ------------------------------ 서버 ------------------------------ */
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (_req, res) => {
  res.json({
    protocol: USE_HTTP ? 'http' : 'https',
    port: PORT,
    ips: LAN_IPS,
    roundSec: DEFAULT_ROUND_SEC,
    restSec: DEFAULT_REST_SEC,
  });
});

const server = USE_HTTP ? http.createServer(app) : https.createServer(loadOrCreateCert(LAN_IPS), app);
const io = new Server(server);

/* --------------------------- 경기방 상태 --------------------------- */
const rooms = new Map(); // roomId -> room

function getOrCreateRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    room = {
      id,
      scores: { blue: 0, red: 0 },
      roundSec: DEFAULT_ROUND_SEC,
      restSec: DEFAULT_REST_SEC,
      game: {
        mode: 'round',                       // 'round' | 'rest'
        running: false,
        finished: false,                     // 현재 모드의 시간이 끝난 상태
        remainingMs: DEFAULT_ROUND_SEC * 1000,
        endAt: 0,
      },
      lastEmittedSec: null,
      emptySince: null,
    };
    rooms.set(id, room);
  }
  return room;
}

const roomOf = (socket) => rooms.get(socket.data.roomId);
const rn = (room, name) => `${room.id}:${name}`;
const durationMs = (room, mode) => (mode === 'round' ? room.roundSec : room.restSec) * 1000;
const currentRemainingMs = (room) =>
  room.game.running ? Math.max(0, room.game.endAt - Date.now()) : room.game.remainingMs;

function publicState(room) {
  const g = room.game;
  return {
    mode: g.mode,
    running: g.running,
    finished: g.finished,
    remainingSec: Math.ceil(currentRemainingMs(room) / 1000),
    totalSec: durationMs(room, g.mode) / 1000,
    roundSec: room.roundSec,
    restSec: room.restSec,
  };
}
function connectedCounts(room) {
  const size = (name) => io.sockets.adapter.rooms.get(rn(room, name))?.size || 0;
  return { blue: size('team:blue'), red: size('team:red') };
}
const roomSocketCount = (room) =>
  ['scoreboard', 'team:blue', 'team:red']
    .reduce((n, name) => n + (io.sockets.adapter.rooms.get(rn(room, name))?.size || 0), 0);

// 인증을 통과해 해당 경기방에 들어온 소켓에게만 전송
const toJoined = (room, event, data) =>
  io.to(rn(room, 'scoreboard')).to(rn(room, 'team:blue')).to(rn(room, 'team:red')).emit(event, data);

function emitState(room) {
  const s = publicState(room);
  room.lastEmittedSec = s.remainingSec;
  toJoined(room, 'game:state', s);
}
const emitScores = (room, lastHit = null) => toJoined(room, 'score:update', { ...room.scores, lastHit });
const emitCounts = (room) => io.to(rn(room, 'scoreboard')).emit('team:count', connectedCounts(room));

function finishTimer(room) {
  const g = room.game;
  const finishedMode = g.mode;
  g.running = false;
  g.remainingMs = 0;
  g.finished = true;
  const { blue, red } = room.scores;
  const winner = blue === red ? 'draw' : blue > red ? 'blue' : 'red';
  toJoined(room, 'timer:end', { mode: finishedMode, scores: { ...room.scores }, winner });
  emitState(room);
}

// 0.2초마다 모든 방의 타이머 확인 → 초가 바뀔 때만 해당 방에 브로드캐스트
setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.game.running) continue;
    const rem = room.game.endAt - Date.now();
    if (rem <= 0) { finishTimer(room); continue; }
    if (Math.ceil(rem / 1000) !== room.lastEmittedSec) emitState(room);
  }
}, 200);

// 접속자가 없는 방 정리
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (roomSocketCount(room) > 0) { room.emptySince = null; continue; }
    if (!room.emptySince) room.emptySince = now;
    else if (now - room.emptySince > EMPTY_ROOM_TTL_MS) rooms.delete(id);
  }
}, 60 * 1000);

/* ---------------------------- 소켓 처리 ---------------------------- */
io.on('connection', (socket) => {
  // 역할 등록 + 인증: 점수판(관리자 비밀번호) 또는 팀 패드(참가 코드)
  socket.on('join', (payload = {}) => {
    for (const r of socket.rooms) if (r !== socket.id) socket.leave(r);
    socket.data.role = null;
    socket.data.team = null;
    socket.data.roomId = null;

    const ip = ipOf(socket);
    const reject = (reason) => socket.emit('join:result', { ok: false, reason });
    if (isLocked(ip)) return reject('rate-limited');

    const roomId = String(payload.room || '').toUpperCase();
    if (!ROOM_ID_RE.test(roomId)) return reject('bad-room');

    let room;
    if (payload.role === 'scoreboard') {
      if (ADMIN_PASSWORD) {
        if (!payload.password) return reject('password-required');
        if (!safeEqual(payload.password, ADMIN_PASSWORD)) { recordFail(ip); return reject('bad-password'); }
        failures.delete(ip);
      }
      room = getOrCreateRoom(roomId);                 // 점수판만 방을 만들 수 있음
      socket.data.role = 'scoreboard';
      socket.join(rn(room, 'scoreboard'));
      socket.emit('join:result', { ok: true, role: 'scoreboard', room: roomId, accessCode: ACCESS_CODE || null });
    } else if (TEAMS.includes(payload.team)) {
      if (ACCESS_CODE) {
        if (!payload.code) return reject('code-required');
        if (!safeEqual(payload.code, ACCESS_CODE)) { recordFail(ip); return reject('bad-code'); }
        failures.delete(ip);
      }
      room = rooms.get(roomId);
      if (!room) return reject('no-room');
      socket.data.role = 'pad';
      socket.data.team = payload.team;
      socket.join(rn(room, `team:${payload.team}`));
      socket.emit('join:result', { ok: true, role: 'pad', team: payload.team, room: roomId });
    } else {
      return;
    }
    socket.data.roomId = roomId;
    room.emptySince = null;
    socket.emit('game:state', publicState(room));
    socket.emit('score:update', { ...room.scores, lastHit: null });
    emitCounts(room);
  });

  // 모바일 → 서버: 타격 신호 (팀은 서버가 기억하는 값을 신뢰)
  socket.on('hit', (_payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = roomOf(socket);
    const team = socket.data.team;
    if (!room || !team) return reply({ accepted: false, reason: 'no-team' });

    const now = Date.now();
    if (now - (socket.data.lastHit || 0) < HIT_MIN_INTERVAL_MS) {
      return reply({ accepted: false, reason: 'cooldown' });
    }
    if (!(room.game.running && room.game.mode === 'round')) {
      return reply({ accepted: false, reason: 'inactive' });
    }
    socket.data.lastHit = now;
    room.scores[team] += 1;
    emitScores(room, team);
    reply({ accepted: true, score: room.scores[team] });
  });

  // PC 점수판 → 서버: 타이머/점수 제어 (자기 방의 scoreboard 역할만 허용)
  const onlyScoreboard = (fn) => (...args) => {
    if (socket.data.role !== 'scoreboard') return;
    const room = roomOf(socket);
    if (room) fn(room, ...args);
  };

  socket.on('timer:start', onlyScoreboard((room) => {
    const g = room.game;
    if (g.running) return;
    if (g.finished || g.remainingMs <= 0) {
      // 끝난 상태에서 시작 → 다음 모드(라운드↔휴식)로 넘어가서 시작
      g.mode = g.mode === 'round' ? 'rest' : 'round';
      g.remainingMs = durationMs(room, g.mode);
      g.finished = false;
    }
    g.endAt = Date.now() + g.remainingMs;
    g.running = true;
    emitState(room);
  }));

  socket.on('timer:pause', onlyScoreboard((room) => {
    const g = room.game;
    if (!g.running) return;
    g.remainingMs = Math.max(0, g.endAt - Date.now());
    g.running = false;
    emitState(room);
  }));

  // 초기화: 타이머를 현재 모드의 전체 시간으로 되돌리고, 점수(기록)도 0점으로 초기화
  socket.on('timer:reset', onlyScoreboard((room) => {
    const g = room.game;
    g.running = false;
    g.finished = false;
    g.remainingMs = durationMs(room, g.mode);
    room.scores.blue = 0;
    room.scores.red = 0;
    emitState(room);
    emitScores(room, null);
  }));

  socket.on('timer:setMode', onlyScoreboard((room, mode) => {
    if (mode !== 'round' && mode !== 'rest') return;
    const g = room.game;
    g.mode = mode;
    g.running = false;
    g.finished = false;
    g.remainingMs = durationMs(room, mode);
    emitState(room);
  }));

  // 현재 모드의 시간을 3분 / 1분 / 30초 중에서 변경 (점수는 유지)
  socket.on('timer:setDuration', onlyScoreboard((room, payload = {}) => {
    const { mode, sec } = payload;
    if ((mode !== 'round' && mode !== 'rest') || !ALLOWED_DURATIONS.includes(sec)) return;
    if (mode === 'round') room.roundSec = sec; else room.restSec = sec;
    if (room.game.mode === mode) {
      room.game.running = false;
      room.game.finished = false;
      room.game.remainingMs = durationMs(room, mode);
    }
    emitState(room);
  }));

  socket.on('score:reset', onlyScoreboard((room) => {
    room.scores.blue = 0;
    room.scores.red = 0;
    emitScores(room, null);
  }));

  socket.on('disconnect', () => {
    const room = roomOf(socket);
    if (room) emitCounts(room);
  });
});

/* ------------------------------ 시작 ------------------------------ */
server.listen(PORT, '0.0.0.0', () => {
  const proto = USE_HTTP ? 'http' : 'https';
  const primary = LAN_IPS[0] || 'localhost';
  const line = '='.repeat(62);
  console.log(`\n${line}`);
  console.log('  🥊 청팀 vs 홍팀 타격 대결 서버가 실행 중입니다');
  console.log(line);
  console.log(`  감지된 로컬 IPv4 : ${LAN_IPS.length ? LAN_IPS.join(', ') : '(없음 - 네트워크 연결 확인)'}`);
  console.log(`  PC 점수판        : ${proto}://${primary}:${PORT}/   (열 때마다 새 경기방이 만들어집니다)`);
  console.log('  모바일 주소      : 점수판 화면의 QR 코드를 스캔 (경기방 ID 포함)');
  console.log(`\n  관리자 비밀번호(ADMIN_PASSWORD) : ${ADMIN_PASSWORD ? '설정됨' : '⚠ 미설정 - 누구나 점수판 조작 가능'}`);
  console.log(`  참가 코드(ACCESS_CODE)         : ${ACCESS_CODE ? '설정됨' : '⚠ 미설정 - 누구나 모바일 참가 가능'}`);
  if (!USE_HTTP) {
    console.log('\n  ※ 자체 서명 인증서라서 처음 접속 시 보안 경고가 나옵니다.');
    console.log('    "고급 → 계속 진행(안전하지 않음)"을 눌러주세요.');
  } else {
    console.log('\n  ⚠ HTTP 모드: 직접 접속 시 iOS/최신 Android는 센서가 막힐 수 있습니다.');
    console.log('    (클라우드·터널 등 HTTPS 주소로 접속하면 정상 동작합니다)');
  }
  console.log(`${line}\n`);
});
