/* 플레이 라운지 공용: 미션 송출 덱 UI
 *  Deck.mount(containerElement, socket)
 *  - 텍스트 직접 입력 / 프리셋(즐겨찾기) / 효과음 선택 / 게임 재개
 */
(function () {
  const css = `
  .dk{font-family:"Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif;color:#f5f7fb;display:flex;flex-direction:column;gap:12px}
  .dk h3{font-size:1.1rem;font-weight:900}
  .dk label{font-size:.85rem;color:#9aa3b5;display:flex;flex-direction:column;gap:4px}
  .dk textarea,.dk select{font:inherit;font-size:1rem;background:#12141b;color:#f5f7fb;border:2px solid #3a4152;border-radius:10px;padding:.6em .7em;width:100%}
  .dk textarea{resize:vertical;min-height:4.2em}
  .dk textarea:focus-visible,.dk select:focus-visible,.dk button:focus-visible{outline:3px solid #fff;outline-offset:2px}
  .dk .row{display:flex;gap:8px;flex-wrap:wrap}
  .dk .row>*{flex:1;min-width:120px}
  .dk button{font:inherit;font-weight:800;border:0;border-radius:10px;padding:.8em .6em;background:#323847;color:#f5f7fb;cursor:pointer}
  .dk button:hover{background:#3f4659}
  .dk .send{background:#e5352b;font-size:1.1rem;padding:1em}
  .dk .send:hover{background:#ff4a3f}
  .dk .resume{background:#1f9d57}
  .dk .resume:hover{background:#25b566}
  .dk .chk{flex-direction:row;align-items:center;gap:8px;font-size:.9rem;color:#c4cad8}
  .dk .chk input{width:20px;height:20px}
  .dk .presets{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .dk .pr{position:relative;display:flex}
  .dk .pr .go{flex:1;text-align:left;background:#26304a;padding:.7em 2em .7em .8em;line-height:1.3}
  .dk .pr .go:hover{background:#31406a}
  .dk .pr .go small{display:block;font-weight:600;color:#9aa3b5;margin-top:2px}
  .dk .pr .x{position:absolute;right:4px;top:4px;padding:.1em .45em;background:transparent;color:#9aa3b5;font-size:1rem}
  .dk .add{background:transparent;border:1px dashed #3a4152;color:#9aa3b5}
  .dk .status{min-height:1.4em;font-size:.95rem;color:#ffd23f;font-weight:700}`;

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
      <h3>미션 송출 덱</h3>
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
      <div class="row">
        <button class="send" id="dk-send">미션 발송</button>
        <button class="resume" id="dk-resume">게임 재개</button>
      </div>
      <button id="dk-preview" type="button">효과음 미리듣기</button>
      <div class="status" id="dk-status" role="status" aria-live="polite"></div>
      <h3>프리셋</h3>
      <div class="presets" id="dk-presets"></div>
      <button class="add" id="dk-add" type="button">+ 현재 문구를 프리셋으로 저장</button>`;
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
        go.textContent = p.t; const sm = document.createElement('small'); sm.textContent = `${p.s}초 · 누르면 즉시 발송`; go.appendChild(sm);
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
      const upd = () => { $('dk-status').textContent = `미션 진행 중 · ${Math.ceil(Math.max(0, endsAt - Date.now()) / 1000)}초 남음`; };
      upd(); timer = setInterval(upd, 250);
    });
    socket.on('mission:end', (e) => {
      clearInterval(timer);
      $('dk-status').textContent = e.resumed ? '미션 종료 · 게임이 재개되었습니다.' : '미션 종료';
    });
  }
  window.Deck = { mount };
})();
