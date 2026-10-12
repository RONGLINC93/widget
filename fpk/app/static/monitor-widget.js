/* 系统监控悬浮窗组件（数据来自 GET /api/monitor：Linux /proc，异常降级）
 * 用法：MonitorWidget.mount({ settingsApi, monitorApi, pos, size, min, pinned })
 *   monitorApi 既可以是接口 URL（GET 拉取 JSON），也可以是函数（演示场景直接供数，
 *   同步返回 stats 或返回 Promise<stats>），便于无后端时展示模拟数据。
 */
(function () {
  "use strict";

  function fmtBytes(b) {
    if (!b) return "0";
    var u = ["B", "KB", "MB", "GB", "TB"];
    var i = 0;
    var n = b;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + " " + u[i];
  }

  function fmtUptime(s) {
    s = Math.floor(s || 0);
    var d = Math.floor(s / 86400);
    var h = Math.floor((s % 86400) / 3600);
    var m = Math.floor((s % 3600) / 60);
    if (d > 0) return d + " 天 " + h + " 小时";
    if (h > 0) return h + " 小时 " + m + " 分";
    return m + " 分";
  }

  var W = RLShell.create({
    id: "mn", title: "系统监控", icon: "📊", minW: 240, minH: 140, defW: 260,
    build: function (body, ctx) {
      var esc = ctx.esc;
      var API = ctx.opts.monitorApi || null;
      var timer = null;

      function meter(label, pct, sub) {
        pct = Math.max(0, Math.min(100, pct || 0));
        var cls = pct >= 90 ? " crit" : (pct >= 70 ? " warn" : "");
        return '<div class="mn-row">' +
          '<div class="mn-top"><span class="mn-label">' + esc(label) + '</span>' +
          '<span class="mn-val">' + esc(pct.toFixed(1)) + '%</span></div>' +
          '<div class="mn-track"><div class="mn-fill' + cls + '" style="width:' + pct + '%"></div></div>' +
          (sub ? '<div class="mn-top" style="margin-top:3px"><span class="mn-label" style="color:#6e7681">' + esc(sub) + '</span></div>' : '') +
          '</div>';
      }

      function render(stats) {
        if (!stats || !stats.ok) {
          body.innerHTML = '<div class="mn-unavail">系统监控不可用<br>（当前环境非 Linux 或 /proc 不可读）</div>';
          return;
        }
        body.innerHTML =
          meter("CPU", stats.cpu) +
          meter("内存", stats.mem.percent, fmtBytes(stats.mem.used) + " / " + fmtBytes(stats.mem.total)) +
          meter("磁盘 " + (stats.disk.path || ""), stats.disk.percent,
                 fmtBytes(stats.disk.used) + " / " + fmtBytes(stats.disk.total)) +
          '<div class="mn-uptime">已运行 ' + esc(fmtUptime(stats.uptime)) + '</div>';
      }

      function poll() {
        if (typeof API === "function") {          // 演示场景：函数直接供数
          try {
            var r = API();
            if (r && typeof r.then === "function") r.then(render).catch(function () { render(null); });
            else render(r);
          } catch (e) { render(null); }
          return;
        }
        if (!API) { render(null); return; }
        fetch(API, { cache: "no-store" }).then(function (r) { return r.json(); })
          .then(render).catch(function () { render(null); });
      }

      poll();
      timer = setInterval(poll, 2000);

      return { onDestroy: function () { if (timer) clearInterval(timer); } };
    }
  });

  window.MonitorWidget = W;

  if (!window.__mn_noauto) {
    window.addEventListener("DOMContentLoaded", function () {
      if (window.__mn_mounted) return;
      window.__mn_mounted = true;
      W.mount({ settingsApi: null, monitorApi: null, pos: null, size: null });
    });
  }
})();
