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
  .ms-overlay{position:fixed;inset:0;z-index:100;display:none;flex-direction:column;align-items:center;justify-content:center;gap:2.4vh;text-align:center;
    padding:3vh 5vw;color:#2b2a33;background:radial-gradient(90vmax 70vmax at 50% 0%,#fff6d6 0%,#ffe2b0 60%,#ffcf9a 100%);font-family:"Pretendard Variable",Pretendard,"Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif;touch-action:none;user-select:none;-webkit-user-select:none}
  .ms-overlay.show{display:flex}
  .ms-title{font-weight:900;font-size:clamp(1.4rem,5vw,3.6rem);color:#d9480f;background:#fff;padding:.25em .9em;border-radius:999px;box-shadow:0 6px 0 rgba(217,72,15,.25)}
  .ms-text{font-weight:900;line-height:1.3;font-size:clamp(2rem,7.4vw,6.4rem);max-width:92vw;word-break:keep-all;overflow-wrap:anywhere}
  .ms-count{font-weight:900;font-variant-numeric:tabular-nums;line-height:1;font-size:clamp(5rem,24vw,15rem);color:#e8590c}
  .ms-count small{font-size:.35em;margin-left:.1em;color:#2b2a33}
  .ms-bar{width:min(86vw,900px);height:18px;border-radius:99px;background:rgba(255,255,255,.7);overflow:hidden;box-shadow:inset 0 0 0 2px rgba(217,72,15,.2)}
  .ms-bar i{display:block;height:100%;width:100%;background:linear-gradient(90deg,#ff922b,#e8590c);border-radius:99px}
  .ms-sub{font-size:clamp(1rem,2.2vw,1.7rem);color:#6b5b45;font-weight:600}
  .ms-overlay.resume{background:radial-gradient(90vmax 70vmax at 50% 0%,#e9fbef 0%,#c9f2d9 70%,#aee8c5 100%)}
  .ms-overlay.resume .ms-title{color:#1b8a4b;box-shadow:0 6px 0 rgba(27,138,75,.25)}`;

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
      q('.ms-title').textContent = '🚨 돌발 미션!';
      q('.ms-text').textContent = m.text;
      q('.ms-bar').style.display = '';
      q('.ms-sub').textContent = '게임이 잠시 멈췄어요. 미션이 끝나면 자동으로 다시 시작해요!';
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
        q('.ms-title').textContent = '▶ 다시 시작!';
        q('.ms-text').textContent = e.resumed ? '삐-익! 게임 재개' : '미션 종료';
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
