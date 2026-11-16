/* 플레이 라운지 공용: 효과음(SFX) + 긴급 미션 연출 오버레이
 *  SFX.play('alarm' | 'cheer' | 'wrong' | 'whistle')
 *  Mission.attach(socket, 'screen' | 'phone')
 *    screen: 대화면(점수판) - 효과음은 항상 재생
 *    phone : 선수 휴대폰   - 진동 + (사범님이 허용한 경우에만) 효과음
 */
(function () {
  /* ---------------------------- 효과음 (Web Audio 합성) ---------------------------- */
  const SFX = (() => {
    let ctx = null;
    const ac = () => {
      try {
        ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume();
      } catch (_) { /* 오디오를 못 쓰면 조용히 무시 */ }
      return ctx;
    };
    function tone(type, f0, f1, t0, dur, vol) {
      const c = ac(); if (!c) return;
      const o = c.createOscillator(), g = c.createGain(), t = c.currentTime + t0;
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      if (f1) o.frequency.linearRampToValueAtTime(f1, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(c.destination);
      o.start(t); o.stop(t + dur + 0.05);
    }
    function noise(t0, dur, vol, freq) {
      const c = ac(); if (!c) return;
      const len = Math.floor(c.sampleRate * dur), buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain(), t = c.currentTime + t0;
      src.buffer = buf; f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 0.8;
      g.gain.value = vol;
      src.connect(f); f.connect(g); g.connect(c.destination);
      src.start(t);
    }
    function whistleBlow(t0, dur) {            // 삐- : 높은 음이 떨리는 휘파람
      const c = ac(); if (!c) return;
      const t = c.currentTime + t0;
      const o = c.createOscillator(), lfo = c.createOscillator(), lg = c.createGain(), g = c.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(2300, t); o.frequency.linearRampToValueAtTime(2800, t + dur);
      lfo.frequency.value = 32; lg.gain.value = 110;
      lfo.connect(lg); lg.connect(o.frequency);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.4, t + 0.03); g.gain.setValueAtTime(0.4, t + dur - 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(c.destination);
      o.start(t); lfo.start(t); o.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
    }
    const sounds = {
      alarm()   { for (let i = 0; i < 6; i++) tone('square', i % 2 ? 660 : 880, 0, i * 0.28, 0.26, 0.22); },
      cheer()   { noise(0, 1.6, 0.5, 1800); [523, 659, 784, 1047].forEach((f, i) => tone('triangle', f, 0, i * 0.12, 0.5, 0.22)); },
      wrong()   { tone('sawtooth', 220, 110, 0, 0.35, 0.3); tone('sawtooth', 160, 70, 0.4, 0.75, 0.3); },
      whistle() { whistleBlow(0, 0.2); whistleBlow(0.3, 0.75); },
    };
    return { play(name) { if (sounds[name]) sounds[name](); }, unlock: ac };
  })();
  window.SFX = SFX;

  /* ---------------------------- 긴급 미션 오버레이 ---------------------------- */
  const css = `
  .ms-overlay{position:fixed;inset:0;z-index:100;display:none;flex-direction:column;align-items:center;justify-content:center;gap:2.2vh;text-align:center;
    padding:3vh 4vw;color:#fff;background:repeating-linear-gradient(45deg,#14080a 0 28px,#2a0d10 28px 56px);font-family:"Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif;touch-action:none;user-select:none;-webkit-user-select:none}
  .ms-overlay.show{display:flex}
  .ms-title{font-weight:900;letter-spacing:.04em;font-size:clamp(1.3rem,5vw,4.2rem);color:#ff4d4d;text-shadow:0 0 .4em rgba(255,60,60,.7);animation:ms-blink .7s steps(2,start) infinite}
  .ms-text{font-weight:900;line-height:1.25;font-size:clamp(1.8rem,7vw,6.4rem);max-width:92vw;word-break:keep-all;overflow-wrap:anywhere}
  .ms-count{font-weight:900;font-variant-numeric:tabular-nums;line-height:1;font-size:clamp(5rem,26vw,16rem);color:#ffd23f}
  .ms-count small{font-size:.35em;margin-left:.1em}
  .ms-bar{width:min(86vw,900px);height:14px;border-radius:99px;background:rgba(255,255,255,.18);overflow:hidden}
  .ms-bar i{display:block;height:100%;width:100%;background:#ffd23f}
  .ms-sub{font-size:clamp(.95rem,2vw,1.6rem);opacity:.8}
  .ms-overlay.resume{background:#0f3d22}
  .ms-overlay.resume .ms-title{color:#7dffb0;text-shadow:none;animation:none}
  @keyframes ms-blink{50%{opacity:.35}}
  @media (prefers-reduced-motion:reduce){.ms-title{animation:none}}`;

  function attach(socket, mode) {
    const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
    const el = document.createElement('div');
    el.className = 'ms-overlay'; el.setAttribute('role', 'alertdialog'); el.setAttribute('aria-live', 'assertive');
    el.innerHTML = '<div class="ms-title"></div><div class="ms-text"></div><div class="ms-count"></div><div class="ms-bar"><i></i></div><div class="ms-sub"></div>';
    document.body.appendChild(el);
    const q = (c) => el.querySelector(c);
    let endsAt = 0, totalMs = 0, timer = null, hideTimer = null, phoneSound = false;
    const soundOn = (flag) => mode === 'screen' || flag;

    function tick() {
      const rem = Math.max(0, endsAt - Date.now());
      q('.ms-count').innerHTML = Math.ceil(rem / 1000) + '<small>초</small>';
      q('.ms-bar i').style.width = (totalMs ? (rem / totalMs) * 100 : 0) + '%';
    }
    socket.on('mission:start', (m) => {
      clearTimeout(hideTimer); clearInterval(timer);
      phoneSound = !!m.phoneSound;
      endsAt = Date.now() + m.remainingMs; totalMs = m.sec * 1000;
      el.className = 'ms-overlay show';
      q('.ms-title').textContent = '🚨 EMERGENCY MISSION! 🚨';
      q('.ms-text').textContent = m.text;
      q('.ms-bar').style.display = '';
      q('.ms-sub').textContent = '게임 일시정지 · 미션이 끝나면 자동으로 재개됩니다';
      tick(); timer = setInterval(tick, 100);
      if (m.sound !== 'none' && soundOn(phoneSound)) SFX.play(m.sound);
      if (mode === 'phone' && navigator.vibrate) navigator.vibrate([250, 120, 250, 120, 250]);
    });
    socket.on('mission:end', (e) => {
      clearInterval(timer); clearTimeout(hideTimer);
      if (!el.classList.contains('show')) return;
      if (soundOn(e.phoneSound || phoneSound)) SFX.play('whistle');
      if (mode === 'phone' && navigator.vibrate) navigator.vibrate(300);
      if (e.resumed || e.reason === 'manual' || e.reason === 'timeout') {
        el.classList.add('resume');
        q('.ms-title').textContent = '▶ 게임 재개!';
        q('.ms-text').textContent = e.resumed ? '삐-익! 다시 시작!' : '미션 종료';
        q('.ms-count').textContent = '';
        q('.ms-bar').style.display = 'none';
        q('.ms-sub').textContent = '';
        hideTimer = setTimeout(() => el.classList.remove('show', 'resume'), 1400);
      } else {
        el.classList.remove('show', 'resume');
      }
    });
  }
  window.Mission = { attach };
})();
