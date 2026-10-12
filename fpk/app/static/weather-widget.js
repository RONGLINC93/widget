/* 天气悬浮窗小组件（纯前端，数据来自 Open-Meteo，免 API Key、支持 CORS）
 * 壳（拖拽/四边缩放/最小化/关闭/固定/设置持久化）由 widget-shell.js 的 RLShell 统一提供，
 * 本文件只负责天气内容的渲染与数据请求；location 为天气特有字段，仍由本组件自行持久化。
 * 用法：
 *   WeatherWidget.mount({ settingsApi, pos, size, location, min, pinned })
 *   - settingsApi：设置读写接口（POST 接受 {visible,pos,size,pinned,location}），传 null 时退回 localStorage
 *   - pos/size/min/pinned：位置/大小/最小化/固定（RLShell 统一读写）
 *   - location：地点字符串（城市名或 "lat,lon"），空则提示用户设置
 * 演示页（weather-widget.html）不设置 __ww_noauto，加载后自动挂载（用 localStorage 存地点）。
 * 注入到飞牛桌面时由 inject.js 设 window.__ww_noauto 后手动挂载。
 */
(function () {
  "use strict";

  var W = {};                 // 兼容旧引用（本文件不再直接挂 W.mount，改用 RLShell 暴露）
  var API = null, LOC = null;
  var REFRESH = null;
  var MINW = 150, MINH = 120;

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
  // 顶栏标题与最小化条标题始终一致（最小化条也要显示地点名，别只剩一个图标）
  function setTitle(s) {
    var a = el("ww-title"), b = el("ww-mintitle");
    if (a) a.textContent = s;
    if (b) b.textContent = s;
  }

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
  function saveLocation(loc) {
    LOC = loc;
    if (!API) { store("ww_loc", loc || ""); return; }
    send({ location: loc || "" });
  }

  function currentLocation() {
    if (LOC) return LOC;
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
    setTitle(c.name || "天气");
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
      setTitle("天气");
      // 占位图标放进图标位（.ww-icon），温度位留空：
      // 否则最小化时会把这句占位图标当成温度抄进最小化条，出现两个 🌤。
      el("wwIcon").textContent = "🌤";
      el("wwTemp").textContent = "";
      var mt0 = el("wwMinTemp"); if (mt0) mt0.textContent = "";
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

  function buildContent() {
    return '<div class="ww-body">' +
      '<div class="ww-now">' +
        '<div class="ww-icon" id="wwIcon">🌤</div>' +
        '<div class="ww-temp" id="wwTemp">--°</div>' +
        '<div class="ww-cond" id="wwCond">加载中…</div>' +
        '<div class="ww-meta" id="wwMeta"></div>' +
      '</div>' +
      '<div class="ww-days" id="wwDays"></div>' +
      '<div class="ww-foot" id="wwFoot"></div>' +
    '</div>';
  }

  var Widget = RLShell.create({
    id: "ww", title: "天气", icon: "🌤", minW: MINW, minH: MINH, defW: 260, defH: null,
    build: function (body, ctx) {
      API = ctx.opts.settingsApi || null;
      LOC = (ctx.opts.location || "").trim() || LOC;
      body.innerHTML = buildContent();
      // 最小化条里显示温度（RLShell 最小化条为固定模板，这里注入一个温度位）
      var minbar = ctx.root.querySelector(".rl-minbar");
      if (minbar) {
        var mt = document.createElement("span");
        mt.id = "wwMinTemp"; mt.className = "ww-mtemp";
        var sp = minbar.querySelector(".rl-spacer");
        minbar.insertBefore(mt, sp);
      }
      loadWeather();
      if (REFRESH) clearInterval(REFRESH);
      REFRESH = setInterval(loadWeather, 30 * 60 * 1000);
      return {
        onDestroy: function () {
          if (REFRESH) { clearInterval(REFRESH); REFRESH = null; }
        }
      };
    }
  });
  window.WeatherWidget = Widget;

  if (!window.__ww_noauto) {
    window.addEventListener("DOMContentLoaded", function () {
      if (window.__ww_mounted) return;
      window.__ww_mounted = true;
      // 演示页：无后端，地点存 localStorage
      Widget.mount({ settingsApi: null, pos: null, size: null, location: null });
    });
  }
})();
