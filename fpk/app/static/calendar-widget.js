/* 日历悬浮窗组件（纯原生 JS，零依赖）
 * 壳（拖拽/四边缩放/最小化/关闭/固定/设置持久化）由 widget-shell.js 的 RLShell 统一提供，
 * 本文件只负责月历 + 实时时钟 + 每日备忘（持久化）的内容渲染。
 * 用法：
 *   CalendarWidget.mount({ settingsApi, pos, size, min, pinned, notes });
 *   - settingsApi：设置读写接口（POST 接受 {visible,pos,size,pinned,notes}），注入场景由 inject.js 传入
 *   - pos/size/min/pinned：位置/大小/最小化/固定（RLShell 统一读写，备忘另行走 notes 字段）
 *   - notes：{ "YYYY-MM-DD": "备忘文本" }
 * 演示页（calendar-widget.html）不设置 __cw_noauto 时自动挂载（用 localStorage 存备忘）。
 * 注入到飞牛桌面时由 inject.js 设 window.__cw_noauto 后手动挂载。
 */
(function (global) {
  "use strict";

  var WEEK_LABELS = ["一", "二", "三", "四", "五", "六", "日"]; // 周一为一周之首
  var MONTH_LABELS = ["1月", "2月", "3月", "4月", "5月", "6月",
    "7月", "8月", "9月", "10月", "11月", "12月"];

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function isoDate(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  // 周一为一周之首：把周日(0)映射成 6
  function mondayIndex(dow) { return (dow + 6) % 7; }

  // ISO 周数（用于显示「第 N 周」）
  function isoWeek(d) {
    var date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var dayNum = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - dayNum + 3);
    var firstThursday = new Date(date.getFullYear(), 0, 4);
    var week = 1 + Math.round(
      ((date - firstThursday) / 86400000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
    return week;
  }

  function cnWeekday(d) {
    return ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][d.getDay()];
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var CalendarWidget = {};   // 仅作命名空间说明；真正实例由 RLShell.create 暴露
  function CWidget(opts) {
    this.opts = opts || {};
    this.settingsApi = this.opts.settingsApi || null;
    this.notes = (this.opts.notes && typeof this.opts.notes === "object") ? this.opts.notes : {};
    this.weekStart = (this.opts.weekStart === 0) ? 0 : 1;   // 0=周日开头，1=周一开头
    this.showLunar = this.opts.showLunar !== false;          // 默认显示农历
    this.showHoliday = this.opts.showHoliday !== false;      // 默认显示节假日
    this.viewYear = 0;
    this.viewMonth = 0;     // 0-11
    this.selectedKey = null;
    this.el = null;
    this._clockTimer = null;
  }

  CWidget.prototype.build = function (root, body) {
    var self = this;
    var now = new Date();
    this.viewYear = now.getFullYear();
    this.viewMonth = now.getMonth();
    this.selectedKey = isoDate(now);

    body.innerHTML =
      '<div class="cw-clock">' +
        '<div class="cw-time">--:--:--</div>' +
        '<div class="cw-date"></div>' +
      '</div>' +
      '<div class="cw-cal">' +
        '<div class="cw-cal-nav">' +
          '<button class="cw-nav-btn cw-prev-year" title="上一年">«</button>' +
          '<button class="cw-nav-btn cw-prev-month" title="上个月">‹</button>' +
          '<span class="cw-cal-title"></span>' +
          '<button class="cw-nav-btn cw-next-month" title="下个月">›</button>' +
          '<button class="cw-nav-btn cw-next-year" title="下一年">»</button>' +
          '<button class="cw-today-btn" title="回到今天">今天</button>' +
        '</div>' +
        '<div class="cw-weekdays"></div>' +
        '<div class="cw-grid"></div>' +
      '</div>' +
      '<div class="cw-memo">' +
        '<div class="cw-memo-date"></div>' +
        '<textarea class="cw-memo-input" placeholder="给这一天写点备忘…（自动保存）"></textarea>' +
        '<div class="cw-memo-row">' +
          '<button class="cw-memo-save">保存</button>' +
          '<span class="cw-memo-msg"></span>' +
        '</div>' +
      '</div>';

    this.el = root;

    // 搬进桌面容器后，交互不冒泡到桌面（避免误触桌面处理）
    root.addEventListener("mousedown", function (e) { e.stopPropagation(); });
    root.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    root.addEventListener("click", function (e) { e.stopPropagation(); });

    this.timeEl = root.querySelector(".cw-time");
    this.dateEl = root.querySelector(".cw-date");
    this.titleEl = root.querySelector(".cw-cal-title");
    this.weekdaysEl = root.querySelector(".cw-weekdays");
    this.gridEl = root.querySelector(".cw-grid");
    this.memoDateEl = root.querySelector(".cw-memo-date");
    this.memoInput = root.querySelector(".cw-memo-input");
    this.memoMsg = root.querySelector(".cw-memo-msg");

    // 星期表头（周末着色）
    var weekLabels = (self.weekStart === 0)
      ? ["日", "一", "二", "三", "四", "五", "六"]
      : ["一", "二", "三", "四", "五", "六", "日"];
    this.weekdaysEl.innerHTML = weekLabels.map(function (w, i) {
      var we = (self.weekStart === 0) ? (i === 0 || i === 6) : (i >= 5);
      return '<span class="' + (we ? "cw-we" : "") + '">' + w + "</span>";
    }).join("");

    root.querySelector(".cw-prev-month").addEventListener("click", function () { self._stepMonth(-1); });
    root.querySelector(".cw-next-month").addEventListener("click", function () { self._stepMonth(1); });
    root.querySelector(".cw-prev-year").addEventListener("click", function () { self._stepMonth(-12); });
    root.querySelector(".cw-next-year").addEventListener("click", function () { self._stepMonth(12); });
    root.querySelector(".cw-today-btn").addEventListener("click", function () {
      var n = new Date();
      self.viewYear = n.getFullYear();
      self.viewMonth = n.getMonth();
      self.selectedKey = isoDate(n);
      self._render();
    });

    // 备忘保存
    var saveBtn = root.querySelector(".cw-memo-save");
    function doSave() { self._saveNote(self.selectedKey, self.memoInput.value); }
    saveBtn.addEventListener("click", doSave);
    this.memoInput.addEventListener("blur", doSave);   // 失焦自动保存
    this.memoInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSave(); }
      e.stopPropagation();
    });

    this._render();
    this._startClock();
  };

  // ===================== 渲染月历 =====================
  CWidget.prototype._stepMonth = function (delta) {
    var m = this.viewMonth + delta;
    var y = this.viewYear + Math.floor(m / 12);
    m = ((m % 12) + 12) % 12;
    this.viewYear = y;
    this.viewMonth = m;
    this._render();
  };

  CWidget.prototype._render = function () {
    var self = this;
    this.titleEl.textContent = this.viewYear + "年 " + MONTH_LABELS[this.viewMonth];

    var first = new Date(this.viewYear, this.viewMonth, 1);
    var startDow = (first.getDay() - this.weekStart + 7) % 7;   // 按起始周算本月1号偏移
    var gridStart = new Date(this.viewYear, this.viewMonth, 1 - startDow);
    var todayKey = isoDate(new Date());

    var cells = [];
    for (var i = 0; i < 42; i++) {
      var d = new Date(gridStart.getFullYear(), gridStart.getMonth(),
                       gridStart.getDate() + i);
      var key = isoDate(d);
      var other = (d.getMonth() !== this.viewMonth);
      var we = (d.getDay() === 0 || d.getDay() === 6);
      var cls = "cw-cell";
      if (other) cls += " cw-other";
      if (we) cls += " cw-we";
      if (key === todayKey) cls += " cw-today";
      if (key === this.selectedKey) cls += " cw-selected";
      if (this.notes && this.notes[key]) cls += " cw-has-note";
      var sm = d.getMonth() + 1, sd = d.getDate();
      var lunText = "";
      if (this.showLunar && window.Lunar) {
        var lun = Lunar.solarToLunar(d.getFullYear(), sm, sd);
        lunText = Lunar.cellText(lun, sm, sd);
      }
      var hol = (this.showHoliday && window.HolidayCN) ? HolidayCN.get(d.getFullYear(), sm, sd) : null;
      if (hol) cls += (hol.off ? " cw-holiday" : " cw-work");
      var title = "";
      if (hol) {
        title = ' title="' + escapeHtml(hol.name + (hol.off ? "（法定假日·休息）" : "（调休·上班）")) + '"';
      }
      var holHtml = "";
      if (hol) {
        holHtml = '<span class="cw-htag ' + (hol.off ? "cw-htag-off" : "cw-htag-work") + '">' +
          (hol.off ? "休" : "班") + "</span>";
      }
      cells.push('<div class="' + cls + '" data-key="' + key + '"' + title + '>' +
        '<span class="cw-day">' + d.getDate() + "</span>" +
        '<span class="cw-lunar">' + escapeHtml(lunText) + "</span>" +
        holHtml + "</div>");
    }
    this.gridEl.innerHTML = cells.join("");

    Array.prototype.forEach.call(this.gridEl.querySelectorAll(".cw-cell"), function (el) {
      el.addEventListener("click", function () {
        self.selectedKey = el.getAttribute("data-key");
        self._render();
        self._renderMemo();
      });
    });

    this._renderMemo();
  };

  CWidget.prototype._renderMemo = function () {
    var key = this.selectedKey;
    var parts = key.split("-");
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    var y = Number(parts[0]), m = Number(parts[1]), day = Number(parts[2]);
    var lunStr = "";
    if (this.showLunar && window.Lunar) {
      var lun = Lunar.solarToLunar(y, m, day);
      lunStr = Lunar.fullLabel(lun);
    }
    var holStr = "";
    if (this.showHoliday && window.HolidayCN) {
      var hol = HolidayCN.get(y, m, day);
      if (hol) holStr = hol.name + (hol.off ? "（休）" : "（班）");
    }
    this.memoDateEl.innerHTML = "<b>" + key + "</b> · " + cnWeekday(d) +
      " · 第 " + isoWeek(d) + " 周" +
      (holStr ? " · " + holStr : "") + (lunStr ? " · " + lunStr : "");
    this.memoInput.value = (this.notes && this.notes[key]) ? this.notes[key] : "";
    this.memoMsg.textContent = "";
    this.memoMsg.className = "cw-memo-msg";
  };

  // ===================== 实时时钟 =====================
  CWidget.prototype._startClock = function () {
    var self = this;
    function tick() {
      var n = new Date();
      self.timeEl.textContent = pad2(n.getHours()) + ":" + pad2(n.getMinutes()) +
        ":" + pad2(n.getSeconds());
      var isToday = isoDate(n) === self.selectedKey;
      var lunStr = "";
      if (self.showLunar && window.Lunar) {
        var lun = Lunar.solarToLunar(n.getFullYear(), n.getMonth() + 1, n.getDate());
        lunStr = Lunar.fullLabel(lun);
      }
      var holStr = "";
      if (self.showHoliday && window.HolidayCN) {
        var hol = HolidayCN.get(n.getFullYear(), n.getMonth() + 1, n.getDate());
        if (hol) holStr = hol.name + (hol.off ? "（休）" : "（班）");
      }
      self.dateEl.innerHTML = n.getFullYear() + "年" + (n.getMonth() + 1) + "月" +
        n.getDate() + "日 · " + cnWeekday(n) +
        (holStr ? " · " + holStr : "") +
        (lunStr ? " · " + lunStr : "") +
        (isToday ? ' · <span class="cw-today-tag">今天</span>' : "");
    }
    tick();
    this._clockTimer = setInterval(tick, 1000);
  };

  // ===================== 持久化 =====================
  CWidget.prototype._saveNote = function (key, text) {
    var self = this;
    if (!this.notes) this.notes = {};
    text = (text || "").trim();
    if (text) this.notes[key] = text; else delete this.notes[key];

    if (this.settingsApi) {
      fetch(this.settingsApi, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: this.notes })
      })
        .then(function () { self._noteSaved(); })
        .catch(function () { self._noteSaved("保存失败（网络）"); });
    } else {
      try { localStorage.setItem("cw_notes", JSON.stringify(this.notes)); } catch (e) {}
      self._noteSaved();
    }
    // 若当前正在看有/无备忘的那天，刷新角标
    if (key === this.selectedKey) this._render();
  };

  CWidget.prototype._noteSaved = function (err) {
    this.memoMsg.textContent = err ? err : "✅ 已保存";
    this.memoMsg.className = "cw-memo-msg" + (err ? "" : " cw-ok");
    var self = this;
    clearTimeout(this._noteTimer);
    this._noteTimer = setTimeout(function () { self.memoMsg.textContent = ""; }, 2000);
  };

  // 公共 API：挂到 RLShell 模板上，mount 透传 opts，build 渲染内容
  var Widget = RLShell.create({
    id: "cw", title: "日历", icon: "📅", minW: 260, minH: 320, defW: 320, defH: null,
    build: function (body, ctx) {
      var inst = new CWidget(ctx.opts);
      inst.build(ctx.root, body);
      return {
        onDestroy: function () {
          if (inst._clockTimer) clearInterval(inst._clockTimer);
        }
      };
    }
  });
  global.CalendarWidget = Widget;

  // 自动挂载：若 URL 带 ?demo=1 或脚本直接引入，默认挂一个（无服务端时用 localStorage）
  // 桌面注入场景由 inject.js 手动挂载（已置 __cw_noauto），避免重复实例。
  if (typeof document !== "undefined" && !window.__cw_mounted && !window.__cw_noauto) {
    window.__cw_mounted = true;
    var params = new URLSearchParams(location.search);
    if (params.get("demo") !== "0") {
      var initialNotes = {};
      try { var ln = localStorage.getItem("cw_notes"); if (ln) initialNotes = JSON.parse(ln) || {}; } catch (e) {}
      document.addEventListener("DOMContentLoaded", function () {
        Widget.mount({ settingsApi: null, notes: initialNotes,
                       pos: null, size: null, min: false, pinned: false });
      });
    }
  }
})(window);
