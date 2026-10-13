/* 计时器悬浮窗组件（纯前端倒计时，无需后端/外网）
 * 用法：TimerWidget.mount({ settingsApi, pos, size, min, pinned, preset })
 *  - preset：默认时长（秒），存到 settingsApi（/api/timer_settings）的 preset 字段；
 *  - 运行中的剩余时间 / 是否在跑，存本地 localStorage，刷新桌面后按结束时间戳恢复继续倒计时；
 *  - 注入场景由 inject.js 传 settingsApi，预览 / 演示场景传 preset 直接渲染。
 */
(function () {
  "use strict";

  var LS_KEY = "rl93_timer_state";
  var PRESET_DEFAULT = 300;        // 秒，默认 5 分钟
  var QUICK = [1, 3, 5, 10, 25];   // 分钟快捷

  function fmt(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    var p2 = function (n) { return (n < 10 ? "0" : "") + n; };
    return h > 0 ? (h + ":" + p2(m) + ":" + p2(ss)) : (p2(m) + ":" + p2(ss));
  }

  var W = RLShell.create({
    id: "tm", title: "计时器", icon: "⏳", minW: 200, minH: 160, defW: 250,
    build: function (body, ctx) {
      var API = ctx.opts.settingsApi || null;
      var preview = !!ctx.opts.preview;
      var presetSec = parseInt(ctx.opts.preset, 10) > 0 ? parseInt(ctx.opts.preset, 10) : PRESET_DEFAULT;

      var remainingMs = presetSec * 1000, running = false, endAt = 0, done = false;

      body.innerHTML =
        '<div class="tm-display" id="tmDisplay">' + fmt(remainingMs) + '</div>' +
        '<div class="tm-done" id="tmDone">⏰ 时间到</div>' +
        '<div class="tm-preset">' +
          '<span>时长</span>' +
          '<input id="tmPreset" type="number" min="1" max="1440" value="' + Math.round(presetSec / 60) + '" />' +
          '<span>分钟</span>' +
        '</div>' +
        '<div class="tm-quick" id="tmQuick"></div>' +
        '<div class="tm-btns">' +
          '<button id="tmStart" class="tm-btn tm-primary">开始</button>' +
          '<button id="tmReset" class="tm-btn">重置</button>' +
        '</div>';

      var display = body.querySelector("#tmDisplay");
      var doneEl = body.querySelector("#tmDone");
      var presetInput = body.querySelector("#tmPreset");
      var quickEl = body.querySelector("#tmQuick");
      var startBtn = body.querySelector("#tmStart");
      var resetBtn = body.querySelector("#tmReset");

      QUICK.forEach(function (min) {
        var b = document.createElement("button");
        b.className = "tm-chip";
        b.textContent = min + "′";
        b.onclick = function () { presetInput.value = min; setPreset(min * 60); };
        quickEl.appendChild(b);
      });

      function render() {
        display.textContent = fmt(remainingMs);
        startBtn.textContent = running ? "暂停" : "开始";
      }
      function renderDone() {
        doneEl.style.display = done ? "" : "none";
        display.classList.toggle("tm-done-flash", done);
      }

      function savePreset() {
        if (!API || preview) return;
        fetch(API, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preset: presetSec }) }).catch(function () {});
      }
      function saveState() {
        if (preview) return;
        try {
          localStorage.setItem(LS_KEY, JSON.stringify(
            { preset: presetSec, remainingMs: remainingMs, running: running, endAt: endAt, done: done }));
        } catch (e) {}
      }

      function setPreset(sec) {
        presetSec = sec; remainingMs = sec * 1000;
        running = false; endAt = 0; done = false;
        renderDone(); render(); savePreset(); saveState();
      }
      function start() {
        if (done) return;
        running = true; endAt = Date.now() + remainingMs;
        render(); saveState();
      }
      function pause() {
        remainingMs = Math.max(0, endAt - Date.now());
        running = false; render(); saveState();
      }
      function onDone() {
        remainingMs = 0; running = false; done = true;
        renderDone(); render(); saveState(); beep();
      }
      function tick() {
        if (!running) return;
        remainingMs = endAt - Date.now();
        if (remainingMs <= 0) { onDone(); return; }
        render();
      }
      var timer = setInterval(tick, 200);

      startBtn.onclick = function () { running ? pause() : start(); };
      resetBtn.onclick = function () { setPreset(presetSec); };
      presetInput.addEventListener("change", function () {
        var min = parseInt(presetInput.value, 10);
        if (isNaN(min) || min < 1) min = Math.round(presetSec / 60) || 5;
        if (min > 1440) min = 1440;
        presetInput.value = min;
        setPreset(min * 60);
      });

      function beep() {
        try {
          var AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return;
          var ac = new AC();
          [0, 0.26].forEach(function (off) {
            var o = ac.createOscillator(), g = ac.createGain();
            o.connect(g); g.connect(ac.destination);
            o.type = "sine"; o.frequency.value = 880;
            var t = ac.currentTime + off;
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
            o.start(t); o.stop(t + 0.2);
          });
        } catch (e) {}
      }

      // 恢复本地运行状态；无本地状态时再拉后端 preset 兜底
      if (!preview) {
        var restored = false;
        try {
          var s = JSON.parse(localStorage.getItem(LS_KEY) || "null");
          if (s) {
            restored = true;
            presetSec = parseInt(s.preset, 10) > 0 ? parseInt(s.preset, 10) : presetSec;
            presetInput.value = Math.round(presetSec / 60);
            if (s.running && s.endAt) {
              remainingMs = s.endAt - Date.now();
              if (remainingMs > 0) { running = true; endAt = s.endAt; done = false; }
              else { remainingMs = 0; running = false; done = true; }   // 恢复时到点不响铃，只显示
            } else {
              remainingMs = typeof s.remainingMs === "number" ? s.remainingMs : presetSec * 1000;
              done = !!s.done;
            }
          }
        } catch (e) {}
        if (!restored && API) {
          fetch(API, { cache: "no-store" }).then(function (r) { return r.json(); })
            .then(function (j) {
              var st = j && j.settings ? j.settings : {};
              var p = parseInt(st.preset, 10);
              if (p > 0) {
                presetSec = p; presetInput.value = Math.round(p / 60);
                remainingMs = p * 1000; running = false; done = false;
                renderDone(); render();
              }
            }).catch(function () {});
        }
      }

      renderDone(); render();

      return { onDestroy: function () { if (timer) clearInterval(timer); } };
    }
  });

  window.TimerWidget = W;

  // 演示页（timer-widget.html）无后端时自动挂载一个本地计时器
  if (!window.__tm_noauto) {
    window.addEventListener("DOMContentLoaded", function () {
      if (window.__tm_mounted) return;
      window.__tm_mounted = true;
      W.mount({ settingsApi: null, preset: PRESET_DEFAULT, pos: null, size: null });
    });
  }
})();
