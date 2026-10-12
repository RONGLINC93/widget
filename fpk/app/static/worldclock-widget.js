/* 世界时钟悬浮窗组件（纯前端，用 Intl 时区，无需后端/外网）
 * 用法：WorldClockWidget.mount({ settingsApi, pos, size, min, pinned, cities })
 * 城市列表存到 settingsApi（/api/worldclock_settings）的 cities 字段；
 * 注入场景由 inject.js 传 settingsApi，演示/预览场景可传 cities 直接渲染。
 */
(function () {
  "use strict";

  var PRESET = {
    "北京": "Asia/Shanghai", "上海": "Asia/Shanghai", "中国": "Asia/Shanghai",
    "东京": "Asia/Tokyo", "日本": "Asia/Tokyo",
    "纽约": "America/New_York", "美东": "America/New_York",
    "洛杉矶": "America/Los_Angeles", "美西": "America/Los_Angeles",
    "伦敦": "Europe/London", "英国": "Europe/London",
    "巴黎": "Europe/Paris", "法国": "Europe/Paris",
    "柏林": "Europe/Berlin", "德国": "Europe/Berlin",
    "莫斯科": "Europe/Moscow",
    "新加坡": "Asia/Singapore",
    "香港": "Asia/Hong_Kong", "台北": "Asia/Taipei",
    "首尔": "Asia/Seoul", "韩国": "Asia/Seoul",
    "悉尼": "Australia/Sydney", "澳洲": "Australia/Sydney",
    "迪拜": "Asia/Dubai", "印度": "Asia/Kolkata",
    "utc": "UTC", "世界": "UTC"
  };

  function resolveTz(v) {
    if (!v) return null;
    if (v.indexOf("/") >= 0) return v;                 // 直接当作 IANA 时区
    var lower = v.toLowerCase();
    for (var k in PRESET) {
      if (k.toLowerCase().indexOf(lower) >= 0) return PRESET[k];
    }
    try { new Intl.DateTimeFormat("en", { timeZone: v }); return v; }   // 试探是否有效
    catch (e) { return null; }
  }

  function fmtCity(city) {
    var now = new Date();
    try {
      var t = new Intl.DateTimeFormat("zh-CN",
        { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: city.tz || undefined }).format(now);
      var d = new Intl.DateTimeFormat("zh-CN",
        { month: "2-digit", day: "2-digit", weekday: "short", timeZone: city.tz || undefined }).format(now);
      return { t: t, d: d, err: false };
    } catch (e) { return { err: true }; }
  }

  var W = RLShell.create({
    id: "wc", title: "世界时钟", icon: "🕐", minW: 210, minH: 120, defW: 250,
    build: function (body, ctx) {
      var esc = ctx.esc;
      var cities = Array.isArray(ctx.opts.cities) ? ctx.opts.cities.slice() : [];
      var API = ctx.opts.settingsApi || null;
      var timer = null;

      body.innerHTML =
        '<div class="wc-list" id="wcList"></div>' +
        '<div class="wc-add">' +
          '<input id="wcInput" placeholder="添加城市（如 上海 / Asia/Tokyo）" />' +
          '<button id="wcAddBtn">＋</button>' +
        '</div>' +
        '<div class="wc-hint" id="wcHint">支持城市名或 IANA 时区，如 Asia/Shanghai</div>';

      var listEl = body.querySelector("#wcList");
      var input = body.querySelector("#wcInput");
      var addBtn = body.querySelector("#wcAddBtn");
      var hint = body.querySelector("#wcHint");

      function saveCities(arr) {
        if (!API) return;
        fetch(API, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cities: arr })
        }).catch(function () {});
      }

      function buildRows() {
        if (!cities.length) {
          listEl.innerHTML = '<div class="wc-empty">还没有城市，下面添加一个吧</div>';
          return;
        }
        listEl.innerHTML = cities.map(function (c, i) {
          return '<div class="wc-row" data-i="' + i + '">' +
            '<span class="wc-name">' + esc(c.name) + '</span>' +
            '<span class="wc-time"></span>' +
            '<span class="wc-date"></span>' +
            '<button class="wc-del" data-i="' + i + '" title="删除">×</button>' +
            '</div>';
        }).join("");
        listEl.querySelectorAll(".wc-del").forEach(function (b) {
          b.onclick = function () {
            cities.splice(+b.dataset.i, 1);
            saveCities(cities);
            buildRows(); tickOnce();
          };
        });
      }

      function tickOnce() {
        var rows = listEl.querySelectorAll(".wc-row");
        for (var i = 0; i < rows.length; i++) {
          var c = cities[+rows[i].dataset.i];
          if (!c) continue;
          var f = fmtCity(c);
          rows[i].querySelector(".wc-time").textContent = f.err ? "—" : f.t;
          rows[i].querySelector(".wc-date").textContent = f.err ? "时区无效" : f.d;
        }
      }

      addBtn.onclick = function () {
        var v = input.value.trim();
        if (!v) return;
        var tz = resolveTz(v);
        if (!tz) { hint.textContent = "无法识别时区，请填 IANA（如 Asia/Shanghai）"; return; }
        cities.push({ name: v, tz: tz });
        saveCities(cities);
        input.value = ""; hint.textContent = "已添加，每秒自动走时";
        buildRows(); tickOnce();
      };
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") addBtn.onclick(); });

      // 若未直接给 cities，则拉一次设置（注入场景）补全
      if (!cities.length && API) {
        fetch(API, { cache: "no-store" }).then(function (r) { return r.json(); })
          .then(function (j) {
            var s = j && j.settings ? j.settings : {};
            if (Array.isArray(s.cities) && s.cities.length) {
              cities = s.cities; buildRows(); tickOnce();
            }
          }).catch(function () {});
      }

      buildRows(); tickOnce();
      timer = setInterval(tickOnce, 1000);

      return { onDestroy: function () { if (timer) clearInterval(timer); } };
    }
  });

  window.WorldClockWidget = W;

  // 演示页（worldclock-widget.html）无后端时自动挂载一个本地时钟
  if (!window.__wc_noauto) {
    window.addEventListener("DOMContentLoaded", function () {
      if (window.__wc_mounted) return;
      window.__wc_mounted = true;
      W.mount({ settingsApi: null, pos: null, size: null,
                cities: [{ name: "本地", tz: "" }] });
    });
  }
})();
