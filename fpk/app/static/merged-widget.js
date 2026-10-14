/* RONGLINC93 整合面板（合并显示）
 * ============================================================================
 * 「合并显示」模式下，把所有已开启的小组件收纳进同一个浮层（类似 Windows
 * 小组件面板）：一个可拖拽 / 缩放 / 最小化 / 关闭的玻璃卡片，内部是一个可滚动的
 * 纵向列表，依次嵌入 日历 / 天气 / 世界时钟 / 便签 / 待办 / 系统监控 / 目录浏览器。
 *
 * 各组件仍用各自的 mount 接口，仅改为 container=面板内容区、preview=true，
 * 于是它们不再各自浮动、不再带独立的最小化/关闭按钮，而是作为面板里的一张张子卡片。
 * 面板自身的拖拽 / 缩放 / 位置记忆 / 显示开关由通用外壳 RLShell 统一提供。
 *
 * 用法：
 *   MergedWidget.mount({
 *     settingsApi: "/rl93w/api/merged_settings",   // 面板自身 box 持久化
 *     pos, size, min, pinned,                        // 面板位置 / 大小 / 最小化
 *     settings: <全局 settings.json>,                // 各组件开关与配置
 *     base: "/rl93w"                                 // 接口前缀（桌面注入用）
 *   });
 */
(function () {
  "use strict";

  function getBase(opts) {
    if (opts && opts.base) return opts.base;
    return location.pathname.indexOf("/rl93w/") === 0 ? "/rl93w" : "";
  }

  // 等所有组件脚本就绪（桌面注入时它们先于本脚本执行；管理页面同理），
  // 再开始内嵌挂载，避免某个组件未定义导致整列空白。
  function whenReady(fn) {
    var ready = function () {
      return window.DirWidget && window.CalendarWidget && window.WeatherWidget &&
        window.WorldClockWidget && window.NotesWidget &&
        window.TodoWidget && window.MonitorWidget && window.TimerWidget;
    };
    if (ready()) return fn();
    var waited = 0;
    var timer = setInterval(function () {
      if (ready()) { clearInterval(timer); fn(); }
      else if ((waited += 50) >= 10000) { clearInterval(timer); fn(); }
    }, 50);
  }

  var Board = RLShell.create({
    id: "merged",
    title: "小组件",
    icon: "🧩",
    minW: 280, minH: 200, defW: 360, defH: 640,
    build: function (body, ctx) {
      var opts = ctx.opts || {};
      var BASE = getBase(opts);
      var st = (opts.settings && typeof opts.settings === "object") ? opts.settings : {};
      ctx.root.classList.add("rl-merged");
      body.classList.add("rl-merged-body");
      var handles = [];

      // 各组件是否开启（与桌面单独浮层共用同一份 visible 开关）
      var on = {
        calendar: st.calendar_visible !== false,
        weather: st.weather_visible !== false,
        worldclock: st.worldclock_visible !== false,
        notes: st.notes_visible !== false,
        todo: st.todo_visible !== false,
        timer: st.timer_visible !== false,
        monitor: st.monitor_visible !== false,
        dir: st.visible !== false
      };

      // 面板内组件默认顺序；merged_order 可自定义（桌面 / 预览共用，持久化到设置）
      var DEFAULT_ORDER = ["calendar", "weather", "worldclock", "notes", "todo",
                           "timer", "monitor", "dir"];
      // 组件 key → 其根节点 id（用于回写 data-rl-key，拖拽排序后识别身份）
      var KEY_ID = { calendar: "cw-root", weather: "ww-root", worldclock: "wc-root",
                     notes: "nt-root", todo: "td-root", timer: "tm-root",
                     monitor: "mn-root", dir: "dw-root" };

      function mountInto(globalName, mountOpts) {
        var W = window[globalName];
        if (!W || typeof W.mount !== "function") return;
        // preview:true 让子组件只渲染内容、不挂独立标题栏按钮 / 不抢拖拽
        var o = {};
        for (var k in mountOpts) if (Object.prototype.hasOwnProperty.call(mountOpts, k)) o[k] = mountOpts[k];
        o.container = body;
        o.preview = true;
        o.draggable = false;
        try {
          var h = W.mount(o);
          if (h && typeof h.destroy === "function") handles.push(h);
        } catch (e) { /* 单个组件失败不影响整体 */ }
      }

      // 按 key 构建并挂载对应组件（保留各自原始配置）
      function mountByKey(key) {
        if (key === "calendar") {
          mountInto("CalendarWidget", { notes: st.calendar_notes || {},
            settingsApi: BASE + "/api/calendar_settings" });
        } else if (key === "weather") {
          mountInto("WeatherWidget", { location: (st.weather_location || "").trim(),
            settingsApi: BASE + "/api/weather_settings" });
        } else if (key === "worldclock") {
          mountInto("WorldClockWidget", { cities: st.worldclock_cities || [{ name: "本地", tz: "" }],
            settingsApi: BASE + "/api/worldclock_settings" });
        } else if (key === "notes") {
          mountInto("NotesWidget", { notesApi: BASE + "/api/notes",
            settingsApi: BASE + "/api/notes_settings" });
        } else if (key === "todo") {
          mountInto("TodoWidget", { todosApi: BASE + "/api/todos",
            settingsApi: BASE + "/api/todo_settings" });
        } else if (key === "timer") {
          mountInto("TimerWidget", { preset: st.timer_preset || 300,
            settingsApi: BASE + "/api/timer_settings" });
        } else if (key === "monitor") {
          mountInto("MonitorWidget", { monitorApi: BASE + "/api/monitor",
            settingsApi: BASE + "/api/monitor_settings" });
        } else if (key === "dir") {
          mountInto("DirWidget", { path: (st.path || "").trim(), root: (st.root || "").trim(),
            api: BASE + "/api/list", fileApi: BASE + "/api/file",
            searchApi: BASE + "/api/search", settingsApi: BASE + "/api/settings" });
        }
      }

      // 解析最终排列顺序：以保存的 merged_order 为准，过滤非法 / 重复，补上未列出的新组件
      function resolveOrder() {
        var saved = Array.isArray(st.merged_order) ? st.merged_order : [];
        var seq = [], seen = {};
        saved.forEach(function (k) {
          if (DEFAULT_ORDER.indexOf(k) >= 0 && !seen[k]) { seq.push(k); seen[k] = 1; }
        });
        DEFAULT_ORDER.forEach(function (k) { if (!seen[k]) seq.push(k); });
        return seq;
      }

      // ---- 面板内拖拽重排：拖动子卡片标题栏即可调整上下顺序，松手写回 merged_order ----
      // 注意：pointermove/up 监听挂在 document 上，而非标题栏本身——否则卡片被移动、
      // 光标离开标题栏后拖动就失效。pointerdown 在标题栏上即可（仅用于起手）。
      function enableReorder() {
        function cards() {
          return Array.prototype.slice.call(body.querySelectorAll(":scope > .rl-root[data-rl-key]"));
        }
        cards().forEach(function (card) {
          var bar = card.querySelector(".rl-bar") || card.querySelector(".rl-minbar");
          if (!bar) return;
          bar.style.cursor = "grab";
          bar.addEventListener("pointerdown", function (e) {
            if (e.button !== 0 || e.target.closest("button")) return;  // 忽略非左键与按钮
            e.preventDefault();
            var dragEl = card, startY = e.clientY, started = false;
            bar.style.cursor = "grabbing";
            function onMove(ev) {
              if (!started) {
                if (Math.abs(ev.clientY - startY) < 5) return;
                started = true; dragEl.classList.add("rl-reordering");
              }
              var y = ev.clientY, ref = null, sibs = cards();
              for (var i = 0; i < sibs.length; i++) {
                if (sibs[i] === dragEl) continue;
                var r = sibs[i].getBoundingClientRect();
                if (y < r.top + r.height / 2) { ref = sibs[i]; break; }
              }
              if (ref) body.insertBefore(dragEl, ref);
              else body.appendChild(dragEl);
            }
            function onUp() {
              document.removeEventListener("pointermove", onMove);
              document.removeEventListener("pointerup", onUp);
              document.removeEventListener("pointercancel", onUp);
              bar.style.cursor = "grab";
              if (started) {
                dragEl.classList.remove("rl-reordering");
                var order = cards().map(function (c) { return c.dataset.rlKey; });
                saveOrder(order);
              }
            }
            document.addEventListener("pointermove", onMove);
            document.addEventListener("pointerup", onUp);
            document.addEventListener("pointercancel", onUp);
          });
        });
      }

      function saveOrder(order) {
        if (!order || !order.length) return;
        try {
          fetch(getBase(opts) + "/api/merged_settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ order: order })
          });
        } catch (e) { /* 写回失败不影响本次预览 */ }
      }

      function buildList() {
        // 先清空（重复挂载防御：build 可能被多次触发时 body 已含旧卡片）
        if (body.firstChild) body.innerHTML = "";
        var mounted = 0;
        var seq = resolveOrder();
        for (var i = 0; i < seq.length; i++) {
          var key = seq[i];
          if (!on[key]) continue;        // 该组件未开启则跳过
          mountByKey(key);
          // 给本次挂载出来的根节点打标记，供拖拽排序识别身份
          var rid = KEY_ID[key];
          var el = rid ? document.getElementById(rid) : null;
          if (el && el.classList.contains("rl-root")) el.dataset.rlKey = key;
          mounted++;
        }

        if (!mounted) {
          var tip = document.createElement("div");
          tip.className = "rl-merged-empty";
          tip.textContent = "未开启任何组件，请到「小组件管理面板」开启后刷新。";
          body.appendChild(tip);
          return;
        }
        enableReorder();   // 允许在面板内拖动标题栏重排顺序
      }

      whenReady(buildList);

      return {
        onDestroy: function () {
          for (var i = 0; i < handles.length; i++) {
            try { handles[i].destroy(); } catch (e) {}
          }
          handles = [];
        }
      };
    }
  });

  // 合并面板固定为右侧整高侧栏：禁用拖拽/缩放（由 CSS 把位置/尺寸钉死在右侧整高），
  // 仍保留 ×（隐藏整面板，退回单独浮层）与固定按钮。
  window.MergedWidget = {
    mount: function (mountOpts) {
      var o = mountOpts || {};
      o.embed = true;   // 关闭 RLShell 的拖拽/缩放，避免与右侧整高布局冲突
      return Board.mount(o);
    }
  };
})();
