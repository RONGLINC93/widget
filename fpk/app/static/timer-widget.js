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
  var QUICK = [10, 30, 60, 180, 300, 600, 1500];   // 秒级快捷（10″/30″/1′/3′/5′/10′/25′）

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
        '<div class="tm-ring">' +
          '<svg viewBox="0 0 120 120" aria-hidden="true">' +
            '<circle class="tm-ring-bg" cx="60" cy="60" r="52"></circle>' +
            '<circle class="tm-ring-fg" id="tmRing" cx="60" cy="60" r="52"></circle>' +
          '</svg>' +
          '<div class="tm-ring-center">' +
            '<div class="tm-display" id="tmDisplay">' + fmt(remainingMs) + '</div>' +
            '<div class="tm-done" id="tmDone">⏰ 时间到</div>' +
          '</div>' +
        '</div>' +
        '<div class="tm-preset">' +
          '<span>时长</span>' +
          '<input id="tmPreset" type="text" inputmode="decimal" placeholder="00:00" value="' + presetInputText(presetSec) + '" />' +
        '</div>' +
        '<div class="tm-quick" id="tmQuick"></div>' +
        '<div class="tm-btns">' +
          '<button id="tmStart" class="tm-btn tm-primary">开始</button>' +
          '<button id="tmReset" class="tm-btn">重置</button>' +
        '</div>';

      var display = body.querySelector("#tmDisplay");
      var doneEl = body.querySelector("#tmDone");
      var ring = body.querySelector("#tmRing");
      var presetInput = body.querySelector("#tmPreset");
      var quickEl = body.querySelector("#tmQuick");
      var startBtn = body.querySelector("#tmStart");
      var resetBtn = body.querySelector("#tmReset");

      // 时长输入解析：支持「分:秒」（如 1:30）或纯数字（按分钟，兼容旧习惯）
      function parseDuration(v) {
        v = String(v == null ? "" : v).trim();
        if (v.indexOf(":") >= 0) {
          var p = v.split(":");
          var m = parseInt(p[0], 10) || 0, s = parseInt(p[1], 10) || 0;
          return m * 60 + s;
        }
        var n = parseInt(v, 10);
        return isNaN(n) ? 0 : n * 60;
      }
      // 输入框回显：与倒计时显示一致，统一 MM:SS（超过 1 小时 hh:mm:ss），分秒均补零
      function presetInputText(sec) {
        var t = Math.max(0, Math.round(sec));
        var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), ss = t % 60;
        var p2 = function (n) { return (n < 10 ? "0" : "") + n; };
        return h > 0 ? (h + ":" + p2(m) + ":" + p2(ss)) : (p2(m) + ":" + p2(ss));
      }
      function quickLabel(sec) { return sec < 60 ? sec + "″" : (sec / 60) + "′"; }

      QUICK.forEach(function (sec) {
        var b = document.createElement("button");
        b.className = "tm-chip";
        b.textContent = quickLabel(sec);
        b.onclick = function () { setPreset(sec); };
        quickEl.appendChild(b);
      });

      var RING_C = 2 * Math.PI * 52;   // r=52 的周长，用于 dash 进度
      function render() {
        display.textContent = fmt(remainingMs);
        var total = presetSec * 1000;
        var p = total > 0 ? Math.max(0, Math.min(1, remainingMs / total)) : 0;
        ring.style.strokeDasharray = RING_C;
        ring.style.strokeDashoffset = RING_C * (1 - p);   // 满环→0，归零→整周
        ring.classList.toggle("tm-ring-done", done);
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
        stopAlarm();
        presetSec = sec; remainingMs = sec * 1000;
        running = false; endAt = 0; done = false;
        presetInput.value = presetInputText(presetSec);
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

      startBtn.onclick = function () {
        if (done) { stopAlarm(); setPreset(presetSec); return; }   // 到点后点开始：停铃并复位
        running ? pause() : start();
      };
      resetBtn.onclick = function () { setPreset(presetSec); };
      presetInput.addEventListener("change", function () {
        var sec = parseDuration(presetInput.value);
        if (sec < 1) sec = presetSec;
        if (sec > 86400) sec = 86400;
        setPreset(sec);
      });

      function beep() {
        try {
          var AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return;
          var ac = new AC();
          if (ac.state === "suspended" && ac.resume) ac.resume();
          [0, 0.2, 0.4].forEach(function (off) {   // 三声短鸣，近似闹钟
            var o = ac.createOscillator(), g = ac.createGain();
            o.connect(g); g.connect(ac.destination);
            o.type = "sine"; o.frequency.value = 988;
            var t = ac.currentTime + off;
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
            o.start(t); o.stop(t + 0.18);
          });
        } catch (e) {}
      }

      // 到点持续闹铃：循环播放，直到用户点开始 / 重置 / 改时长或关闭组件
      var alarmTimer = null;
      function startAlarm() {
        if (alarmTimer) return;
        beep();
        alarmTimer = setInterval(beep, 900);
      }
      function stopAlarm() {
        if (alarmTimer) { clearInterval(alarmTimer); alarmTimer = null; }
      }

      // 恢复本地运行状态；无本地状态时再拉后端 preset 兜底
      if (!preview) {
        var restored = false;
        try {
          var s = JSON.parse(localStorage.getItem(LS_KEY) || "null");
          if (s) {
            restored = true;
            presetSec = parseInt(s.preset, 10) > 0 ? parseInt(s.preset, 10) : presetSec;
            presetInput.value = presetInputText(presetSec);
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
                presetSec = p; presetInput.value = presetInputText(p);
                remainingMs = p * 1000; running = false; done = false;
                renderDone(); render();
              }
            }).catch(function () {});
        }
      }

      renderDone(); render();

      return { onDestroy: function () { if (timer) clearInterval(timer); stopAlarm(); } };
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
