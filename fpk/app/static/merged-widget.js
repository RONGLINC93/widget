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
        window.TodoWidget && window.MonitorWidget;
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
        monitor: st.monitor_visible !== false,
        dir: st.visible !== false
      };

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

      function buildList() {
        // 先清空（重复挂载防御：build 可能被多次触发时 body 已含旧卡片）
        if (body.firstChild) body.innerHTML = "";
        var mounted = 0;
        var common = { settingsApi: BASE + "/api/settings" };

        if (on.calendar) {
          mountInto("CalendarWidget", {
            notes: st.calendar_notes || {},
            settingsApi: BASE + "/api/calendar_settings"
          });
          mounted++;
        }
        if (on.weather) {
          mountInto("WeatherWidget", {
            location: (st.weather_location || "").trim(),
            settingsApi: BASE + "/api/weather_settings"
          });
          mounted++;
        }
        if (on.worldclock) {
          mountInto("WorldClockWidget", {
            cities: st.worldclock_cities || [{ name: "本地", tz: "" }],
            settingsApi: BASE + "/api/worldclock_settings"
          });
          mounted++;
        }
        if (on.notes) {
          mountInto("NotesWidget", {
            notesApi: BASE + "/api/notes",
            settingsApi: BASE + "/api/notes_settings"
          });
          mounted++;
        }
        if (on.todo) {
          mountInto("TodoWidget", {
            todosApi: BASE + "/api/todos",
            settingsApi: BASE + "/api/todo_settings"
          });
          mounted++;
        }
        if (on.monitor) {
          mountInto("MonitorWidget", {
            monitorApi: BASE + "/api/monitor",
            settingsApi: BASE + "/api/monitor_settings"
          });
          mounted++;
        }
        if (on.dir) {
          mountInto("DirWidget", {
            path: (st.path || "").trim(),
            root: (st.root || "").trim(),
            api: BASE + "/api/list",
            fileApi: BASE + "/api/file",
            searchApi: BASE + "/api/search",
            settingsApi: BASE + "/api/settings"
          });
          mounted++;
        }

        if (!mounted) {
          var tip = document.createElement("div");
          tip.className = "rl-merged-empty";
          tip.textContent = "未开启任何组件，请到「小组件管理面板」开启后刷新。";
          body.appendChild(tip);
        }
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
