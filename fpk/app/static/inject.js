/* RONGLINC93 桌面小组件注入脚本
 * 由 nginx 直接 alias 提供（/ronglinc93widget-inject.js），注入到飞牛桌面页。
 * 直接把目录浏览器挂载进桌面 DOM（非 iframe），因此桌面其它区域完全点击穿透，
 * 仅卡片本身可交互。挂载后会搬进桌面容器、插在图标层与窗口层之间（同图标层次），
 * 原生窗口照常盖住它。
 * 注意：/ 与 /login 是同一份注入页，因此必须等桌面容器出现（已登录）才挂载，
 * 绝不能在登录页显示。
 */
(function () {
  "use strict";
  if (window.__rl93_injected) return;
  window.__rl93_injected = true;

  var BASE = "/rl93w";

  function ready(cb) {
    // 只在「登录后的桌面」挂载。
    // 为什么不能放宽到 document.body：conf.d 把 location = /login 也 rewrite 到了
    // 同一个注入页，登录页和桌面共用这份 HTML —— 若 body 一存在就挂载，
    // 未登录的人（包括任何能打开这台 NAS 网页的人）在登录界面就能看到目录内容。
    // 因此必须等到桌面容器 .desktop 出现、且页面上没有登录表单才挂载；
    // 登录成功 SPA 渲染出桌面后，轮询自然命中，无需刷新。
    var desktop = document.querySelector(".desktop");
    var onLogin = !!document.querySelector("input[type=password]");
    if (desktop && !onLogin) { cb(); return; }
    setTimeout(function () { ready(cb); }, 500);
  }

  function inject() {
    // ---- 通用浮层外壳：必须先于所有组件加载，提供 RLShell（目录/日历/天气/4 个新组件均依赖）----
    var shCss = document.createElement("link");
    shCss.rel = "stylesheet";
    shCss.href = BASE + "/static/widget-shell.css";
    document.head.appendChild(shCss);

    var shJs = document.createElement("script");
    shJs.async = false;   // 必须按插入顺序先于各组件执行，否则 RLShell 未定义
    shJs.src = BASE + "/static/widget-shell.js";
    shJs.onload = function () {
      if (!window.RLShell) return;

      // 加载单个新组件：脚本就绪后拉设置，若用户曾在桌面关掉（visible===false）则不挂载
      function mountNewWidget(globalName, src, settingsKey, mountOptsFn) {
        var s = document.createElement("script");
        s.src = src;
        s.onload = function () {
          var W = window[globalName];
          if (!W) return;
          fetch(BASE + "/api/settings", { cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (j) {
              var st = j && j.settings ? j.settings : {};
              if (st[settingsKey] === false) return;
              var opts = mountOptsFn(st);
              W.mount(opts);
              var el = document.getElementById(opts.__root);
              if (el) alignWithDesktopIcons(el);
            })
            .catch(function () { /* 出错则不挂载，保持桌面干净 */ });
        };
        document.head.appendChild(s);
      }

      mountNewWidget("WorldClockWidget", BASE + "/static/worldclock-widget.js", "worldclock_visible",
        function (st) {
          return { __root: "wc-root", settingsApi: BASE + "/api/worldclock_settings",
            pos: st.worldclock_pos, size: st.worldclock_size,
            min: !!st.worldclock_min, pinned: !!st.worldclock_pinned,
            cities: st.worldclock_cities };
        });
      mountNewWidget("NotesWidget", BASE + "/static/notes-widget.js", "notes_visible",
        function (st) {
          return { __root: "nt-root", settingsApi: BASE + "/api/notes_settings",
            notesApi: BASE + "/api/notes", pos: st.notes_pos, size: st.notes_size,
            min: !!st.notes_min, pinned: !!st.notes_pinned };
        });
      mountNewWidget("TodoWidget", BASE + "/static/todo-widget.js", "todo_visible",
        function (st) {
          return { __root: "td-root", settingsApi: BASE + "/api/todo_settings",
            todosApi: BASE + "/api/todos", pos: st.todo_pos, size: st.todo_size,
            min: !!st.todo_min, pinned: !!st.todo_pinned };
        });
      mountNewWidget("MonitorWidget", BASE + "/static/monitor-widget.js", "monitor_visible",
        function (st) {
          return { __root: "mn-root", settingsApi: BASE + "/api/monitor_settings",
            monitorApi: BASE + "/api/monitor", refresh: st.monitor_refresh, groups: st.monitor_groups,
            pos: st.monitor_pos, size: st.monitor_size,
            min: !!st.monitor_min, pinned: !!st.monitor_pinned };
        });
      mountNewWidget("TimerWidget", BASE + "/static/timer-widget.js", "timer_visible",
        function (st) {
          return { __root: "tm-root", settingsApi: BASE + "/api/timer_settings",
            preset: st.timer_preset || 300, pos: st.timer_pos, size: st.timer_size,
            min: !!st.timer_min, pinned: !!st.timer_pinned };
        });

      // 主题：全局生效于所有组件外壳与内容（dark / light / system 跟随系统配色）
      function applyTheme(t) {
        var html = document.documentElement;
        if (t === "light" || t === "dark") {
          html.setAttribute("data-theme", t);
        } else {
          var mq = window.matchMedia("(prefers-color-scheme: light)");
          html.setAttribute("data-theme", mq.matches ? "light" : "dark");
        }
      }
      fetch(BASE + "/api/settings", { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var st = j && j.settings ? j.settings : {};
          var t = st.theme || "system";
          applyTheme(t);
          var mq = window.matchMedia("(prefers-color-scheme: light)");
          var onScheme = function () { if (t === "system") applyTheme("system"); };
          if (mq.addEventListener) mq.addEventListener("change", onScheme);
          else if (mq.addListener) mq.addListener(onScheme);
        })
        .catch(function () { /* 取不到则用默认（夜间） */ });
    };
    document.head.appendChild(shJs);

    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = BASE + "/static/dir-widget.css";
    document.head.appendChild(link);

    var s = document.createElement("script");
    s.async = false;   // 与外壳同为顺序脚本，保证外壳先执行
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
          mountWidget(st.path || getLocalPath(), st.root || "", st.pos, st.size, st.pinned, st.dir_min);
        })
        .catch(function () { mountWidget(getLocalPath(), "", null, null, false); });
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

    // ---- 桌面图标网格探测 + 吸附（让浮层拖拽松手时对齐图标行列，视觉整齐）----
    // 注：这是「吸附对齐」而非「图标避让」——只把浮层对齐到图标网格的步距，
    // 不与飞牛的图标布局算法交互（飞牛也不提供第三方程序注册成桌面图标的接口）。
    function collectIconRects() {
      var seen = {}, out = [];
      for (var i = 0; i < ICON_SELECTORS.length; i++) {
        var list = document.querySelectorAll(ICON_SELECTORS[i]);
        for (var k = 0; k < list.length; k++) {
          var r = list[k].getBoundingClientRect();
          if (r.width < 8 || r.height < 8) continue;
          var key = Math.round(r.left) + "," + Math.round(r.top) + "," +
                    Math.round(r.width) + "," + Math.round(r.height);
          if (seen[key]) continue;
          seen[key] = 1;
          out.push(r);
        }
      }
      return out;
    }

    // 取相邻网格线间距的众数（忽略同列重复/亚像素抖动）
    function modeStep(sorted) {
      var diffs = {}, best = 0, bestC = 0, i;
      for (i = 1; i < sorted.length; i++) {
        var d = sorted[i] - sorted[i - 1];
        if (d < 6) continue;
        diffs[d] = (diffs[d] || 0) + 1;
      }
      for (var k in diffs) {
        if (diffs[k] > bestC) { bestC = diffs[k]; best = Number(k); }
      }
      return best;
    }

    function snapToIconGrid(left, top) {
      var icons = collectIconRects();
      if (!icons.length) return { left: left, top: top };
      var lefts = icons.map(function (r) { return r.left; })
        .sort(function (a, b) { return a - b; });
      var tops = icons.map(function (r) { return r.top; })
        .sort(function (a, b) { return a - b; });
      // 去重（同列图标 left 相同）
      var ul = [], ut = [], last = null;
      lefts.forEach(function (v) { if (v !== last) { ul.push(v); last = v; } });
      last = null;
      tops.forEach(function (v) { if (v !== last) { ut.push(v); last = v; } });
      var ox = ul[0], oy = ut[0];
      var sx = modeStep(ul) || (icons[0].width + 8);
      var sy = modeStep(ut) || (icons[0].height + 8);
      var nx = ox + Math.round((left - ox) / sx) * sx;
      var ny = oy + Math.round((top - oy) / sy) * sy;
      var vw = window.innerWidth || 1024, vh = window.innerHeight || 768;
      nx = Math.max(0, Math.min(nx, vw - 40));
      ny = Math.max(0, Math.min(ny, vh - 40));
      return { left: nx, top: ny };
    }
    window.__rl93_snapToGrid = snapToIconGrid;

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
        // icon 可能等于 parent（findIconNode 兜底返回 .desktop）或与 parent 无祖先后代关系，
        // 此时向上爬会越过 documentElement 读到 null 而抛错；爬空则放弃 z 对齐（仍正常插入）
        while (iroot && iroot.parentElement !== parent) iroot = iroot.parentElement;
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

    function mountWidget(path, root, pos, size, pinned, min) {
      window.DirWidget.mount({
        path: path,
        root: root,
        pos: pos || null,
        size: size || null,
        pinned: !!pinned,
        min: !!min,
        api: BASE + "/api/list",
        fileApi: BASE + "/api/file",
        searchApi: BASE + "/api/search",
        settingsApi: BASE + "/api/settings"
      });
      // 与桌面图标同层：把卡片搬进桌面容器（图标层之后、窗口层之前），
      // 原生窗口照常盖住它；桌面其余区域仍点击穿透。
      var el = document.getElementById("dw-root");
      if (el) alignWithDesktopIcons(el);
    }
    document.head.appendChild(s);

    // ---- 日历组件（可选显示，独立于目录浏览器）----
    var clink = document.createElement("link");
    clink.rel = "stylesheet";
    clink.href = BASE + "/static/calendar-widget.css";
    document.head.appendChild(clink);

    // 农历转换库（calendar-widget.js 依赖 window.Lunar），须先于日历脚本加载
    var ls = document.createElement("script");
    ls.async = false;
    ls.src = BASE + "/static/lunar.js";
    document.head.appendChild(ls);

    // 法定节假日数据（calendar-widget.js 依赖 window.HolidayCN），须先于日历脚本加载
    var hs = document.createElement("script");
    hs.async = false;
    hs.src = BASE + "/static/holiday-cn.js";
    document.head.appendChild(hs);

    var cs = document.createElement("script");
    cs.async = false;
    // 告知 calendar-widget.js：由本脚本手动挂载，不要走它的自动挂载（避免重复实例）
    window.__cw_noauto = true;
    cs.src = BASE + "/static/calendar-widget.js";
    cs.onload = function () {
      if (!window.CalendarWidget) return;
      var mountCal = function (pos, size, notes, min, pinned, weekStart, showLunar, showHoliday) {
        window.CalendarWidget.mount({
          settingsApi: BASE + "/api/calendar_settings",
          pos: pos || null,
          size: size || null,
          min: !!min,
          pinned: !!pinned,
          weekStart: (weekStart === 0) ? 0 : 1,
          showLunar: showLunar !== false,
          showHoliday: showHoliday !== false,
          notes: (notes && typeof notes === "object") ? notes : {}
        });
        var cel = document.getElementById("cw-root");
        if (cel) alignWithDesktopIcons(cel);
      };
      fetch(BASE + "/api/settings", { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var st = j && j.settings ? j.settings : {};
          // 用户在桌面上点过 × 关闭日历 → 不再自动挂载，直到在应用窗口重新开启
          if (st.calendar_visible === false) return;
          mountCal(st.calendar_pos, st.calendar_size, st.calendar_notes, st.calendar_min, st.calendar_pinned,
                   st.calendar_week_start, st.calendar_show_lunar, st.calendar_show_holiday);
        })
        .catch(function () { mountCal(null, null, {}, false, false, 1, true, true); });
    };
    document.head.appendChild(cs);

    // ---- 天气组件（可选显示，独立于目录浏览器/日历）----
    var wlink = document.createElement("link");
    wlink.rel = "stylesheet";
    wlink.href = BASE + "/static/weather-widget.css";
    document.head.appendChild(wlink);

    var ws = document.createElement("script");
    ws.async = false;
    // 告知 weather-widget.js：由本脚本手动挂载，不要走它的自动挂载（避免重复实例）
    window.__ww_noauto = true;
    ws.src = BASE + "/static/weather-widget.js";
    ws.onload = function () {
      if (!window.WeatherWidget) return;
      var mountW = function (pos, size, location, min, pinned) {
        window.WeatherWidget.mount({
          settingsApi: BASE + "/api/weather_settings",
          pos: pos || null,
          size: size || null,
          location: location || "",
          min: !!min,
          pinned: !!pinned
        });
        var wel = document.getElementById("ww-root");
        if (wel) alignWithDesktopIcons(wel);
      };
      fetch(BASE + "/api/settings", { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var st = j && j.settings ? j.settings : {};
          // 用户在桌面上点过 × 关闭天气 → 不再自动挂载，直到在应用窗口重新开启
          if (st.weather_visible === false) return;
          mountW(st.weather_pos, st.weather_size, st.weather_location, st.weather_min, st.weather_pinned);
        })
        .catch(function () { mountW(null, null, "", false, false); });
    };
    document.head.appendChild(ws);

  }

  ready(inject);
})();
