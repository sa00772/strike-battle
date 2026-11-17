/* 플레이 라운지 공용: 미션 송출 덱 UI
 *  Deck.mount(containerElement, socket)
 *  - 텍스트 직접 입력 / 프리셋(즐겨찾기) / 효과음 선택 / 게임 재개
 */
(function () {
  const css = `
  .dk{font-family:"Pretendard Variable",Pretendard,"Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif;color:#2b2a33;display:flex;flex-direction:column;gap:14px;background:#fffaf0;border-radius:20px;padding:18px}
  .dk h3{font-size:1.15rem;font-weight:900;color:#2b2a33}
  .dk label{font-size:.9rem;color:#6b5b45;font-weight:700;display:flex;flex-direction:column;gap:6px}
  .dk textarea,.dk select{font:inherit;font-size:1.05rem;background:#fff;color:#2b2a33;border:2px solid #f0d9ad;border-radius:14px;padding:.7em .8em;width:100%}
  .dk textarea{resize:vertical;min-height:4.4em}
  .dk textarea:focus,.dk select:focus{outline:none;border-color:#ff922b;box-shadow:0 0 0 3px rgba(255,146,43,.25)}
  .dk button:focus-visible{outline:3px solid #e8590c;outline-offset:2px}
  .dk .row{display:flex;gap:10px;flex-wrap:wrap}
  .dk .row>*{flex:1;min-width:130px}
  .dk .row.stack{flex-direction:column}
  .dk button{font:inherit;font-weight:800;border:0;border-radius:14px;padding:.85em .7em;background:#f3e6c8;color:#5b4a2e;cursor:pointer;transition:transform .1s,background .15s}
  .dk button:hover{background:#ecd9ab} .dk button:active{transform:scale(.98)}
  .dk .send{background:#e8590c;color:#fff;font-size:1.2rem;padding:1em;box-shadow:0 4px 0 #b8430a}
  .dk .send:hover{background:#f76707}
  .dk .resume{background:#2f9e5f;color:#fff;font-size:1.05rem;box-shadow:0 4px 0 #1f7a47}
  .dk .resume:hover{background:#37b26c}
  .dk .chk{flex-direction:row;align-items:center;gap:10px;font-size:.95rem;color:#5b4a2e}
  .dk .chk input{width:22px;height:22px;accent-color:#e8590c}
  .dk .presets{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .dk .pr{position:relative;display:flex}
  .dk .pr .go{flex:1;text-align:left;background:#fff;border:2px solid #f0d9ad;color:#2b2a33;padding:.8em 2.2em .8em .9em;line-height:1.35;font-size:1rem}
  .dk .pr .go:hover{background:#fff1d6;border-color:#ffb457}
  .dk .pr .go small{display:block;font-weight:600;color:#8a7757;margin-top:3px;font-size:.78rem}
  .dk .pr .x{position:absolute;right:6px;top:6px;padding:.1em .5em;background:transparent;color:#a89674;font-size:1.1rem}
  .dk .add{background:transparent;border:2px dashed #e3c995;color:#8a7757}
  .dk .status{min-height:1.4em;font-size:1rem;color:#d9480f;font-weight:800}
  @media(max-width:420px){.dk .presets{grid-template-columns:1fr}}`;

  const DEFAULT_PRESETS = [
    { t: '푸시업 5개!', s: 10 }, { t: '오리걸음으로 이동!', s: 10 }, { t: '양손 만세! 그대로 정지!', s: 5 },
    { t: '전원 제자리 점프 10회 후 재개!', s: 10 }, { t: '한 발로 5초간 뛰기!', s: 5 }, { t: '사범님 이름 외치고 달려오기!', s: 10 },
  ];
  const KEY = 'lounge-presets';
  const load = () => {
    try { const v = JSON.parse(localStorage.getItem(KEY)); if (Array.isArray(v) && v.length) return v; } catch (_) {}
    return DEFAULT_PRESETS.slice();
  };
  const save = (list) => { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (_) {} };

  function mount(root, socket) {
    if (!document.getElementById('dk-style')) {
      const st = document.createElement('style'); st.id = 'dk-style'; st.textContent = css; document.head.appendChild(st);
    }
    root.classList.add('dk');
    root.innerHTML = `
      <h3>🚨 돌발 미션 보내기</h3>
      <label>미션 문구
        <textarea id="dk-text" maxlength="80" placeholder="예) [돌발] 전원 제자리 점프 10회 후 재개!"></textarea>
      </label>
      <div class="row">
        <label>제한 시간
          <select id="dk-sec"><option value="5">5초</option><option value="10" selected>10초</option><option value="15">15초</option><option value="20">20초</option><option value="30">30초</option><option value="60">60초</option></select>
        </label>
        <label>효과음
          <select id="dk-sound"><option value="alarm">긴급 경보음</option><option value="cheer">환호성</option><option value="wrong">땡- 틀렸습니다</option><option value="none">없음</option></select>
        </label>
      </div>
      <label class="chk"><input type="checkbox" id="dk-phone"> 선수 휴대폰에서도 소리 재생</label>
      <div class="row stack">
        <button class="send" id="dk-send">🚨 미션 보내기</button>
        <button class="resume" id="dk-resume">▶ 게임 다시 시작</button>
      </div>
      <button id="dk-preview" type="button">🔊 효과음 미리듣기</button>
      <div class="status" id="dk-status" role="status" aria-live="polite"></div>
      <h3>자주 쓰는 미션 (누르면 바로 전송)</h3>
      <div class="presets" id="dk-presets"></div>
      <button class="add" id="dk-add" type="button">＋ 위 문구를 자주 쓰는 미션으로 저장</button>`;
    const $ = (id) => root.querySelector('#' + id);
    let presets = load();

    const payload = (text, sec) => ({ text, sec: Number(sec), sound: $('dk-sound').value, phoneSound: $('dk-phone').checked });
    function send(text, sec) {
      text = (text || '').trim();
      if (!text) { $('dk-status').textContent = '미션 문구를 입력하세요.'; $('dk-text').focus(); return; }
      if (window.SFX) SFX.unlock();
      socket.emit('mission:send', payload(text, sec));
    }
    function renderPresets() {
      const box = $('dk-presets'); box.innerHTML = '';
      presets.forEach((p, i) => {
        const wrap = document.createElement('div'); wrap.className = 'pr';
        const go = document.createElement('button'); go.className = 'go'; go.type = 'button';
        go.textContent = p.t; const sm = document.createElement('small'); sm.textContent = `${p.s}초 · 누르면 바로 보내요`; go.appendChild(sm);
        go.addEventListener('click', () => send(p.t, p.s));
        const x = document.createElement('button'); x.className = 'x'; x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', `${p.t} 프리셋 삭제`);
        x.addEventListener('click', () => { presets.splice(i, 1); save(presets); renderPresets(); });
        wrap.append(go, x); box.appendChild(wrap);
      });
    }
    renderPresets();

    $('dk-send').addEventListener('click', () => send($('dk-text').value, $('dk-sec').value));
    $('dk-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send($('dk-text').value, $('dk-sec').value); } });
    $('dk-resume').addEventListener('click', () => socket.emit('mission:resume'));
    $('dk-preview').addEventListener('click', () => { const s = $('dk-sound').value; if (window.SFX && s !== 'none') SFX.play(s); });
    $('dk-add').addEventListener('click', () => {
      const t = $('dk-text').value.trim();
      if (!t) { $('dk-status').textContent = '저장할 문구를 먼저 입력하세요.'; return; }
      presets.push({ t: t.slice(0, 80), s: Number($('dk-sec').value) }); save(presets); renderPresets();
      $('dk-status').textContent = '프리셋에 저장했습니다. (이 기기에만 저장됩니다)';
    });

    let timer = null, endsAt = 0;
    socket.on('mission:start', (m) => {
      endsAt = Date.now() + m.remainingMs; clearInterval(timer);
      const upd = () => { $('dk-status').textContent = `미션 진행 중! ${Math.ceil(Math.max(0, endsAt - Date.now()) / 1000)}초 남음`; };
      upd(); timer = setInterval(upd, 250);
    });
    socket.on('mission:end', (e) => {
      clearInterval(timer);
      $('dk-status').textContent = e.resumed ? '미션 종료 · 게임이 재개되었습니다.' : '미션 종료';
    });
  }
  window.Deck = { mount };
})();
