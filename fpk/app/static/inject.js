/* RONGLINC93 桌面小组件注入脚本
 * 由 nginx 直接 alias 提供（/ronglinc93widget-inject.js），注入到飞牛桌面页。
 * 直接把目录浏览器挂载进桌面 DOM（非 iframe），因此桌面其它区域完全点击穿透，
 * 仅卡片本身可交互，且不遮挡原生窗口(10010+)。
 */
(function () {
  "use strict";
  if (window.__rl93_injected) return;
  window.__rl93_injected = true;

  var BASE = "/rl93w";

  function ready(cb) {
    // 等飞牛桌面容器就绪再挂载
    if (document.querySelector(".desktop") || document.body) cb();
    else setTimeout(function () { ready(cb); }, 300);
  }

  function inject() {
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = BASE + "/static/dir-widget.css";
    document.head.appendChild(link);

    var s = document.createElement("script");
    s.src = BASE + "/static/dir-widget.js";
    s.onload = function () {
      if (!window.DirWidget) return;
      // 路径以服务端保存的为准（应用窗口点"保存"写入），取不到再退回本地缓存。
      // 桌面页(5666/5667)与应用窗(8099)不同源，localStorage 不能互通，必须走服务端。
      fetch(BASE + "/api/settings", { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var st = j && j.settings ? j.settings : {};
          // 用户在桌面上点过 × 关闭 → 不再自动挂载，直到在应用窗口重新开启
          if (st.visible === false) return;
          mountWidget(st.path || getLocalPath(), st.root || "", st.pos);
        })
        .catch(function () { mountWidget(getLocalPath(), "", null); });
    };

    function getLocalPath() {
      try { return localStorage.getItem("rl93_path") || ""; } catch (e) { return ""; }
    }

    function mountWidget(path, root, pos) {
      window.DirWidget.mount({
        path: path,
        root: root,
        pos: pos || null,
        api: BASE + "/api/list",
        settingsApi: BASE + "/api/settings"
      });
      // 置于原生窗口之下，避免遮挡系统 UI；桌面其余区域点击穿透
      var el = document.getElementById("dw-root");
      if (el) el.style.zIndex = "100";
    }
    document.head.appendChild(s);
  }

  ready(inject);
})();
