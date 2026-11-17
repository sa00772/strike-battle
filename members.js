/**
 * 회원 시스템 (가입 / 로그인 / 회원별 개인 데이터베이스)
 *
 *  - 공용 DB   : <DATA_DIR>/main.db            회원 정보, 로그인 세션
 *  - 개인 DB   : <DATA_DIR>/members/<번호>.db   회원마다 따로 쓰는 DB (선수 명단, 경기 기록)
 *  - Node 내장 node:sqlite 사용 (Node 22.13 이상) · 비밀번호는 scrypt 해시로만 저장
 *  - Railway 에서는 Volume 을 만들어 DATA_DIR(예: /data)에 연결해야 재배포해도 데이터가 남습니다.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (_) { /* Node 버전이 낮으면 회원 기능만 꺼짐 */ }

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const SESSION_DAYS = 30;
const COOKIE = 'pl_session';

const USERNAME_RE = /^[a-z0-9_]{4,20}$/;
const PHONE_RE = /^0\d{1,2}-?\d{3,4}-?\d{4}$/;
const ORG_TYPES = ['dojang', 'school', 'etc'];

function init() {
  if (!DatabaseSync) return null;
  fs.mkdirSync(path.join(DATA_DIR, 'members'), { recursive: true });
  const main = new DatabaseSync(path.join(DATA_DIR, 'main.db'));
  main.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      salt TEXT NOT NULL,
      pw_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      org_type TEXT NOT NULL,
      org TEXT NOT NULL,
      phone TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      member_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  return main;
}

const main = init();
const memberDbs = new Map();

function memberDb(id) {
  let db = memberDbs.get(id);
  if (db) return db;
  db = new DatabaseSync(path.join(DATA_DIR, 'members', `${Number(id)}.db`));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS roster (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL,
      played_at INTEGER NOT NULL
    );
  `);
  memberDbs.set(id, db);
  return db;
}

/* ------------------------------ 비밀번호 ------------------------------ */
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');
function checkPw(pw, salt, hash) {
  const a = Buffer.from(hashPw(pw, salt), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ------------------------------ 세션 ------------------------------ */
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function memberFromCookieHeader(header) {
  if (!main) return null;
  const token = parseCookies(header)[COOKIE];
  if (!token) return null;
  const row = main.prepare(
    `SELECT m.id, m.username, m.name, m.org_type, m.org, m.phone, m.created_at
       FROM sessions s JOIN members m ON m.id = s.member_id
      WHERE s.token_hash = ? AND s.expires_at > ?`
  ).get(sha(token), Date.now());
  return row || null;
}

function startSession(res, memberId, secure) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = SESSION_DAYS * 86400;
  main.prepare('INSERT INTO sessions (token_hash, member_id, expires_at) VALUES (?, ?, ?)')
    .run(sha(token), memberId, Date.now() + maxAge * 1000);
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

/* ------------------------------ 입력 검증 ------------------------------ */
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

function validateSignup(b) {
  const name = clean(b.name, 20);
  const org = clean(b.org, 30);
  const orgType = ORG_TYPES.includes(b.orgType) ? b.orgType : 'etc';
  const username = clean(b.username, 20).toLowerCase();
  const password = String(b.password || '');
  const phone = clean(b.phone, 13).replace(/\s/g, '');
  if (name.length < 2) return { error: '이름을 2자 이상 입력해 주세요.', field: 'name' };
  if (!org) return { error: '소속(도장 또는 학교)을 입력해 주세요.', field: 'org' };
  if (!USERNAME_RE.test(username)) return { error: '아이디는 영문 소문자·숫자·밑줄(_) 4~20자로 입력해 주세요.', field: 'username' };
  if (password.length < 8 || password.length > 64) return { error: '비밀번호는 8자 이상 64자 이하로 입력해 주세요.', field: 'password' };
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return { error: '비밀번호에 영문과 숫자를 함께 넣어 주세요.', field: 'password' };
  if (password.toLowerCase().includes(username)) return { error: '비밀번호에 아이디를 넣을 수 없어요.', field: 'password' };
  if (!PHONE_RE.test(phone)) return { error: '전화번호를 010-1234-5678 형식으로 입력해 주세요.', field: 'phone' };
  return { value: { name, org, orgType, username, password, phone } };
}

const publicMember = (m) => ({
  id: m.id, username: m.username, name: m.name, orgType: m.org_type, org: m.org, phone: m.phone,
  createdAt: m.created_at,
});

/* ------------------------------ 라우터 ------------------------------ */
function mount(app, express) {
  const json = express.json({ limit: '20kb' });
  const isSecure = (req) => req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';

  // 로그인/가입 시도 제한 (IP당 10분에 20회)
  const hits = new Map();
  function limited(req) {
    const ip = (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
    const now = Date.now();
    const h = hits.get(ip) || { n: 0, t: now };
    if (now - h.t > 10 * 60 * 1000) { h.n = 0; h.t = now; }
    h.n += 1;
    hits.set(ip, h);
    return h.n > 20;
  }

  const off = (_req, res, next) => {
    if (!main) return res.status(503).json({ error: '이 서버는 회원 기능을 지원하지 않는 Node 버전입니다. (Node 22.13 이상 필요)' });
    next();
  };
  const auth = (req, res, next) => {
    const m = memberFromCookieHeader(req.headers.cookie);
    if (!m) return res.status(401).json({ error: '로그인이 필요합니다.' });
    req.member = m;
    next();
  };

  app.post('/api/signup', off, json, (req, res) => {
    if (limited(req)) return res.status(429).json({ error: '시도가 너무 많아요. 잠시 후 다시 해 주세요.' });
    const v = validateSignup(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error, field: v.field });
    const d = v.value;
    if (main.prepare('SELECT 1 FROM members WHERE username = ?').get(d.username)) {
      return res.status(409).json({ error: '이미 사용 중인 아이디예요.', field: 'username' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const r = main.prepare(
      'INSERT INTO members (username, salt, pw_hash, name, org_type, org, phone, created_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(d.username, salt, hashPw(d.password, salt), d.name, d.orgType, d.org, d.phone, Date.now());
    const id = Number(r.lastInsertRowid);
    memberDb(id);                                   // 개인 DB 파일 생성
    startSession(res, id, isSecure(req));
    res.json({ ok: true });
  });

  app.post('/api/login', off, json, (req, res) => {
    if (limited(req)) return res.status(429).json({ error: '시도가 너무 많아요. 잠시 후 다시 해 주세요.' });
    const username = clean((req.body || {}).username, 20).toLowerCase();
    const password = String((req.body || {}).password || '');
    const row = main.prepare('SELECT * FROM members WHERE username = ?').get(username);
    const ok = row ? checkPw(password, row.salt, row.pw_hash) : (hashPw(password, 'x'.repeat(32)), false);
    if (!ok) return res.status(401).json({ error: '아이디 또는 비밀번호가 맞지 않아요.' });
    startSession(res, row.id, isSecure(req));
    res.json({ ok: true });
  });

  app.post('/api/logout', off, (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) main.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
    clearCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    const m = main ? memberFromCookieHeader(req.headers.cookie) : null;
    res.json({ member: m ? publicMember(m) : null, enabled: !!main });
  });

  // 회원 탈퇴: 비밀번호 확인 후 회원 정보와 개인 DB 파일까지 삭제
  app.delete('/api/me', off, auth, json, (req, res) => {
    const row = main.prepare('SELECT * FROM members WHERE id = ?').get(req.member.id);
    if (!checkPw(String((req.body || {}).password || ''), row.salt, row.pw_hash)) {
      return res.status(403).json({ error: '비밀번호가 맞지 않아요.' });
    }
    main.prepare('DELETE FROM sessions WHERE member_id = ?').run(row.id);
    main.prepare('DELETE FROM members WHERE id = ?').run(row.id);
    const db = memberDbs.get(row.id);
    if (db) { try { db.close(); } catch (_) {} memberDbs.delete(row.id); }
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(path.join(DATA_DIR, 'members', `${row.id}.db${ext}`)); } catch (_) {}
    }
    clearCookie(res);
    res.json({ ok: true });
  });

  // 선수 명단 (회원 개인 DB)
  app.get('/api/my/roster', off, auth, (req, res) => {
    res.json({ items: memberDb(req.member.id).prepare('SELECT id, name, note FROM roster ORDER BY id DESC').all() });
  });
  app.post('/api/my/roster', off, auth, json, (req, res) => {
    const name = clean((req.body || {}).name, 20);
    const note = clean((req.body || {}).note, 40);
    if (!name) return res.status(400).json({ error: '이름을 입력해 주세요.' });
    const db = memberDb(req.member.id);
    if (db.prepare('SELECT COUNT(*) c FROM roster').get().c >= 500) return res.status(400).json({ error: '명단은 500명까지 저장할 수 있어요.' });
    const r = db.prepare('INSERT INTO roster (name, note, created_at) VALUES (?,?,?)').run(name, note, Date.now());
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  });
  app.delete('/api/my/roster/:id', off, auth, (req, res) => {
    memberDb(req.member.id).prepare('DELETE FROM roster WHERE id = ?').run(Number(req.params.id) || 0);
    res.json({ ok: true });
  });

  // 경기 기록 (회원 개인 DB)
  app.get('/api/my/records', off, auth, (req, res) => {
    const rows = memberDb(req.member.id)
      .prepare('SELECT id, game, title, data, played_at FROM records ORDER BY id DESC LIMIT 200').all();
    res.json({ items: rows.map((r) => ({ id: r.id, game: r.game, title: r.title, playedAt: r.played_at, data: safeParse(r.data) })) });
  });
  app.delete('/api/my/records/:id', off, auth, (req, res) => {
    memberDb(req.member.id).prepare('DELETE FROM records WHERE id = ?').run(Number(req.params.id) || 0);
    res.json({ ok: true });
  });
}

const safeParse = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };

/** 점수판이 끝낸 경기를 해당 회원의 개인 DB에 저장 */
function saveRecord(memberId, game, title, data) {
  if (!main || !memberId) return false;
  try {
    const db = memberDb(memberId);
    db.prepare('INSERT INTO records (game, title, data, played_at) VALUES (?,?,?,?)')
      .run(String(game).slice(0, 20), String(title || '').slice(0, 60), JSON.stringify(data), Date.now());
    db.prepare('DELETE FROM records WHERE id NOT IN (SELECT id FROM records ORDER BY id DESC LIMIT 1000)').run();
    return true;
  } catch (e) {
    console.error('경기 기록 저장 실패:', e.message);
    return false;
  }
}

module.exports = { mount, memberFromCookieHeader, saveRecord, enabled: !!main, DATA_DIR };
