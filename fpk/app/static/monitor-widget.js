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

      function tempColor(t) { return t >= 80 ? " crit" : (t >= 60 ? " warn" : ""); }

      function render(stats) {
        if (!stats || !stats.ok) {
          body.innerHTML = '<div class="mn-unavail">系统监控不可用<br>（当前环境非 Linux 或 /proc 不可读）</div>';
          return;
        }
        var html = meter("CPU", stats.cpu, stats.cpu_model) +
          meter("内存", stats.mem.percent, fmtBytes(stats.mem.used) + " / " + fmtBytes(stats.mem.total) + "（共 " + fmtBytes(stats.mem.total) + "）");

        // 磁盘：优先多盘列表，回退到旧的单盘字段
        var diskList = (stats.disks && stats.disks.length) ? stats.disks
          : (stats.disk ? [stats.disk] : []);
        for (var di = 0; di < diskList.length; di++) {
          var d = diskList[di];
          // 存储卷 /volN 显示为「存储空间 N」，其余挂载点（/、/boot/efi 等）保留「硬盘 + 路径」
          var mpath = d.path || "";
          var mv = mpath.match(/^\/vol(\d+)$/);
          var dlabel;
          if (mv) dlabel = "存储空间 " + mv[1];             // 存储池卷 /volN
          else if (mpath === "/") dlabel = "系统盘";         // 根文件系统
          else if (mpath === "/boot/efi") dlabel = "EFI 分区"; // UEFI 引导分区
          else dlabel = "硬盘 " + mpath;                    // 其它挂载点
          html += meter(dlabel, d.percent,
                        fmtBytes(d.used) + " / " + fmtBytes(d.total));
        }

        if (stats.temps && stats.temps.length) {
          // 按 group 一级分组（CPU/主板/显卡/硬盘/…），组内按原顺序，分组按固定优先级排序
          var groupOrder = ["CPU", "主板", "显卡", "硬盘", "内存", "网卡", "电池", "其它"];
          var gmap = {}, gorder = [];
          stats.temps.forEach(function (t) {
            var g = t.group || "其它";
            if (!gmap[g]) { gmap[g] = []; gorder.push(g); }
            gmap[g].push(t);
          });
          gorder.sort(function (a, b) {
            var ia = groupOrder.indexOf(a), ib = groupOrder.indexOf(b);
            if (ia < 0) ia = groupOrder.length;
            if (ib < 0) ib = groupOrder.length;
            return ia - ib;
          });
          var th = '<div class="mn-sec">温度</div>';
          th += gorder.map(function (g) {
            return '<div class="mn-sub">' + esc(g) + '</div>' + gmap[g].map(function (t) {
              var pct = Math.max(0, Math.min(100, t.temp || 0));
              return '<div class="mn-row">' +
                '<div class="mn-top"><span class="mn-label">' + esc(t.name) + '</span>' +
                '<span class="mn-val">' + esc((t.temp || 0).toFixed(1)) + '°C</span></div>' +
                '<div class="mn-track"><div class="mn-fill' + tempColor(t.temp) + '" style="width:' + pct + '%"></div></div></div>';
            }).join("");
          }).join("");
          html += th;
        }

        if (stats.fans && stats.fans.length) {
          html += '<div class="mn-sec">风扇</div>' + stats.fans.map(function (f) {
            return '<div class="mn-row"><div class="mn-top">' +
              '<span class="mn-label">' + esc(f.name) + '</span>' +
              '<span class="mn-val">' + esc(f.rpm) + ' RPM</span></div></div>';
          }).join("");
        }

        if (stats.gpus && stats.gpus.length) {
          html += '<div class="mn-sec">显卡</div>' + stats.gpus.map(function (g) {
            var u = (g.usage == null) ? null : Math.max(0, Math.min(100, g.usage));
            var row = '<div class="mn-row">';
            if (u != null) {
              row += '<div class="mn-top"><span class="mn-label">' + esc(g.name) + ' 使用率</span>' +
                '<span class="mn-val">' + esc(u.toFixed(1)) + '%</span></div>' +
                '<div class="mn-track"><div class="mn-fill" style="width:' + u + '%"></div></div>';
            } else {
              row += '<div class="mn-top"><span class="mn-label">' + esc(g.name) + '</span>' +
                '<span class="mn-val">使用率 N/A</span></div>';
            }
            if (g.temp != null) {
              row += '<div class="mn-top" style="margin-top:3px"><span class="mn-label" style="color:#6e7681">温度</span>' +
                '<span class="mn-val" style="color:#ff7b72">' + esc(g.temp.toFixed(1)) + '°C</span></div>';
            }
            return row + '</div>';
          }).join("");
        }

        html += '<div class="mn-uptime">已运行 ' + esc(fmtUptime(stats.uptime)) + '</div>';
        body.innerHTML = html;
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
