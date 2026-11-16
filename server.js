/**
 * 청팀 vs 홍팀 실시간 모션 센서 타격 대결 - 서버
 *
 *  실행:   npm start          (HTTPS, 자체 서명 인증서 자동 생성)
 *          npm run start:http (HTTP, 센서 권한 제약 있음 - README 참고)
 *
 *  Socket.io 방(Room) 구조
 *    - scoreboard   : PC 점수판 (타이머 제어 권한 보유)
 *    - team:blue    : 청팀 모바일 패드
 *    - team:red     : 홍팀 모바일 패드
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
let ROUND_SEC = Number(process.env.ROUND_SEC) || 180;  // 라운드 3분 (PC에서 변경 가능)
let REST_SEC = Number(process.env.REST_SEC) || 60;     // 휴식 1분 (PC에서 변경 가능)
const ALLOWED_DURATIONS = [180, 60, 30];               // 선택 가능한 시간: 3분 / 1분 / 30초
const HIT_MIN_INTERVAL_MS = 250;                        // 서버측 연타 방지(클라이언트 쿨타임 0.3초보다 약간 짧게)
const TEAMS = ['blue', 'red'];

/* ------------------------- 접근 제어 (코드 방식) -------------------------
 *  ADMIN_PASSWORD : PC 점수판(타이머/점수 조작)에 들어갈 때 필요한 관리자 비밀번호
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
  if (process.env.HOST_IP) ips.unshift(process.env.HOST_IP); // 수동 지정 시 최우선
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
      needNew = ips.some((ip) => !saved.includes(ip)); // 새 IP가 생기면 재발급
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
    roundSec: ROUND_SEC,
    restSec: REST_SEC,
  });
});

const server = USE_HTTP ? http.createServer(app) : https.createServer(loadOrCreateCert(LAN_IPS), app);
const io = new Server(server);

/* --------------------------- 게임 상태 --------------------------- */
const scores = { blue: 0, red: 0 };
const game = {
  mode: 'round',                 // 'round' | 'rest'
  running: false,
  finished: false,               // 현재 모드의 시간이 끝난 상태
  remainingMs: ROUND_SEC * 1000, // 정지 중일 때의 남은 시간
  endAt: 0,                      // 진행 중일 때의 종료 시각(ms)
};
let lastEmittedSec = null;

const durationMs = (mode) => (mode === 'round' ? ROUND_SEC : REST_SEC) * 1000;
const currentRemainingMs = () =>
  game.running ? Math.max(0, game.endAt - Date.now()) : game.remainingMs;

function publicState() {
  return {
    mode: game.mode,
    running: game.running,
    finished: game.finished,
    remainingSec: Math.ceil(currentRemainingMs() / 1000),
    totalSec: durationMs(game.mode) / 1000,
    roundSec: ROUND_SEC,
    restSec: REST_SEC,
  };
}
function connectedCounts() {
  const size = (room) => io.sockets.adapter.rooms.get(room)?.size || 0;
  return { blue: size('team:blue'), red: size('team:red') };
}
// 인증을 통과해 방(scoreboard / team:*)에 들어온 소켓에게만 전송
const toJoined = (event, data) => io.to('scoreboard').to('team:blue').to('team:red').emit(event, data);
const emitState = () => {
  const s = publicState();
  lastEmittedSec = s.remainingSec;
  toJoined('game:state', s);
};
const emitScores = (lastHit = null) => toJoined('score:update', { ...scores, lastHit });
const emitCounts = () => io.to('scoreboard').emit('team:count', connectedCounts());

function finishTimer() {
  const finishedMode = game.mode;
  game.running = false;
  game.remainingMs = 0;
  game.finished = true;
  const winner = scores.blue === scores.red ? 'draw' : scores.blue > scores.red ? 'blue' : 'red';
  toJoined('timer:end', { mode: finishedMode, scores: { ...scores }, winner });
  emitState();
}

// 0.2초마다 남은 시간 확인 → 초가 바뀔 때만 브로드캐스트
setInterval(() => {
  if (!game.running) return;
  const rem = game.endAt - Date.now();
  if (rem <= 0) return finishTimer();
  if (Math.ceil(rem / 1000) !== lastEmittedSec) emitState();
}, 200);

/* ---------------------------- 소켓 처리 ---------------------------- */
io.on('connection', (socket) => {
  // 역할 등록 + 인증: 점수판(관리자 비밀번호) 또는 팀 패드(참가 코드)
  socket.on('join', (payload = {}) => {
    for (const r of ['scoreboard', ...TEAMS.map((t) => `team:${t}`)]) socket.leave(r);
    socket.data.role = null;
    socket.data.team = null;

    const ip = ipOf(socket);
    const reject = (reason) => socket.emit('join:result', { ok: false, reason });
    if (isLocked(ip)) return reject('rate-limited');

    if (payload.role === 'scoreboard') {
      if (ADMIN_PASSWORD) {
        if (!payload.password) return reject('password-required');
        if (!safeEqual(payload.password, ADMIN_PASSWORD)) { recordFail(ip); return reject('bad-password'); }
        failures.delete(ip);
      }
      socket.data.role = 'scoreboard';
      socket.join('scoreboard');
      socket.emit('join:result', { ok: true, role: 'scoreboard', accessCode: ACCESS_CODE || null });
    } else if (TEAMS.includes(payload.team)) {
      if (ACCESS_CODE) {
        if (!payload.code) return reject('code-required');
        if (!safeEqual(payload.code, ACCESS_CODE)) { recordFail(ip); return reject('bad-code'); }
        failures.delete(ip);
      }
      socket.data.role = 'pad';
      socket.data.team = payload.team;
      socket.join(`team:${payload.team}`);
      socket.emit('join:result', { ok: true, role: 'pad', team: payload.team });
    } else {
      return;
    }
    socket.emit('game:state', publicState());
    socket.emit('score:update', { ...scores, lastHit: null });
    emitCounts();
  });

  // 모바일 → 서버: 타격 신호 (팀은 서버가 기억하는 값을 신뢰)
  socket.on('hit', (_payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const team = socket.data.team;
    if (!team) return reply({ accepted: false, reason: 'no-team' });

    const now = Date.now();
    if (now - (socket.data.lastHit || 0) < HIT_MIN_INTERVAL_MS) {
      return reply({ accepted: false, reason: 'cooldown' });
    }
    if (!(game.running && game.mode === 'round')) {
      return reply({ accepted: false, reason: 'inactive' });
    }
    socket.data.lastHit = now;
    scores[team] += 1;
    emitScores(team);
    reply({ accepted: true, score: scores[team] });
  });

  // PC 점수판 → 서버: 타이머/점수 제어 (scoreboard 역할만 허용)
  const onlyScoreboard = (fn) => (...args) => {
    if (socket.data.role === 'scoreboard') fn(...args);
  };

  socket.on('timer:start', onlyScoreboard(() => {
    if (game.running) return;
    if (game.finished || game.remainingMs <= 0) {
      // 끝난 상태에서 시작 → 다음 모드(라운드↔휴식)로 넘어가서 시작
      game.mode = game.mode === 'round' ? 'rest' : 'round';
      game.remainingMs = durationMs(game.mode);
      game.finished = false;
    }
    game.endAt = Date.now() + game.remainingMs;
    game.running = true;
    emitState();
  }));

  socket.on('timer:pause', onlyScoreboard(() => {
    if (!game.running) return;
    game.remainingMs = Math.max(0, game.endAt - Date.now());
    game.running = false;
    emitState();
  }));

  socket.on('timer:reset', onlyScoreboard(() => {
    game.running = false;
    game.finished = false;
    game.remainingMs = durationMs(game.mode);
    emitState();
  }));

  socket.on('timer:setMode', onlyScoreboard((mode) => {
    if (mode !== 'round' && mode !== 'rest') return;
    game.mode = mode;
    game.running = false;
    game.finished = false;
    game.remainingMs = durationMs(mode);
    emitState();
  }));

  // 현재 모드의 시간을 3분 / 1분 / 30초 중에서 변경 (타이머는 해당 시간으로 초기화)
  socket.on('timer:setDuration', onlyScoreboard((payload = {}) => {
    const { mode, sec } = payload;
    if ((mode !== 'round' && mode !== 'rest') || !ALLOWED_DURATIONS.includes(sec)) return;
    if (mode === 'round') ROUND_SEC = sec; else REST_SEC = sec;
    if (game.mode === mode) {
      game.running = false;
      game.finished = false;
      game.remainingMs = durationMs(mode);
    }
    emitState();
  }));

  socket.on('score:reset', onlyScoreboard(() => {
    scores.blue = 0;
    scores.red = 0;
    emitScores(null);
  }));

  socket.on('disconnect', emitCounts);
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
  console.log(`  PC 점수판        : ${proto}://${primary}:${PORT}/`);
  console.log(`  청팀 모바일      : ${proto}://${primary}:${PORT}/mobile.html?team=blue`);
  console.log(`  홍팀 모바일      : ${proto}://${primary}:${PORT}/mobile.html?team=red`);
  console.log(`\n  관리자 비밀번호(ADMIN_PASSWORD) : ${ADMIN_PASSWORD ? '설정됨' : '⚠ 미설정 - 누구나 점수판 조작 가능'}`);
  console.log(`  참가 코드(ACCESS_CODE)         : ${ACCESS_CODE ? '설정됨' : '⚠ 미설정 - 누구나 모바일 참가 가능'}`);
  if (!USE_HTTP) {
    console.log('\n  ※ 자체 서명 인증서라서 처음 접속 시 보안 경고가 나옵니다.');
    console.log('    "고급 → 계속 진행(안전하지 않음)"을 눌러주세요.');
  } else {
    console.log('\n  ⚠ HTTP 모드: iOS/최신 Android는 센서 사용이 막힐 수 있습니다.');
  }
  console.log(`${line}\n`);
});
