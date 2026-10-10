/* 天气悬浮窗小组件（纯前端，数据来自 Open-Meteo，免 API Key、支持 CORS）
 * 用法：
 *   WeatherWidget.mount({ settingsApi, pos, size, location })
 *   - settingsApi：设置读写接口（POST 接受 {visible,pos,size,location}），传 null 时退回 localStorage
 *   - pos/size：{left,top} / {width,height}，None 用默认
 *   - location：地点字符串（城市名或 "lat,lon"），空则提示用户设置
 * 演示页（weather-widget.html）不设置 __ww_noauto，加载后自动挂载（用 localStorage 存地点）。
 * 注入到飞牛桌面时由 inject.js 设 window.__ww_noauto 后手动挂载。
 */
(function () {
  "use strict";

  var W = {};
  var OPTS = null, API = null, LOC = null, ROOT = null, MIN = false;
  var REFRESH = null, MINW = 150, MINH = 120;

  // WMO 天气代码 -> [中文描述, emoji]
  var WMO = {
    0: ["晴", "☀️"], 1: ["晴间多云", "🌤"], 2: ["多云", "⛅"], 3: ["阴", "☁️"],
    45: ["雾", "🌫"], 48: ["雾凇", "🌫"],
    51: ["毛毛雨", "🌦"], 53: ["毛毛雨", "🌦"], 55: ["毛毛雨", "🌦"],
    56: ["冻毛毛雨", "🌧"], 57: ["冻毛毛雨", "🌧"],
    61: ["小雨", "🌧"], 63: ["中雨", "🌧"], 65: ["大雨", "🌧"],
    66: ["冻雨", "🌧"], 67: ["冻雨", "🌧"],
    71: ["小雪", "🌨"], 73: ["中雪", "🌨"], 75: ["大雪", "🌨"], 77: ["雪粒", "🌨"],
    80: ["阵雨", "🌦"], 81: ["阵雨", "🌦"], 82: ["强阵雨", "⛈"],
    85: ["阵雪", "🌨"], 86: ["强阵雪", "🌨"],
    95: ["雷阵雨", "⛈"], 96: ["雷阵雨伴冰雹", "⛈"], 99: ["雷阵雨伴冰雹", "⛈"]
  };
  var WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  function wmo(code) { return WMO[code] || ["未知", "❓"]; }
  function el(id) { return document.getElementById(id); }
  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      localStorage.setItem(k, v);
    } catch (e) { if (v === undefined) return null; }
  }

  function send(b) {
    if (!API) return;
    fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(b)
    }).catch(function () {});
  }
  function saveBox(pos, size) {
    if (pos) OPTS.pos = pos;
    if (size) OPTS.size = size;
    if (!API) { store("ww_pos", JSON.stringify(OPTS.pos || null));
                store("ww_size", JSON.stringify(OPTS.size || null)); return; }
    var b = {};
    if (pos) b.pos = pos;
    if (size) b.size = size;
    send(b);
  }
  function saveVisible(v) {
    if (!API) { store("ww_visible", v ? "1" : "0"); return; }
    send({ visible: v });
  }
  function saveMin(v) {
    MIN = !!v;
    if (!API) { store("ww_min", MIN ? "1" : "0"); return; }
    send({ min: MIN });
  }
  function saveLocation(loc) {
    LOC = loc;
    if (!API) { store("ww_loc", loc || ""); return; }
    send({ location: loc || "" });
  }

  function currentLocation() {
    if (OPTS && OPTS.location) return OPTS.location;
    var l = store("ww_loc");
    return l || "";
  }

  function qJSON(url, ms) {
    var ctrl = ("AbortController" in window) ? new AbortController() : null;
    var to = ctrl ? setTimeout(function () { ctrl.abort(); }, ms || 12000) : null;
    return fetch(url, ctrl ? { signal: ctrl.signal } : {})
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .finally(function () { if (to) clearTimeout(to); });
  }

  // 把地点解析成 {lat,lon,name}：先识别 "lat,lon"，否则走 Open-Meteo 地理编码
  function resolveCoords(loc) {
    var m = (loc || "").match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) return Promise.resolve({ lat: parseFloat(m[1]), lon: parseFloat(m[2]), name: loc });
    return qJSON("https://geocoding-api.open-meteo.com/v1/search?name=" +
      encodeURIComponent(loc) + "&count=1&language=zh&format=json")
      .then(function (j) {
        if (!j.results || !j.results.length) throw new Error("找不到地点：" + loc);
        var r = j.results[0];
        var name = r.name + (r.admin1 && r.admin1 !== r.name ? "·" + r.admin1 : "") +
                   (r.country ? " " + r.country : "");
        return { lat: r.latitude, lon: r.longitude, name: name };
      });
  }

  function fetchForecast(c) {
    var url = "https://api.open-meteo.com/v1/forecast?latitude=" + c.lat +
      "&longitude=" + c.lon +
      "&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m" +
      "&daily=weather_code,temperature_2m_max,temperature_2m_min" +
      "&timezone=auto&forecast_days=6&wind_speed_unit=kmh";
    return qJSON(url).then(function (j) { j._loc = c; return j; });
  }

  function render(j) {
    var c = j._loc, cur = j.current, daily = j.daily;
    el("wwTitle").textContent = c.name || "天气";
    var w = wmo(cur.weather_code);
    var tempText = Math.round(cur.temperature_2m) + "°";
    el("wwTemp").textContent = tempText;
    var mt = el("wwMinTemp");
    if (mt) mt.textContent = tempText;
    el("wwIcon").textContent = w[1];
    el("wwCond").textContent = w[0];
    el("wwMeta").innerHTML =
      "体感 " + Math.round(cur.apparent_temperature) + "°　湿度 " + cur.relative_humidity_2m +
      "%　风 " + Math.round(cur.wind_speed_10m) + " km/h";

    var days = daily.time, html = "", now = new Date();
    for (var i = 0; i < days.length; i++) {
      var d = new Date(days[i] + "T00:00");
      var label = i === 0 ? "今天" : WD[d.getDay()];
      var dw = wmo(daily.weather_code[i]);
      html += '<div class="ww-day">' +
        '<div class="ww-dl">' + label + '</div>' +
        '<div class="ww-di">' + dw[1] + '</div>' +
        '<div class="ww-dc">' + dw[0] + '</div>' +
        '<div class="ww-dt"><b>' + Math.round(daily.temperature_2m_max[i]) +
        '°</b> ' + Math.round(daily.temperature_2m_min[i]) + '°</div>' +
        '</div>';
    }
    el("wwDays").innerHTML = html;
    var upd = now.getHours() + ":" + ("0" + now.getMinutes()).slice(-2);
    el("wwFoot").textContent = "更新于 " + upd + " · 数据 Open-Meteo";
  }

  function showMsg(msg) { el("wwCond").textContent = msg; el("wwDays").innerHTML = ""; }

  function loadWeather() {
    var loc = currentLocation();
    if (!loc) {
      el("wwTitle").textContent = "天气";
      el("wwTemp").textContent = "🌤";
      el("wwIcon").textContent = "";
      showMsg("未设置地点");
      var f = el("wwFoot");
      f.innerHTML = '<a href="javascript:void(0)" id="wwSetLoc" style="color:#58a6ff">点击设置地点</a>';
      var b = el("wwSetLoc");
      if (b) b.onclick = promptLocation;
      return;
    }
    showMsg("加载中…");
    resolveCoords(loc)
      .then(function (c) { LOC = c; return fetchForecast(c); })
      .then(render)
      .catch(function (e) {
        showMsg("获取失败");
        var f = el("wwFoot");
        if (f) f.textContent = "天气获取失败：" + (e && e.message ? e.message : e);
      });
  }

  function promptLocation() {
    var v = window.prompt("输入地点（城市名，或 lat,lon）：", currentLocation() || "");
    if (v === null) return;
    v = v.trim();
    saveLocation(v);
    loadWeather();
  }

  function applyBox() {
    var w = OPTS.size && OPTS.size.width ? OPTS.size.width : 260;
    var p = OPTS.pos && (OPTS.pos.left || OPTS.pos.top);
    if (p) {
      if (OPTS.pos.left) ROOT.style.left = OPTS.pos.left + "px";
      if (OPTS.pos.top) ROOT.style.top = OPTS.pos.top + "px";
    }
    if (MIN) {
      ROOT.classList.add("ww-min");
      ROOT.style.width = (OPTS.size && OPTS.size.width ? OPTS.size.width : 260) + "px";
      ROOT.style.height = "auto";
      return;
    }
    ROOT.classList.remove("ww-min");
    if (w) ROOT.style.width = w + "px";
    // 高度允许手动调整：卡片变小时，内容区（.ww-body）会滚动而不是溢出卡片外；
    // 不传高度则 height:auto 跟随内容。
    var h = OPTS.size && OPTS.size.height ? OPTS.size.height : null;
    if (h) ROOT.style.height = h + "px";
    else ROOT.style.height = "auto";
  }

  function enableDrag() {
    var bar = el("wwBar");
    var minbar = el("wwMinBar");
    bar.style.touchAction = "none";
    if (minbar) minbar.style.touchAction = "none";

    function bindHandle(handle) {
      if (!handle) return;
      handle.addEventListener("pointerdown", function (e) {
        if (e.target.tagName === "BUTTON") return;
        e.stopPropagation();
        try { handle.setPointerCapture(e.pointerId); } catch (err) {}
        var sx = e.clientX, sy = e.clientY;
        var r = ROOT.getBoundingClientRect();
        var ox = r.left, oy = r.top;
        function move(ev) {
          ROOT.style.left = Math.max(0, ox + ev.clientX - sx) + "px";
          ROOT.style.top = Math.max(0, oy + ev.clientY - sy) + "px";
        }
        function up() {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          handle.removeEventListener("pointercancel", up);
          // 松手吸附到桌面图标网格（与图标行列对齐，视觉整齐）
          var rr = ROOT.getBoundingClientRect();
          if (window.__rl93_snapToGrid) {
            var sn = window.__rl93_snapToGrid(rr.left, rr.top);
            ROOT.style.left = sn.left + "px";
            ROOT.style.top = sn.top + "px";
            rr = ROOT.getBoundingClientRect();
          }
          saveBox({ left: Math.round(rr.left), top: Math.round(rr.top) }, OPTS.size);
        }
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
        e.preventDefault();
      });
    }
    bindHandle(bar);
    bindHandle(minbar);
  }

  function enableResize() {
    var h = el("wwRsz");
    h.style.touchAction = "none";
    h.addEventListener("pointerdown", function (e) {
      e.stopPropagation();
      e.preventDefault();
      try { h.setPointerCapture(e.pointerId); } catch (err) {}
      var sx = e.clientX, sy = e.clientY;
      var sw = ROOT.offsetWidth, sh = ROOT.offsetHeight;
      function move(ev) {
        var nw = Math.max(MINW, Math.min((window.innerWidth || 1024) - 40,
                                         sw + (ev.clientX - sx)));
        var nh = Math.max(MINH, sh + (ev.clientY - sy));
        ROOT.style.width = nw + "px";
        ROOT.style.height = nh + "px";   // 内容区会滚动，绝不溢出卡片外
      }
      function up() {
        h.removeEventListener("pointermove", move);
        h.removeEventListener("pointerup", up);
        h.removeEventListener("pointercancel", up);
        saveBox(OPTS.pos, { width: ROOT.offsetWidth, height: ROOT.offsetHeight });
      }
      h.addEventListener("pointermove", move);
      h.addEventListener("pointerup", up);
      h.addEventListener("pointercancel", up);
    });
  }

  function bind() {
    function refreshMinTemp() {
      var t = el("wwTemp");
      var mt = el("wwMinTemp");
      if (t && mt) mt.textContent = t.textContent;
    }
    function doMin() {
      refreshMinTemp();
      saveMin(true);
      applyBox();
    }
    function doRestore() {
      saveMin(false);
      applyBox();
    }
    el("wwMin").onclick = doMin;
    el("wwGrip2").onclick = doRestore;
    // 点击最小化条空白处也还原（除按钮外）
    el("wwMinBar").onclick = function (e) {
      if (e.target.tagName === "BUTTON") return;
      doRestore();
    };
    function close() {
      if (ROOT && ROOT.parentNode) ROOT.parentNode.removeChild(ROOT);
      if (REFRESH) clearInterval(REFRESH);
      saveVisible(false);
    }
    el("wwX").onclick = close;
    el("wwX2").onclick = close;
  }

  function readMin() {
    if (OPTS && "min" in OPTS) return !!OPTS.min;
    var s = store("ww_min");
    return s === "1";
  }

  function mount(opts) {
    OPTS = opts || {};
    API = OPTS.settingsApi || null;
    if (el("ww-root")) return;
    if (!OPTS.location && !store("ww_loc")) {
      // 注入场景：服务端的地点优先；演示场景：localStorage
    }
    MIN = readMin();
    ROOT = document.createElement("div");
    ROOT.id = "ww-root";
    ROOT.innerHTML =
      '<div class="ww-bar" id="wwBar">' +
        '<span class="ww-grip">🌤</span>' +
        '<span class="ww-title" id="wwTitle">天气</span>' +
        '<span class="ww-spacer"></span>' +
        '<button class="ww-min" id="wwMin" title="最小化">—</button>' +
        '<button class="ww-x" id="wwX" title="关闭">×</button>' +
      '</div>' +
      '<div class="ww-minbar" id="wwMinBar" style="display:none">' +
        '<span class="ww-grip" id="wwGrip2">🌤 <span id="wwMinTemp"></span></span>' +
        '<button class="ww-x" id="wwX2" title="关闭">×</button>' +
      '</div>' +
      '<div class="ww-body" id="wwBody">' +
        '<div class="ww-now">' +
          '<div class="ww-icon" id="wwIcon">🌤</div>' +
          '<div class="ww-temp" id="wwTemp">--°</div>' +
          '<div class="ww-cond" id="wwCond">加载中…</div>' +
          '<div class="ww-meta" id="wwMeta"></div>' +
        '</div>' +
        '<div class="ww-days" id="wwDays"></div>' +
        '<div class="ww-foot" id="wwFoot"></div>' +
      '</div>' +
      '<div class="ww-rsz" id="wwRsz" title="拖拽缩放"></div>';
    var host = OPTS.container || document.body || document.documentElement;
    host.appendChild(ROOT);
    if (OPTS.embed) ROOT.classList.add("ww-embed");
    applyBox();
    if (!OPTS.embed) { enableDrag(); enableResize(); }
    bind();
    loadWeather();
    if (REFRESH) clearInterval(REFRESH);
    REFRESH = setInterval(loadWeather, 30 * 60 * 1000);
  }

  W.mount = mount;
  // 从挂载容器中移除（用于管理页预览刷新，清理刷新定时器）
  W.unmount = function () {
    if (REFRESH) { clearInterval(REFRESH); REFRESH = null; }
    if (ROOT && ROOT.parentNode) ROOT.parentNode.removeChild(ROOT);
    ROOT = null;
  };
  window.WeatherWidget = W;

  if (!window.__ww_noauto) {
    window.addEventListener("DOMContentLoaded", function () {
      if (window.__ww_mounted) return;
      window.__ww_mounted = true;
      // 演示页：无后端，地点存 localStorage
      mount({ settingsApi: null, pos: null, size: null, location: null });
    });
  }
})();
