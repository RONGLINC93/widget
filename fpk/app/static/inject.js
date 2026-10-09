/* RONGLINC93 桌面小组件注入脚本
 * 由 nginx 直接 alias 提供（/ronglinc93widget-inject.js），注入到飞牛桌面页。
 * 直接把目录浏览器挂载进桌面 DOM（非 iframe），因此桌面其它区域完全点击穿透，
 * 仅卡片本身可交互。挂载后会搬进桌面容器、插在图标层与窗口层之间（同图标层次），
 * 原生窗口照常盖住它。
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

    // ---- 层级对齐：让浮层与桌面图标同层、被原生窗口盖住 ----
    // 教训：只调 z-index 没用——飞牛把原生窗口渲染在 #app 之类的容器里，而浮层是
    // body 的子节点且排在容器之后，只要 z-index ≥ 0 就会盖住容器里 z-index 再大的
    // 窗口。正确做法是把浮层**搬进桌面容器**，插在「图标层之后、窗口层之前」。
    var ICON_SELECTORS = [
      "[class*='desktop-icon']", "[class*='desktopIcon']",
      "[class*='desktop_item']", "[class*='desktopitem']",
      ".desktop-icon", ".icon-item"
    ];

    function findIconNode() {
      var i, k, list;
      for (i = 0; i < ICON_SELECTORS.length; i++) {
        list = document.querySelectorAll(ICON_SELECTORS[i]);
        for (k = 0; k < list.length; k++) {
          var r = list[k].getBoundingClientRect();
          if (r.width > 4 && r.height > 4) return list[k];   // 跳过隐藏的
        }
      }
      return document.querySelector(".desktop");
    }

    function findWindowNode() {
      // 找一个可见的原生应用窗口（类名含 window 且尺寸足够大，过滤窗口内部小部件）
      var list = document.querySelectorAll("[class*='window'], [class*='Window']");
      var best = null, bestDepth = -1;
      for (var i = 0; i < list.length; i++) {
        var w = list[i];
        var r = w.getBoundingClientRect();
        if (r.width < 250 || r.height < 150) continue;
        var depth = 0, n = w;
        while (n && n !== document.body) { depth++; n = n.parentElement; }
        if (depth > bestDepth) { best = w; bestDepth = depth; }   // 取最深的=真窗口
      }
      return best;
    }

    function breaksFixedPos(node) {
      // 祖先带 transform / filter 等会把 position:fixed 的包含块改掉导致错位
      var n = node;
      while (n && n !== document.body && n !== document.documentElement) {
        var cs = window.getComputedStyle(n);
        if ((cs.transform && cs.transform !== "none") ||
            (cs.perspective && cs.perspective !== "none") ||
            (cs.filter && cs.filter !== "none") ||
            (cs.backdropFilter && cs.backdropFilter !== "none") ||
            (cs.willChange && /transform|perspective|filter/.test(cs.willChange)) ||
            (cs.contain && /(layout|paint|strict|content)/.test(cs.contain))) {
          return true;
        }
        n = n.parentElement;
      }
      return false;
    }

    function placeLikeIcon(el) {
      var icon = findIconNode();
      if (!icon || icon === el) return false;
      var win = findWindowNode();
      if (win && win.contains(icon)) win = null;   // 匹配到包含桌面的容器，弃用

      var parent, before = null, iroot = null;
      if (win) {
        // 窗口层子树根 wroot：从 win 往上，走到「父节点同时包含图标」为止
        var wroot = win;
        while (wroot.parentElement) {
          var p = wroot.parentElement;
          if (p === document.body || p === document.documentElement) break;
          if (p.contains(icon)) break;
          wroot = p;
        }
        parent = wroot.parentElement;
        before = wroot;                 // 插在窗口层之前 → 窗口一定盖住浮层
        if (!parent || !parent.contains(icon)) return false;
        // 图标侧子树根：对齐它的 z-index，保证浮层不被图标压住
        iroot = icon;
        while (iroot.parentElement !== parent) iroot = iroot.parentElement;
      } else {
        // 没有已打开的窗口：先放到 .desktop 末尾，等有窗口时下次校准再前插
        var desk = document.querySelector(".desktop");
        if (!desk || desk === el) return false;
        parent = desk;
      }
      if (breaksFixedPos(parent)) return false;

      parent.insertBefore(el, before);   // before=null 等价 appendChild
      var z = iroot ? parseInt(window.getComputedStyle(iroot).zIndex, 10) : NaN;
      el.style.zIndex = isNaN(z) ? "" : String(z);
      el.setAttribute("data-rl93-layer",
        win ? "icon-layer/below-windows" : "desktop-tail");
      return true;
    }

    function layerZIndexOf(node) {
      // 从 node 往上收集祖先，返回「离 body 最近且带确定 z-index」的那个值
      var chain = [];
      var n = node;
      while (n && n !== document.body && n !== document.documentElement) {
        chain.push(n);
        n = n.parentElement;
      }
      for (var i = chain.length - 1; i >= 0; i--) {
        var z = parseInt(window.getComputedStyle(chain[i]).zIndex, 10);
        if (!isNaN(z)) return z;
      }
      return 0;
    }

    function alignWithDesktopIcons(el) {
      function apply() {
        if (!document.body.contains(el)) return;   // 用户已点 × 关闭
        if (placeLikeIcon(el)) return;
        // 兜底：搬不进桌面容器时，至少把 z-index 压到图标层（绝不超过 999）
        var icon = findIconNode();
        var z = icon ? layerZIndexOf(icon) : 0;
        if (isNaN(z)) z = 0;
        if (z > 999) z = 999;
        if (z < 0) z = 0;
        el.style.zIndex = String(z);
        el.setAttribute("data-rl93-layer", "body-z" + z);
      }
      apply();
      // 桌面是 SPA：图标/窗口可能晚于本脚本渲染，多补几次校准
      setTimeout(apply, 800);
      setTimeout(apply, 2500);
      setTimeout(apply, 6000);
    }

    function mountWidget(path, root, pos) {
      window.DirWidget.mount({
        path: path,
        root: root,
        pos: pos || null,
        api: BASE + "/api/list",
        settingsApi: BASE + "/api/settings"
      });
      // 与桌面图标同层：把卡片搬进桌面容器（图标层之后、窗口层之前），
      // 原生窗口照常盖住它；桌面其余区域仍点击穿透。
      var el = document.getElementById("dw-root");
      if (el) alignWithDesktopIcons(el);
    }
    document.head.appendChild(s);
  }

  ready(inject);
})();
