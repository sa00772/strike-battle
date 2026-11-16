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
const tkd = require('./tkd');

/* ------------------------------ 설정 ------------------------------ */
const PORT = Number(process.env.PORT) || 3000;
const USE_HTTP = process.argv.includes('--http') || process.env.USE_HTTP === '1';
const DEFAULT_ROUND_SEC = Number(process.env.ROUND_SEC) || 180; // 라운드 기본 3분
const DEFAULT_REST_SEC = Number(process.env.REST_SEC) || 60;    // 휴식 기본 1분
const ALLOWED_DURATIONS = [180, 90, 60, 30];                        // 선택 가능한 시간: 3분 / 1분 / 30초
const ALLOWED_COOLDOWNS = [3, 5, 10];                          // 깃발 탈취 후 쿨타임(초) 선택지
const DEFAULT_FLAG_COOLDOWN_SEC = 5;
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

const GAME_TYPES = ['strike', 'flag', 'neon', 'flip'];
const FLIP_TILES = 81;                                   // 9 x 9 판
const FLIP_DEFAULT_ROUND_SEC = 90;                       // 판 뒤집기 기본 1분 30초
const MISSION_SOUNDS = ['alarm', 'cheer', 'wrong', 'none'];
const newFlip = () => ({ tiles: Array(FLIP_TILES).fill('0') });   // '0' 비어 있음, 'b' 청, 'r' 홍
const newMission = () => ({ active: false, text: '', sec: 10, sound: 'alarm', phoneSound: false, endsAt: 0, wasRunning: false });
const NEON_COLORS = [{ name: '초록', hex: '#22c55e' }];   // 신호는 항상 초록불
const NEON_WAIT_MIN_MS = 2000, NEON_WAIT_MAX_MS = 5000;  // 신호가 뜨기까지 무작위 대기
const NEON_GO_TIMEOUT_MS = 3000;                         // 신호 후 아무도 안 누르면 무효
const NEON_RESULT_MS = 1800;                             // 결과 표시 시간
const newNeon = () => ({ phase: 'idle', roundNo: 0, nextAt: 0, goAt: 0, resultUntil: 0, color: null, last: null, best: { blue: null, red: null } });

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
      gameType: 'strike',                           // 'strike' | 'flag' | 'neon' (점수판이 정함)
      neon: newNeon(),
      flip: newFlip(),
      mission: newMission(),
      flags: { blue: 0, red: 0 },                   // 깃발이 빼앗겨 있는 동안의 종료 시각(ms)
      flagCooldownSec: DEFAULT_FLAG_COOLDOWN_SEC,
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
  return {
    blue: size('team:blue'),
    red: size('team:red'),
    bases: { blue: size('base:blue'), red: size('base:red') },
  };
}
const roomSocketCount = (room) =>
  ['scoreboard', 'team:blue', 'team:red', 'base:blue', 'base:red']
    .reduce((n, name) => n + (io.sockets.adapter.rooms.get(rn(room, name))?.size || 0), 0);

// 인증을 통과해 해당 경기방에 들어온 소켓에게만 전송
const toJoined = (room, event, data) =>
  io.to(rn(room, 'scoreboard')).to(rn(room, 'team:blue')).to(rn(room, 'team:red'))
    .to(rn(room, 'base:blue')).to(rn(room, 'base:red')).emit(event, data);

// 깃발 상태: 팀별 남은 잠금 시간(ms)을 보내면 각 화면이 자기 시계로 카운트다운
const flagSnapshot = (room) => {
  const now = Date.now();
  return {
    blue: Math.max(0, room.flags.blue - now),
    red: Math.max(0, room.flags.red - now),
    cooldownSec: room.flagCooldownSec,
  };
};
const emitFlags = (room) => toJoined(room, 'flag:update', flagSnapshot(room));

// 반응속도 게임 상태 (다음 신호까지 남은 시간 같은 정답 힌트는 보내지 않음)
const neonSnapshot = (room) => {
  const n = room.neon;
  return {
    phase: n.phase, roundNo: n.roundNo, color: n.color, last: n.last, best: n.best,
  };
};
const emitNeon = (room) => toJoined(room, 'neon:state', neonSnapshot(room));

// 디지털 판 뒤집기: 타일 상태와 점유 수(= 점수)
const flipCounts = (room) => ({
  blue: room.flip.tiles.filter((t) => t === 'b').length,
  red: room.flip.tiles.filter((t) => t === 'r').length,
});
const flipSnapshot = (room) => ({ tiles: room.flip.tiles.join(''), ...flipCounts(room), total: FLIP_TILES });
const emitFlip = (room) => toJoined(room, 'flip:state', flipSnapshot(room));
function resetFlip(room) {
  room.flip = newFlip();
  room.scores.blue = 0;
  room.scores.red = 0;
  emitFlip(room);
}

// 돌발 미션: 게임 타이머를 멈추고 미션 카운트다운 → 끝나면(또는 사범님이 누르면) 자동 재개
const missionSnapshot = (room) => {
  const m = room.mission;
  return { text: m.text, sec: m.sec, sound: m.sound, phoneSound: m.phoneSound, remainingMs: Math.max(0, m.endsAt - Date.now()) };
};
function endMission(room, reason) {
  const m = room.mission;
  if (!m.active) return;
  const g = room.game;
  let resumed = false;
  m.active = false;
  if (m.wasRunning && !g.running && !g.finished && g.remainingMs > 0) {
    g.endAt = Date.now() + g.remainingMs;
    g.running = true;
    resumed = true;
  }
  m.wasRunning = false;
  emitState(room);
  toJoined(room, 'mission:end', { resumed, reason, phoneSound: m.phoneSound });
}

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
    if (room.mission.active && Date.now() >= room.mission.endsAt) endMission(room, 'timeout');
    if (!room.game.running) continue;
    const rem = room.game.endAt - Date.now();
    if (rem <= 0) { finishTimer(room); continue; }
    if (Math.ceil(rem / 1000) !== room.lastEmittedSec) emitState(room);
  }
}, 200);

// 반응속도 게임 진행: 라운드(타이머)가 진행 중일 때만 신호를 반복해서 보냄
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.gameType !== 'neon') continue;
    const n = room.neon;
    const live = room.game.running && room.game.mode === 'round';
    if (!live) {
      if (n.phase !== 'idle') { n.phase = 'idle'; n.color = null; emitNeon(room); }
      continue;
    }
    if (n.phase === 'idle') {
      n.phase = 'waiting';
      n.roundNo += 1;
      n.color = null;
      n.nextAt = now + NEON_WAIT_MIN_MS + Math.random() * (NEON_WAIT_MAX_MS - NEON_WAIT_MIN_MS);
      emitNeon(room);
    } else if (n.phase === 'waiting' && now >= n.nextAt) {
      n.phase = 'go';
      n.goAt = now;
      n.color = NEON_COLORS[Math.floor(Math.random() * NEON_COLORS.length)];
      emitNeon(room);
    } else if (n.phase === 'go' && now - n.goAt > NEON_GO_TIMEOUT_MS) {
      n.phase = 'result';
      n.resultUntil = now + NEON_RESULT_MS;
      n.last = { team: null, ms: null, roundNo: n.roundNo };
      emitNeon(room);
    } else if (n.phase === 'result' && now >= n.resultUntil) {
      n.phase = 'idle';
      emitNeon(room);
    }
  }
}, 50);

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
  // 태권도 경기(공인품새 / 자유품새) 이벤트 처리
  tkd.attach(io, socket, {
    ADMIN_PASSWORD, ACCESS_CODE, safeEqual, ipOf, isLocked, recordFail,
    clearFail: (ip) => failures.delete(ip),
  });

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
      if (GAME_TYPES.includes(payload.game) && room.gameType !== payload.game) {
        room.gameType = payload.game;                 // 점수판이 연 게임 종류로 방을 설정
        room.neon = newNeon();
        room.flip = newFlip();
        room.roundSec = payload.game === 'flip' ? FLIP_DEFAULT_ROUND_SEC : DEFAULT_ROUND_SEC;
        if (!room.game.running && room.game.mode === 'round') room.game.remainingMs = room.roundSec * 1000;
      }
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
      const isBase = payload.role === 'base';   // 사이버 쟁탈전의 기지(거점) 기기
      socket.data.role = isBase ? 'base' : 'pad';
      socket.data.team = payload.team;
      socket.join(rn(room, `${isBase ? 'base' : 'team'}:${payload.team}`));
      socket.emit('join:result', { ok: true, role: socket.data.role, team: payload.team, room: roomId });
    } else {
      return;
    }
    socket.data.roomId = roomId;
    room.emptySince = null;
    socket.emit('game:state', publicState(room));
    socket.emit('score:update', { ...room.scores, lastHit: null });
    socket.emit('flag:update', flagSnapshot(room));
    socket.emit('neon:state', neonSnapshot(room));
    socket.emit('room:game', room.gameType);
    socket.emit('flip:state', flipSnapshot(room));
    if (room.mission.active) socket.emit('mission:start', missionSnapshot(room));
    emitCounts(room);
  });

  // 모바일 → 서버: 타격 신호 (팀은 서버가 기억하는 값을 신뢰)
  socket.on('hit', (_payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = roomOf(socket);
    const team = socket.data.team;
    if (!room || socket.data.role !== 'pad' || !team) return reply({ accepted: false, reason: 'no-team' });
    if (room.gameType !== 'strike') return reply({ accepted: false, reason: 'wrong-game' });

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

  // 점수판 역할 소켓만 허용하는 래퍼 (자기 방 기준)
  const onlyScoreboard = (fn) => (...args) => {
    if (socket.data.role !== 'scoreboard') return;
    const room = roomOf(socket);
    if (room) fn(room, ...args);
  };

  // 모바일 → 서버: 판 뒤집기. 눌린 칸을 내 팀 색으로 뒤집고, 점유한 칸 수가 곧 점수
  socket.on('flip', (payload = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = roomOf(socket);
    const team = socket.data.team;
    if (!room || socket.data.role !== 'pad' || !team) return reply({ accepted: false, reason: 'no-team' });
    if (room.gameType !== 'flip') return reply({ accepted: false, reason: 'wrong-game' });
    if (!(room.game.running && room.game.mode === 'round')) return reply({ accepted: false, reason: 'inactive' });
    const i = Number(payload.i);
    if (!Number.isInteger(i) || i < 0 || i >= FLIP_TILES) return reply({ accepted: false, reason: 'bad-tile' });
    const now = Date.now();
    if (now - (socket.data.lastFlip || 0) < 80) return reply({ accepted: false, reason: 'cooldown' });
    const mark = team === 'blue' ? 'b' : 'r';
    if (room.flip.tiles[i] === mark) return reply({ accepted: false, reason: 'same' });
    socket.data.lastFlip = now;
    room.flip.tiles[i] = mark;
    const c = flipCounts(room);
    room.scores.blue = c.blue;
    room.scores.red = c.red;
    emitScores(room, team);
    emitFlip(room);
    reply({ accepted: true });
  });

  // 점수판/리모컨 → 서버: 돌발 미션 송출 (게임 일시정지 + 카운트다운)
  socket.on('mission:send', onlyScoreboard((room, p = {}) => {
    const text = String(p.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!text) return;
    const sec = Math.min(60, Math.max(3, Math.round(Number(p.sec) || 10)));
    const sound = MISSION_SOUNDS.includes(p.sound) ? p.sound : 'alarm';
    const m = room.mission;
    const g = room.game;
    if (!m.active) m.wasRunning = g.running;          // 이미 미션 중이면 원래 진행 여부 유지
    if (g.running) { g.remainingMs = Math.max(0, g.endAt - Date.now()); g.running = false; }
    m.active = true;
    m.text = text;
    m.sec = sec;
    m.sound = sound;
    m.phoneSound = !!p.phoneSound;
    m.endsAt = Date.now() + sec * 1000;
    emitState(room);
    toJoined(room, 'mission:start', missionSnapshot(room));
  }));
  socket.on('mission:resume', onlyScoreboard((room) => endMission(room, 'manual')));

  // 모바일 → 서버: 반응속도 게임 터치.
  //  - 신호 전(waiting)에 누르면 '부정 출발' → 이번 라운드 실격
  //  - 신호 후(go) 가장 먼저 누른 기기의 팀이 +1점
  socket.on('tap', (_payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = roomOf(socket);
    const team = socket.data.team;
    if (!room || socket.data.role !== 'pad' || !team) return reply({ accepted: false, reason: 'no-team' });
    if (room.gameType !== 'neon') return reply({ accepted: false, reason: 'wrong-game' });
    if (!(room.game.running && room.game.mode === 'round')) return reply({ accepted: false, reason: 'inactive' });

    const n = room.neon;
    const now = Date.now();
    if (socket.data.neonLock === n.roundNo) return reply({ accepted: false, reason: 'locked' });

    if (n.phase === 'waiting') {
      socket.data.neonLock = n.roundNo;
      return reply({ accepted: false, reason: 'early' });
    }
    if (n.phase !== 'go') return reply({ accepted: false, reason: 'no-signal' });

    const ms = now - n.goAt;
    n.phase = 'result';
    n.resultUntil = now + NEON_RESULT_MS;
    n.last = { team, ms, roundNo: n.roundNo };
    if (n.best[team] === null || ms < n.best[team]) n.best[team] = ms;
    room.scores[team] += 1;
    emitScores(room, team);
    emitNeon(room);
    reply({ accepted: true, ms });
  });

  // 기지 기기 → 서버: 깃발 터치. 이 기기의 팀이 '수비', 반대 팀이 '탈취'한 것으로 처리
  socket.on('capture', (_payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = roomOf(socket);
    if (!room || socket.data.role !== 'base') return reply({ accepted: false, reason: 'no-base' });
    if (room.gameType !== 'flag') return reply({ accepted: false, reason: 'wrong-game' });

    const now = Date.now();
    if (now - (socket.data.lastCapture || 0) < 300) return reply({ accepted: false, reason: 'cooldown' });
    if (!(room.game.running && room.game.mode === 'round')) return reply({ accepted: false, reason: 'inactive' });

    const defender = socket.data.team;
    const attacker = defender === 'blue' ? 'red' : 'blue';
    if (room.flags[defender] > now) return reply({ accepted: false, reason: 'locked' });

    socket.data.lastCapture = now;
    room.flags[defender] = now + room.flagCooldownSec * 1000;
    room.scores[attacker] += 1;
    emitScores(room, attacker);
    emitFlags(room);
    reply({ accepted: true, attacker, lockMs: room.flagCooldownSec * 1000 });
  });

  // PC 점수판 → 서버: 타이머/점수 제어 (자기 방의 scoreboard 역할만 허용)

  socket.on('timer:start', onlyScoreboard((room) => {
    const g = room.game;
    if (room.mission.active) { endMission(room, 'manual'); if (g.running) return; }
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
    room.flags.blue = 0;
    room.flags.red = 0;
    room.neon = newNeon();
    emitNeon(room);
    resetFlip(room);
    if (room.mission.active) { room.mission.active = false; room.mission.wasRunning = false; toJoined(room, 'mission:end', { resumed: false, reason: 'reset', phoneSound: false }); }
    emitState(room);
    emitScores(room, null);
    emitFlags(room);
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

  // 깃발 탈취 후 쿨타임(3 / 5 / 10초)
  socket.on('flag:setCooldown', onlyScoreboard((room, sec) => {
    if (!ALLOWED_COOLDOWNS.includes(sec)) return;
    room.flagCooldownSec = sec;
    emitFlags(room);
  }));

  socket.on('score:reset', onlyScoreboard((room) => {
    if (room.gameType === 'flip') resetFlip(room);
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
  console.log('  🎮 플레이 라운지 서버가 실행 중입니다');
  console.log(line);
  console.log(`  감지된 로컬 IPv4 : ${LAN_IPS.length ? LAN_IPS.join(', ') : '(없음 - 네트워크 연결 확인)'}`);
  console.log(`  PC 점수판        : ${proto}://${primary}:${PORT}/   (메뉴에서 게임을 고르면 새 경기방이 만들어집니다)`);
  console.log('  플레이 라운지    : 메인 주소(/)의 메뉴에서 게임을 선택');
  console.log('  모바일/기지 주소 : 점수판 화면의 QR 코드를 스캔 (경기방 ID 포함)');
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
