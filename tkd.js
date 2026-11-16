'use strict';
/**
 * 태권도 경기 모듈 (공인품새 토너먼트 / 자유품새 컷오프)
 *
 *  규정 기준: World Taekwondo "Poomsae Competition Rules and Interpretation" (2024.9.30 시행본) 및 WT 심판 채점표
 *   - 공인품새 10.0 = 정확성 4.0(작은 실수 -0.1, 큰 실수 -0.3) + 표현성 6.0(속도와 힘 / 리듬과 템포 / 기의 표현 각 0.5~2.0)
 *   - 자유품새 10.0 = 기술 6.0(기본동작 1.0 + 발기술 난이도 5.0) + 표현 4.0(창의성 / 조화 / 기의 표현 / 음악·안무)
 *   - 정확성(기술)과 표현 점수는 각각 '최고·최저 1개씩 제외한 평균'(심판 5명 이상일 때), 감점은 합산 후 차감
 *   - 컷오프: 20명 이상 예선(조별 상위 50%) → 9~19명 준결승(상위 8명) → 8명 이하 결승
 *   - 공인품새 토너먼트: 추첨 대진, 청·홍이 같은 품새를 동시에 수행하고 점수가 높은 쪽이 승리
 */
const MAX_JUDGES = 5;
const MAX_ENTRANTS = 128;
const EVENT_ID_RE = /^[A-Z0-9]{4,12}$/;
const KINDS = ['recognized', 'freestyle'];
const DEDUCTION_VALUES = { time: 0.3, line: 0.3, restart: 0.6 };
const DEDUCTION_KEYS = { recognized: ['time', 'line', 'restart'], freestyle: ['time', 'line'] };
const POOMSAE_ALL = [...Array.from({ length: 8 }, (_, i) => `태극 ${i + 1}장`), '고려', '금강', '태백', '평원', '십진', '지태', '천권', '한수', '일여'];
const DEFAULT_POOL = POOMSAE_ALL.slice(0, 8);
const MAX_PER_MATCH = 3;
// 품새 범위(시작~끝, 포함) → 후보 목록
function poolFromRange(from, to) {
  let a = POOMSAE_ALL.indexOf(from), b = POOMSAE_ALL.indexOf(to);
  if (a < 0) a = 0; if (b < 0) b = 7;
  if (a > b) [a, b] = [b, a];
  return POOMSAE_ALL.slice(a, b + 1);
}
// 후보에서 서로 다른 품새를 무작위로 count개 뽑는다
function drawPoomsae(pool, count) {
  const arr = pool.slice();
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr.slice(0, Math.max(1, Math.min(count, arr.length)));
}
const IDLE_TTL_MS = 12 * 60 * 60 * 1000;
let perfSeq = 0;                       // 경기(채점) 번호: 심판 화면이 새 경기를 구분하는 용도

const SCHEMAS = {
  recognized: {
    labels: { a: '정확성', p: '표현성' },
    fields: [
      { key: 'minor', group: 'a', type: 'count', label: '작은 실수 (-0.1)', max: 40, def: 0 },
      { key: 'major', group: 'a', type: 'count', label: '큰 실수 (-0.3)', max: 13, def: 0 },
      { key: 'power', group: 'p', type: 'score', label: '속도와 힘', min: 0.5, max: 2.0, def: 2.0 },
      { key: 'rhythm', group: 'p', type: 'score', label: '리듬과 템포', min: 0.5, max: 2.0, def: 2.0 },
      { key: 'energy', group: 'p', type: 'score', label: '기의 표현', min: 0.5, max: 2.0, def: 2.0 },
    ],
  },
  freestyle: {
    labels: { a: '기술', p: '표현' },
    fields: [
      { key: 'jumpside', group: 'a', type: 'score', label: '뛰어 옆차기', min: 0, max: 1.0, def: 0.5 },
      { key: 'multi', group: 'a', type: 'score', label: '다단계 발차기', min: 0, max: 1.0, def: 0.5 },
      { key: 'spin', group: 'a', type: 'score', label: '회전 발차기', min: 0, max: 1.0, def: 0.5 },
      { key: 'consec', group: 'a', type: 'score', label: '연속 발차기', min: 0, max: 1.0, def: 0.5 },
      { key: 'acro', group: 'a', type: 'score', label: '아크로바틱', min: 0, max: 1.0, def: 0.5 },
      { key: 'basic', group: 'a', type: 'score', label: '기본동작', min: 0, max: 1.0, def: 0.5 },
      { key: 'creative', group: 'p', type: 'score', label: '창의성', min: 0, max: 1.0, def: 0.5 },
      { key: 'harmony', group: 'p', type: 'score', label: '조화', min: 0, max: 1.0, def: 0.5 },
      { key: 'energy', group: 'p', type: 'score', label: '기의 표현', min: 0, max: 1.0, def: 0.5 },
      { key: 'music', group: 'p', type: 'score', label: '음악·안무', min: 0, max: 1.0, def: 0.5 },
    ],
  },
};

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

/* ------------------------------ 채점 계산 ------------------------------ */
function validateScores(kind, input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const f of SCHEMAS[kind].fields) {
    const v = Number(input[f.key]);
    if (!Number.isFinite(v)) return null;
    if (f.type === 'count') {
      if (!Number.isInteger(v) || v < 0 || v > f.max) return null;
      out[f.key] = v;
    } else {
      const x = r1(v);
      if (x < f.min || x > f.max) return null;
      out[f.key] = x;
    }
  }
  return out;
}
function judgeTotals(kind, v) {
  if (kind === 'recognized') {
    const a = Math.max(0, r2(4 - 0.1 * v.minor - 0.3 * v.major));
    const p = r2(v.power + v.rhythm + v.energy);
    return { a, p, total: r2(a + p) };
  }
  const a = r2(v.basic + v.jumpside + v.multi + v.spin + v.consec + v.acro);
  const p = r2(v.creative + v.harmony + v.energy + v.music);
  return { a, p, total: r2(a + p) };
}
// 심판 5명 이상이면 최고·최저 1개씩 제외한 평균, 그 미만이면 전원 평균
function trimmedMean(values, drop) {
  let v = values.slice().sort((x, y) => x - y);
  if (drop && v.length >= 5) v = v.slice(1, -1);
  return v.reduce((s, x) => s + x, 0) / v.length;
}
function combine(list, deduction) {
  const drop = list.length >= 5;
  const a = r2(trimmedMean(list.map((x) => x.a), drop));
  const p = r2(trimmedMean(list.map((x) => x.p), drop));
  return {
    a, p, ded: r2(deduction), total: Math.max(0, r2(a + p - deduction)),
    sumAll: r2(list.reduce((s, x) => s + x.total, 0)), judges: list.length, dropped: drop,
  };
}
const deductionTotal = (d) => r2((d.time ? DEDUCTION_VALUES.time : 0) + (d.line ? DEDUCTION_VALUES.line : 0) + (d.restart || 0) * DEDUCTION_VALUES.restart);
// 양수면 x가 우세: 합계 → (공인: 표현성 / 자유: 기술) → 전체 심판 점수 합(최고·최저 포함)
function cmpResult(kind, x, y) {
  if (x.total !== y.total) return x.total - y.total;
  const k = kind === 'recognized' ? 'p' : 'a';
  if (x[k] !== y[k]) return x[k] - y[k];
  return x.sumAll - y.sumAll;
}

/* ------------------------------ 대진 / 컷오프 ------------------------------ */
function seedOrder(size) {
  let r = [1, 2];
  while (r.length < size) { const len = r.length * 2; const next = []; for (const x of r) next.push(x, len + 1 - x); r = next; }
  return r;
}
function buildBracket(entrants) {
  const list = shuffle(entrants);
  const n = list.length;
  let size = 2; while (size < n) size *= 2;
  const order = seedOrder(size);
  const seat = (s) => (s <= n ? list[s - 1].id : null);
  const rounds = [];
  for (let r = 0, count = size / 2; count >= 1; r++, count /= 2) {
    rounds.push(Array.from({ length: count }, (_, i) => ({ id: `m${r}-${i}`, round: r, index: i, a: null, b: null, state: 'pending', poomsae: null, bye: false, result: null })));
  }
  rounds[0].forEach((m, i) => { m.a = seat(order[2 * i]); m.b = seat(order[2 * i + 1]); });
  rounds[0].forEach((m) => {
    if (!m.a || !m.b) { m.bye = true; m.state = 'done'; m.result = { winner: m.a ? 'a' : 'b', bye: true }; advanceWinner(rounds, m); }
  });
  return rounds;
}
function winnerId(m) { return m.result && m.result.winner ? m[m.result.winner] : null; }
function advanceWinner(rounds, m) {
  const next = rounds[m.round + 1] && rounds[m.round + 1][m.index >> 1];
  if (!next) return;
  if (m.index % 2 === 0) next.a = winnerId(m); else next.b = winnerId(m);
}
function roundName(totalRounds, r) {
  const remain = totalRounds - r;
  return remain === 1 ? '결승' : remain === 2 ? '준결승' : `${2 ** remain}강`;
}
function planStage(ids, prelimCount) {
  const n = ids.length;
  const shuffled = shuffle(ids);
  if (n <= 8) return { type: 'final', name: '결승', groups: [{ name: '결승', ids: shuffled, advance: 0 }], scores: {}, complete: false, rankings: null };
  if (n <= 19) return { type: 'semi', name: '준결승', groups: [{ name: '준결승', ids: shuffled, advance: 8 }], scores: {}, complete: false, rankings: null };
  const g = n < 40 ? 2 : 3;
  const groups = Array.from({ length: g }, (_, i) => ({ name: `${'ABC'[i]}조`, ids: [], advance: 0 }));
  shuffled.forEach((id, i) => groups[i % g].ids.push(id));
  groups.forEach((gr) => { gr.advance = Math.ceil(gr.ids.length / 2); });
  return { type: 'prelim', name: prelimCount > 0 ? `예선 ${prelimCount + 1}차` : '예선', groups, scores: {}, complete: false, rankings: null };
}
function rankGroup(kind, group, scores) {
  const entries = group.ids.map((id) => ({ id, res: scores[id] })).sort((x, y) => cmpResult(kind, y.res, x.res));
  let prev = null;
  entries.forEach((e, i) => {
    e.rank = prev && cmpResult(kind, prev.res, e.res) === 0 ? prev.rank : i + 1;
    e.advance = group.advance > 0 && e.rank <= group.advance;
    prev = e;
  });
  return entries;
}

/* ------------------------------ 이벤트 상태 ------------------------------ */
const events = new Map();

function newEvent(id, kind) {
  return {
    id, kind, phase: 'setup', judgeCount: 3, entrants: [], poomsaePool: DEFAULT_POOL.slice(), poomsaeFrom: POOMSAE_ALL[0], poomsaeTo: POOMSAE_ALL[7], poomsaePerMatch: 2, drawnPoomsae: null,
    bracket: null, stages: null, stageIdx: 0, current: null, podium: null, seats: {}, lastActive: Date.now(), prelimCount: 0,
  };
}
const entrantMap = (ev) => Object.fromEntries(ev.entrants.map((e) => [e.id, e]));
const seatList = (ev) => Array.from({ length: ev.judgeCount }, (_, i) => {
  const s = ev.seats[i + 1];
  return { seat: i + 1, connected: !!(s && s.connected), submitted: !!(ev.current && ev.current.status !== 'done' && ev.current.submitted[i + 1]) };
});
const connectedSeats = (ev) => Object.keys(ev.seats).map(Number).filter((n) => ev.seats[n].connected && n <= ev.judgeCount).sort();

function sideInfo(ev, c) {
  const em = entrantMap(ev);
  if (c.type === 'match') {
    const m = ev.bracket[c.round][c.index];
    return [{ side: 'a', label: '청', ...(em[m.a] || {}) }, { side: 'b', label: '홍', ...(em[m.b] || {}) }];
  }
  return [{ side: 'solo', label: '', ...(em[c.entrantId] || {}) }];
}

function adminSnapshot(ev) {
  const c = ev.current;
  let current = null;
  if (c) {
    current = {
      type: c.type, status: c.status, poomsae: c.poomsae, poomsaeList: c.poomsaeList || null, pass: c.pass || 0, passCount: c.passCount || 1, regularCount: c.regularCount || c.passCount || 1, tiebreak: !!c.tiebreak, passResults: c.passResults || [], matchId: c.matchId || null, entrantId: c.entrantId || null,
      sides: sideInfo(ev, c), deductions: c.deductions, activeSeats: c.activeSeats,
      submitted: c.submitted, result: c.status === 'done' ? c.result : null,
      judgeScores: c.status === 'done' ? Object.fromEntries(Object.entries(c.scores).map(([side, bySeat]) => [side, Object.fromEntries(Object.entries(bySeat).map(([seat, s]) => [seat, { a: s.a, p: s.p, total: s.total }]))])) : null,
    };
  }
  return {
    id: ev.id, kind: ev.kind, phase: ev.phase, judgeCount: ev.judgeCount, entrants: ev.entrants, poomsaePool: ev.poomsaePool,
    poomsaeDrawn: ev.drawnPoomsae, poomsaeAll: POOMSAE_ALL, poomsaeFrom: ev.poomsaeFrom, poomsaeTo: ev.poomsaeTo, poomsaePerMatch: ev.poomsaePerMatch,
    seats: seatList(ev), schema: SCHEMAS[ev.kind], deductionValues: DEDUCTION_VALUES, deductionKeys: DEDUCTION_KEYS[ev.kind],
    bracket: ev.bracket ? ev.bracket.map((round, r) => ({ name: roundName(ev.bracket.length, r), matches: round })) : null,
    stages: ev.stages, stageIdx: ev.stageIdx, current, podium: ev.podium,
  };
}
function judgeSnapshot(ev, seat) {
  const c = ev.current;
  const active = c && c.status === 'scoring' && c.activeSeats.includes(seat);
  return {
    id: ev.id, kind: ev.kind, phase: ev.phase, judgeCount: ev.judgeCount, seat, schema: SCHEMAS[ev.kind],
    perf: active ? { seq: c.seq, poomsae: c.poomsae, pass: c.pass || 0, passCount: c.passCount || 1, tiebreak: !!c.tiebreak, sides: sideInfo(ev, c), mySubmitted: !!c.submitted[seat], myScores: c.submitted[seat] ? Object.fromEntries(Object.entries(c.scores).map(([side, bySeat]) => [side, bySeat[seat] ? { ...bySeat[seat].vals, a: bySeat[seat].a, p: bySeat[seat].p, total: bySeat[seat].total } : null])) : null } : null,
    waitingReview: !!(c && c.status === 'review' && c.activeSeats.includes(seat)),
  };
}

/* ------------------------------ 진행 로직 ------------------------------ */
const avg = (arr, k) => r2(arr.reduce((t, x) => t + x[k], 0) / arr.length);
function mergePasses(list) {
  if (list.length === 1) return list[0];
  return { a: avg(list, 'a'), p: avg(list, 'p'), ded: avg(list, 'ded'), total: avg(list, 'total'), sumAll: r2(list.reduce((t, x) => t + x.sumAll, 0)), judges: list[0].judges, dropped: list.some((x) => x.dropped) };
}
function finalizePerf(ev) {
  const c = ev.current;
  const sides = c.type === 'match' ? ['a', 'b'] : ['solo'];
  const one = {};
  let tbDiff = 0;
  for (const side of sides) {
    const list = Object.values(c.scores[side] || {});
    if (!list.length) return false;
    one[side] = combine(list, deductionTotal(c.deductions[side]));
  }
  if (c.type === 'match') {
    c.passResults = c.passResults || [];
    c.passResults.push({ poomsae: c.poomsae, tb: !!c.tiebreak, ...one });
    const openPass = () => {                                                  // 같은 경기 안에서 채점을 새로 연다
      const seats = connectedSeats(ev);
      if (seats.length) c.activeSeats = seats;
      c.poomsae = c.poomsaeList[c.pass];
      c.seq = ++perfSeq; c.status = 'scoring'; c.submitted = {}; c.scores = {};
      c.deductions = Object.fromEntries(sides.map((sd) => [sd, { time: false, line: false, restart: 0 }]));
      c.result = null;
    };
    const addTiebreak = () => {                                               // 동점: 아직 하지 않은 다른 품새를 하나 더
      let cand = ev.poomsaePool.filter((x) => !c.poomsaeList.includes(x));
      if (!cand.length) cand = ev.poomsaePool.filter((x) => x !== c.poomsae);
      if (!cand.length) cand = ev.poomsaePool.slice();
      c.poomsaeList.push(cand[Math.floor(Math.random() * cand.length)]);
      c.passCount = c.poomsaeList.length; c.pass = c.passCount - 1; c.tiebreak = true;
      openPass();
    };
    if (c.tiebreak) {
      tbDiff = cmpResult(ev.kind, one.a, one.b);
      if (tbDiff === 0) { addTiebreak(); return true; }                        // 추가 품새도 동점이면 또 하나
    } else if (c.pass < c.regularCount - 1) { c.pass += 1; openPass(); return true; }
    else {
      const base = { a: mergePasses(c.passResults.map((pr) => pr.a)), b: mergePasses(c.passResults.map((pr) => pr.b)) };
      if (cmpResult(ev.kind, base.a, base.b) === 0) { addTiebreak(); return true; }
    }
  }
  const result = {};
  for (const side of sides) result[side] = c.type === 'match' ? mergePasses(c.passResults.filter((pr) => !pr.tb).map((pr) => pr[side])) : one[side];
  c.result = result;
  c.status = 'done';
  if (c.type === 'match') {
    const m = ev.bracket[c.round][c.index];
    const diff = c.tiebreak ? tbDiff : cmpResult(ev.kind, result.a, result.b);
    const tbs = c.passResults.filter((pr) => pr.tb).map((pr) => ({ poomsae: pr.poomsae, a: pr.a.total, b: pr.b.total }));
    m.state = 'done';
    m.poomsae = c.poomsaeList.join(' · ');
    m.result = { winner: diff > 0 ? 'a' : 'b', a: result.a, b: result.b, poomsae: c.poomsaeList.join(' · '), tiebreak: tbs.length > 0,
      passes: c.passResults.filter((pr) => !pr.tb).map((pr) => ({ poomsae: pr.poomsae, a: pr.a.total, b: pr.b.total })), tb: tbs };
    c.result.winner = m.result.winner;
    c.result.tb = tbs;
    advanceWinner(ev.bracket, m);
    const last = ev.bracket[ev.bracket.length - 1][0];
    if (last.state === 'done') finishBracket(ev);
  } else {
    const st = ev.stages[ev.stageIdx];
    st.scores[c.entrantId] = result.solo;
    if (st.groups.every((g) => g.ids.every((id) => st.scores[id]))) {
      st.complete = true;
      st.rankings = st.groups.map((g) => ({ name: g.name, advance: g.advance, entries: rankGroup(ev.kind, g, st.scores) }));
    }
  }
  return true;
}
function finishBracket(ev) {
  ev.phase = 'finished';
  const rounds = ev.bracket;
  const fin = rounds[rounds.length - 1][0];
  const loserOf = (m) => (m.bye || !m.result ? null : m[m.result.winner === 'a' ? 'b' : 'a']);
  const bronze = rounds.length >= 2 ? rounds[rounds.length - 2].map(loserOf).filter(Boolean) : [];
  ev.podium = { gold: [winnerId(fin)], silver: [loserOf(fin)].filter(Boolean), bronze };
}

/* ------------------------------ 소켓 연결 ------------------------------ */
function attach(io, socket, auth) {
  const adminRoom = (id) => `T:${id}:admin`;
  const seatRoom = (id, n) => `T:${id}:seat:${n}`;
  const lobbyRoom = (id) => `T:${id}:lobby`;

  const broadcast = (ev) => {
    ev.lastActive = Date.now();
    io.to(adminRoom(ev.id)).emit('tkd:state', adminSnapshot(ev));
    for (let n = 1; n <= ev.judgeCount; n++) io.to(seatRoom(ev.id, n)).emit('tkd:judge', judgeSnapshot(ev, n));
    io.to(lobbyRoom(ev.id)).emit('tkd:seats', { judgeCount: ev.judgeCount, seats: seatList(ev) });
  };
  const err = (code, extra) => socket.emit('tkd:error', { code, ...extra });
  const leaveAll = () => { for (const r of socket.rooms) if (r !== socket.id && String(r).startsWith('T:')) socket.leave(r); };

  socket.on('tkd:join', (p = {}) => {
    leaveAll();
    socket.data.tkd = null;
    const ip = auth.ipOf(socket);
    const fail = (reason) => socket.emit('tkd:join:result', { ok: false, reason });
    if (auth.isLocked(ip)) return fail('rate-limited');
    const id = String(p.event || '').toUpperCase();
    if (!EVENT_ID_RE.test(id)) return fail('bad-event');

    if (p.role === 'admin') {
      if (auth.ADMIN_PASSWORD) {
        if (!p.password) return fail('password-required');
        if (!auth.safeEqual(p.password, auth.ADMIN_PASSWORD)) { auth.recordFail(ip); return fail('bad-password'); }
        auth.clearFail(ip);
      }
      let ev = events.get(id);
      if (!ev) {
        if (!KINDS.includes(p.kind)) return fail('bad-kind');
        ev = newEvent(id, p.kind); events.set(id, ev);
      }
      socket.data.tkd = { role: 'admin', id };
      socket.join(adminRoom(id));
      socket.emit('tkd:join:result', { ok: true, role: 'admin', kind: ev.kind, event: id, accessCode: auth.ACCESS_CODE || null });
      socket.emit('tkd:state', adminSnapshot(ev));
      return;
    }

    if (p.role === 'judge') {
      const ev = events.get(id);
      if (!ev) return fail('no-event');
      if (auth.ACCESS_CODE) {
        if (!p.code) return fail('code-required');
        if (!auth.safeEqual(p.code, auth.ACCESS_CODE)) { auth.recordFail(ip); return fail('bad-code'); }
        auth.clearFail(ip);
      }
      const seat = Number(p.seat);
      if (!p.seat) {                                                       // 좌석 선택 화면
        socket.join(lobbyRoom(id));
        socket.data.tkd = { role: 'lobby', id };
        return socket.emit('tkd:join:result', { ok: true, role: 'lobby', kind: ev.kind, judgeCount: ev.judgeCount, seats: seatList(ev) });
      }
      const token = String(p.token || '');
      if (!Number.isInteger(seat) || seat < 1 || seat > ev.judgeCount) return fail('bad-seat');
      if (token.length < 8) return fail('bad-token');
      const cur = ev.seats[seat];
      if (cur && cur.connected && cur.token !== token) return fail('seat-taken');
      ev.seats[seat] = { sid: socket.id, token, connected: true };
      socket.data.tkd = { role: 'judge', id, seat };
      socket.join(seatRoom(id, seat));
      socket.emit('tkd:join:result', { ok: true, role: 'judge', seat, kind: ev.kind });
      broadcast(ev);
      return;
    }
    fail('bad-role');
  });

  socket.on('disconnect', () => {
    const t = socket.data.tkd;
    if (!t || t.role !== 'judge') return;
    const ev = events.get(t.id);
    if (ev && ev.seats[t.seat] && ev.seats[t.seat].sid === socket.id) { ev.seats[t.seat].connected = false; broadcast(ev); }
  });

  const admin = (fn) => (payload = {}) => {
    const t = socket.data.tkd;
    if (!t || t.role !== 'admin') return;
    const ev = events.get(t.id);
    if (ev) fn(ev, payload);
  };

  socket.on('tkd:config', admin((ev, p) => {
    if (ev.phase !== 'setup') return err('not-setup');
    const maxSeat = Math.max(0, ...connectedSeats(ev));
    ev.judgeCount = Math.min(MAX_JUDGES, Math.max(1, maxSeat, Math.round(Number(p.judgeCount) || ev.judgeCount)));
    const lines = Array.isArray(p.entrants) ? p.entrants : String(p.entrants || '').split(/\r?\n/);
    ev.entrants = lines.map((l) => String(l).trim()).filter(Boolean).slice(0, MAX_ENTRANTS).map((l, i) => {
      const [name, ...rest] = l.split('/');
      return { id: `e${i + 1}`, name: name.trim().slice(0, 30), team: rest.join('/').trim().slice(0, 30) };
    }).filter((e) => e.name);
    if (p.poomsaeFrom || p.poomsaeTo) {
      ev.poomsaeFrom = POOMSAE_ALL.includes(p.poomsaeFrom) ? p.poomsaeFrom : ev.poomsaeFrom;
      ev.poomsaeTo = POOMSAE_ALL.includes(p.poomsaeTo) ? p.poomsaeTo : ev.poomsaeTo;
      ev.poomsaePool = poolFromRange(ev.poomsaeFrom, ev.poomsaeTo);
    } else if (p.poomsaePool) {                                              // (이전 방식) 직접 목록 지정
      const pool = (Array.isArray(p.poomsaePool) ? p.poomsaePool : String(p.poomsaePool).split(/[,\n]/)).map((x) => String(x).trim().slice(0, 20)).filter(Boolean).slice(0, 40);
      if (pool.length) ev.poomsaePool = pool;
    }
    if (p.poomsaePerMatch != null) ev.poomsaePerMatch = Math.min(MAX_PER_MATCH, Math.max(1, Math.round(Number(p.poomsaePerMatch)) || 1));
    broadcast(ev);
  }));

  socket.on('tkd:draw', admin((ev) => {
    if (ev.phase !== 'setup') return err('not-setup');
    if (ev.entrants.length < 2) return err('few-entrants');
    ev.current = null; ev.podium = null; ev.prelimCount = 0;
    if (ev.kind === 'recognized') {
      ev.bracket = buildBracket(ev.entrants); ev.stages = null;
      ev.drawnPoomsae = drawPoomsae(ev.poomsaePool, ev.poomsaePerMatch);          // 대진 추첨과 함께 품새도 추첨: 모든 경기가 같은 품새
    }
    else { ev.bracket = null; ev.stages = [planStage(ev.entrants.map((e) => e.id), 0)]; ev.stageIdx = 0; }
    ev.phase = 'running';
    broadcast(ev);
  }));

  socket.on('tkd:reset', admin((ev) => {
    ev.phase = 'setup'; ev.drawnPoomsae = null; ev.bracket = null; ev.stages = null; ev.stageIdx = 0; ev.current = null; ev.podium = null;
    broadcast(ev);
  }));

  const startPerf = (ev, spec) => {
    if (ev.current && ev.current.status !== 'done') return err('busy');
    const seats = connectedSeats(ev);
    if (!seats.length) return err('no-judge');
    ev.current = {
      ...spec, seq: ++perfSeq, status: 'scoring', activeSeats: seats, submitted: {}, scores: {},
      deductions: Object.fromEntries((spec.type === 'match' ? ['a', 'b'] : ['solo']).map((s) => [s, { time: false, line: false, restart: 0 }])),
      result: null,
    };
    broadcast(ev);
  };

  socket.on('tkd:startMatch', admin((ev, p) => {
    if (ev.kind !== 'recognized' || ev.phase !== 'running') return;
    const m = ev.bracket.flat().find((x) => x.id === p.matchId);
    if (!m || m.state !== 'pending' || !m.a || !m.b) return err('bad-match');
    const poomsaeList = (ev.drawnPoomsae && ev.drawnPoomsae.length ? ev.drawnPoomsae : drawPoomsae(ev.poomsaePool, ev.poomsaePerMatch)).slice();
    startPerf(ev, { type: 'match', matchId: m.id, round: m.round, index: m.index, poomsae: poomsaeList[0], poomsaeList, pass: 0, passCount: poomsaeList.length, regularCount: poomsaeList.length, tiebreak: false, passResults: [] });
  }));

  socket.on('tkd:startSolo', admin((ev, p) => {
    if (ev.kind !== 'freestyle' || ev.phase !== 'running') return;
    const st = ev.stages[ev.stageIdx];
    if (st.complete) return err('stage-complete');
    const order = st.groups.flatMap((g) => g.ids);
    const id = p.entrantId && order.includes(p.entrantId) ? p.entrantId : order.find((x) => !st.scores[x]);
    if (!id || st.scores[id]) return err('bad-entrant');
    startPerf(ev, { type: 'solo', entrantId: id, poomsae: '자유품새' });
  }));

  socket.on('tkd:deduct', admin((ev, p) => {
    const c = ev.current;
    if (!c || c.status === 'done' || !c.deductions[p.side] || !DEDUCTION_KEYS[ev.kind].includes(p.key)) return;
    c.deductions[p.side][p.key] = p.key === 'restart' ? Math.min(5, Math.max(0, Math.round(Number(p.value) || 0))) : !!p.value;
    broadcast(ev);
  }));

  socket.on('tkd:finalize', admin((ev, p) => {
    const c = ev.current;
    if (!c) return;
    if (c.status === 'scoring') {
      if (!p.force || !Object.keys(c.submitted).length) return err('not-ready');
      c.activeSeats = c.activeSeats.filter((s) => c.submitted[s]);
    } else if (c.status !== 'review') return;
    if (!finalizePerf(ev)) return err('no-scores');
    broadcast(ev);
  }));

  socket.on('tkd:cancel', admin((ev) => {
    if (ev.current && ev.current.status !== 'done') { ev.current = null; broadcast(ev); }
  }));

  socket.on('tkd:advance', admin((ev) => {
    if (ev.kind !== 'freestyle' || ev.phase !== 'running') return;
    const st = ev.stages[ev.stageIdx];
    if (!st || !st.complete) return err('stage-not-complete');
    if (ev.current && ev.current.status !== 'done') return err('busy');
    ev.current = null;
    if (st.type === 'final') {
      const entries = st.rankings[0].entries;
      ev.podium = { ranks: entries.map((e) => ({ id: e.id, rank: e.rank, res: e.res })) };
      ev.phase = 'finished';
    } else {
      const next = st.rankings.flatMap((g) => g.entries.filter((e) => e.advance).map((e) => e.id));
      if (st.type === 'prelim') ev.prelimCount += 1;
      ev.stages.push(planStage(next, ev.prelimCount));
      ev.stageIdx += 1;
    }
    broadcast(ev);
  }));

  // 심판 → 서버: 채점 제출 (자기 좌석, 진행 중인 경기만)
  socket.on('tkd:submit', (p = {}) => {
    const t = socket.data.tkd;
    if (!t || t.role !== 'judge') return;
    const ev = events.get(t.id);
    const c = ev && ev.current;
    if (!c || c.status !== 'scoring' || !c.activeSeats.includes(t.seat) || c.submitted[t.seat]) return err('not-open');
    const sides = c.type === 'match' ? ['a', 'b'] : ['solo'];
    const cleaned = {};
    for (const side of sides) {
      const vals = validateScores(ev.kind, p.scores && p.scores[side]);
      if (!vals) return err('bad-scores');
      cleaned[side] = vals;
    }
    for (const side of sides) c.scores[side] = { ...(c.scores[side] || {}), [t.seat]: { vals: cleaned[side], ...judgeTotals(ev.kind, cleaned[side]) } };
    c.submitted[t.seat] = true;
    if (c.activeSeats.every((s) => c.submitted[s])) c.status = 'review';
    broadcast(ev);
  });
}

setInterval(() => {
  const now = Date.now();
  for (const [id, ev] of events) if (now - ev.lastActive > IDLE_TTL_MS) events.delete(id);
}, 10 * 60 * 1000).unref();

module.exports = { attach, _test: { buildBracket, planStage, combine, judgeTotals, cmpResult, rankGroup, validateScores, seedOrder, roundName, events } };
