/* 日历悬浮窗组件（纯原生 JS，零依赖）
 * 用法：
 *   CalendarWidget.mount({ settingsApi: "/calw/api/settings", notes: {} });  // 编程式
 *   或直接引入本脚本，默认挂载到 document.body。
 * 功能：月历（翻月/翻年、今天高亮、点选日期）+ 实时时钟 + 每日备忘（持久化）。
 *       可拖拽、可缩放（双击把手恢复默认）、可最小化、可关闭（关闭后由服务端记住，
 *       刷新桌面不再自动弹出，可在设置窗口重新开启）。
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

  // 卡片最小可调整尺寸（同时受视口约束，不允许拖出屏幕）
  var MIN_W = 260, MIN_H = 320;
  function clampSize(w, h, left, top) {
    var vw = window.innerWidth || 1024, vh = window.innerHeight || 768;
    var maxW = Math.max(MIN_W, vw - (left || 0) - 8);
    var maxH = Math.max(MIN_H, vh - (top || 0) - 8);
    return [Math.min(Math.max(MIN_W, Number(w) || MIN_W), maxW),
            Math.min(Math.max(MIN_H, Number(h) || MIN_H), maxH)];
  }

  // 按方向（n/s/e/w 任意组合，如 "se" / "n" / "e"）计算缩放后的盒模型，
  // 仅移动鼠标一侧边缘、对侧边缘固定，并钳制进视口、满足最小尺寸。
  function computeResize(dir, dx, dy, r0, minW, minH) {
    var vw = window.innerWidth || 1024, vh = window.innerHeight || 768;
    var left = r0.left, top = r0.top, w = r0.width, h = r0.height;
    var right = r0.left + r0.width, bottom = r0.top + r0.height;
    if (dir.indexOf("e") >= 0) {
      w = Math.max(minW, Math.min(r0.width + dx, Math.max(minW, vw - 8 - left)));
    }
    if (dir.indexOf("w") >= 0) {
      left = Math.max(0, Math.min(r0.left + dx, right - minW));
      w = right - left;
    }
    if (dir.indexOf("s") >= 0) {
      h = Math.max(minH, Math.min(r0.height + dy, Math.max(minH, vh - 8 - top)));
    }
    if (dir.indexOf("n") >= 0) {
      top = Math.max(0, Math.min(r0.top + dy, bottom - minH));
      h = bottom - top;
    }
    return { left: left, top: top, width: w, height: h };
  }

  function CalendarWidget(opts) {
    opts = opts || {};
    this.opts = opts;
    this.settingsApi = opts.settingsApi || null;
    this.pos = opts.pos || null;
    this.size = opts.size || null;
    this.min = opts.min || false;
    this.notes = (opts.notes && typeof opts.notes === "object") ? opts.notes : {};
    this.pinned = !!opts.pinned;   // 固定（锁定位置，禁止拖动/缩放）
    this.viewYear = 0;
    this.viewMonth = 0;     // 0-11
    this.selectedKey = null;
    this.el = null;
    this._build();
  }

  CalendarWidget.prototype._build = function () {
    var self = this;
    var now = new Date();
    this.viewYear = now.getFullYear();
    this.viewMonth = now.getMonth();
    this.selectedKey = isoDate(now);

    var root = document.createElement("div");
    root.id = "cw-root";
    root.innerHTML =
      '<div class="cw-header">' +
        '<span class="cw-title">📅 日历</span>' +
        '<span class="cw-spacer"></span>' +
        '<button class="cw-btn cw-pin-btn" title="固定位置（锁定，禁止拖动/缩放）">📌</button>' +
        '<button class="cw-btn cw-min-btn" title="最小化">—</button>' +
        '<button class="cw-btn cw-close-btn" title="关闭（可在设置窗口重新开启）">×</button>' +
      '</div>' +
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
      '</div>' +
      '<span class="cw-resize" title="拖动调整大小（双击恢复默认）"></span>';
    var host = (this.opts && this.opts.container) || document.body;
    host.appendChild(root);
    this.el = root;
    if (this.opts && this.opts.embed) root.classList.add("cw-embed");

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
    this.weekdaysEl.innerHTML = WEEK_LABELS.map(function (w, i) {
      return '<span class="' + (i >= 5 ? "cw-we" : "") + '">' + w + "</span>";
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
    this.minBtn = root.querySelector(".cw-min-btn");
    this.pinBtn = root.querySelector(".cw-pin-btn");
    this.pinBtn.addEventListener("click", function () {
      self.pinned = !self.pinned;
      self._syncPin();
      self._savePin(self.pinned);
    });
    root.querySelector(".cw-close-btn").addEventListener("click", function () {
      root.remove();
      if (self.settingsApi) {
        fetch(self.settingsApi, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ visible: false })
        }).catch(function () {});
      }
    });
    this.minBtn.addEventListener("click", function () {
      if (root.classList.contains("cw-min")) self._doRestore();
      else self._doMin();
    });

    // 备忘保存
    var saveBtn = root.querySelector(".cw-memo-save");
    function doSave() {
      self._saveNote(self.selectedKey, self.memoInput.value);
    }
    saveBtn.addEventListener("click", doSave);
    // 失焦自动保存
    this.memoInput.addEventListener("blur", doSave);
    // Ctrl/Cmd + Enter 保存
    this.memoInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        doSave();
      }
      e.stopPropagation();
    });

    // 两个拖拽把手：顶栏 + 时钟区。只有顶栏一个把手时，浮层若被右上角原生
    // 系统小组件（CPU/内存状态）盖住顶栏，整个浮层就再也拖不动了。
    if ((!this.opts || !this.opts.embed) && this.opts.draggable !== false) {
      this._makeDraggable(root.querySelector(".cw-header"), root);
      this._makeDraggable(root.querySelector(".cw-clock"), root);
      this._makeResizable(root);
    } else if (this.opts && this.opts.draggable === false && root.querySelector(".cw-resize")) {
      root.querySelector(".cw-resize").style.display = "none";
    }

    if (this.size) this._applySize(this.size.width, this.size.height);
    if (this.pos) this._applyPos(this.pos.left, this.pos.top);
    if (this.min) this.el.classList.add("cw-min");
    this._syncPin();   // 应用初始固定状态（含隐藏缩放把手）

    this._render();
    this._startClock();
  };

  // 固定（锁定位置）：启用时禁止拖动/缩放，隐藏缩放把手，并给出视觉提示
  CalendarWidget.prototype._syncPin = function () {
    if (!this.el) return;
    this.el.classList.toggle("cw-pinned", this.pinned);
    if (this.pinBtn) {
      this.pinBtn.classList.toggle("cw-active", this.pinned);
      this.pinBtn.title = this.pinned
        ? "已固定（点击解锁，恢复拖动/缩放）"
        : "固定位置（锁定，禁止拖动/缩放）";
    }
    var rs = this.el.querySelector(".cw-resize");
    if (rs) rs.style.display = this.pinned ? "none" : "";
  };

  CalendarWidget.prototype._savePin = function (v) {
    this.pinned = !!v;
    if (this.settingsApi) {
      fetch(this.settingsApi, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: this.pinned })
      }).catch(function () {});
    } else {
      try { localStorage.setItem("cw_pin", this.pinned ? "1" : "0"); } catch (e) {}
    }
  };

  // ===================== 渲染月历 =====================
  CalendarWidget.prototype._stepMonth = function (delta) {
    var m = this.viewMonth + delta;
    var y = this.viewYear + Math.floor(m / 12);
    m = ((m % 12) + 12) % 12;
    this.viewYear = y;
    this.viewMonth = m;
    this._render();
  };

  CalendarWidget.prototype._render = function () {
    var self = this;
    this.titleEl.textContent = this.viewYear + "年 " + MONTH_LABELS[this.viewMonth];

    var first = new Date(this.viewYear, this.viewMonth, 1);
    var startDow = mondayIndex(first.getDay());      // 本月1号在一周中的偏移
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
      if (window.Lunar) {
        var lun = Lunar.solarToLunar(d.getFullYear(), sm, sd);
        lunText = Lunar.cellText(lun, sm, sd);
      }
      var hol = (window.HolidayCN) ? HolidayCN.get(d.getFullYear(), sm, sd) : null;
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

  CalendarWidget.prototype._renderMemo = function () {
    var key = this.selectedKey;
    var parts = key.split("-");
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    var y = Number(parts[0]), m = Number(parts[1]), day = Number(parts[2]);
    var lunStr = "";
    if (window.Lunar) {
      var lun = Lunar.solarToLunar(y, m, day);
      lunStr = Lunar.fullLabel(lun);
    }
    var holStr = "";
    if (window.HolidayCN) {
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
  CalendarWidget.prototype._startClock = function () {
    var self = this;
    function tick() {
      var n = new Date();
      self.timeEl.textContent = pad2(n.getHours()) + ":" + pad2(n.getMinutes()) +
        ":" + pad2(n.getSeconds());
      var isToday = isoDate(n) === self.selectedKey;
      var lunStr = "";
      if (window.Lunar) {
        var lun = Lunar.solarToLunar(n.getFullYear(), n.getMonth() + 1, n.getDate());
        lunStr = Lunar.fullLabel(lun);
      }
      var holStr = "";
      if (window.HolidayCN) {
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
  CalendarWidget.prototype._saveNote = function (key, text) {
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

  CalendarWidget.prototype._noteSaved = function (err) {
    this.memoMsg.textContent = err ? err : "✅ 已保存";
    this.memoMsg.className = "cw-memo-msg" + (err ? "" : " cw-ok");
    var self = this;
    clearTimeout(this._noteTimer);
    this._noteTimer = setTimeout(function () { self.memoMsg.textContent = ""; }, 2000);
  };

  CalendarWidget.prototype._makeDraggable = function (handle, panel) {
    var self = this;
    handle.style.touchAction = "none";
    handle.addEventListener("pointerdown", function (e) {
      if (self.pinned) return;
      if (e.target.closest(".cw-btn")) return;
      e.stopPropagation();
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
      var sx = e.clientX, sy = e.clientY;
      var r = panel.getBoundingClientRect();
      var ox = r.left, oy = r.top;
      panel.style.right = "auto";
      function move(ev) {
        panel.style.left = (ox + ev.clientX - sx) + "px";
        panel.style.top = (oy + ev.clientY - sy) + "px";
      }
      function up() {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        // 松手吸附到桌面图标网格（与图标行列对齐，视觉整齐）
        var r = panel.getBoundingClientRect();
        if (window.__rl93_snapToGrid) {
          var sn = window.__rl93_snapToGrid(r.left, r.top);
          panel.style.left = sn.left + "px";
          panel.style.top = sn.top + "px";
        }
        self._saveBox(panel);
      }
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
      e.preventDefault();
    });
  };

  // 四边（含四角）缩放：在面板任意边缘 / 角落按下即沿该边调整大小，双击边缘恢复默认。
  // 捕获阶段的 pointerdown 监听面板：命中边缘时先拦截，避免与 header / clock 拖动冲突。
  CalendarWidget.prototype._makeResizable = function (panel) {
    var self = this;
    if (!panel) return;
    var EDGE = 6;
    function edgeAt(e) {
      var r = panel.getBoundingClientRect();
      var x = e.clientX - r.left, y = e.clientY - r.top;
      var n = y <= EDGE, s = y >= r.height - EDGE;
      var w = x <= EDGE, eR = x >= r.width - EDGE;
      if (!n && !s && !w && !eR) return null;
      return (n ? "n" : "") + (s ? "s" : "") + (w ? "w" : "") + (eR ? "e" : "");
    }
    panel.style.touchAction = "none";
    panel.addEventListener("pointerdown", function (e) {
      if (self.pinned) return;
      if (e.target.closest(".cw-btn")) return;
      var dir = edgeAt(e);
      if (!dir) return;                 // 内部：交给正常交互 / 拖动
      e.preventDefault();
      e.stopPropagation();
      try { panel.setPointerCapture(e.pointerId); } catch (err) {}
      var sx = e.clientX, sy = e.clientY;
      var r0 = panel.getBoundingClientRect();
      function move(ev) {
        var b = computeResize(dir, ev.clientX - sx, ev.clientY - sy, r0, MIN_W, MIN_H);
        panel.style.right = "auto";
        panel.style.left = b.left + "px";
        panel.style.top = b.top + "px";
        panel.style.width = b.width + "px";
        panel.style.height = b.height + "px";
      }
      function up() {
        panel.removeEventListener("pointermove", move);
        panel.removeEventListener("pointerup", up);
        panel.removeEventListener("pointercancel", up);
        self._saveBox(panel);
      }
      panel.addEventListener("pointermove", move);
      panel.addEventListener("pointerup", up);
      panel.addEventListener("pointercancel", up);
    }, true);
    // 双击边缘 → 恢复默认大小
    panel.addEventListener("dblclick", function (e) {
      if (self.pinned) return;
      if (e.target.closest(".cw-btn, input, textarea")) return;
      if (!edgeAt(e)) return;
      panel.style.width = "";
      panel.style.height = "";
      self._saveBox(panel, true);
    });
    // 边缘悬停光标提示（让"四边可缩放"可见）
    panel.addEventListener("mousemove", function (e) {
      if (self.pinned) { panel.style.cursor = ""; return; }
      var dir = edgeAt(e);
      var map = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
        ne: "nesw-resize", nw: "nwse-resize", se: "nwse-resize", sw: "nesw-resize" };
      panel.style.cursor = dir ? map[dir] : "";
    });
  };

  CalendarWidget.prototype._saveMin = function (v) {
    this.min = !!v;
    if (this.settingsApi) {
      fetch(this.settingsApi, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ min: this.min })
      }).catch(function () {});
    } else {
      try { localStorage.setItem("cw_min", this.min ? "1" : "0"); } catch (e) {}
    }
  };

  CalendarWidget.prototype._doMin = function () {
    if (!this.el) return;
    this.el.classList.add("cw-min");
    this._saveMin(true);
  };

  CalendarWidget.prototype._doRestore = function () {
    if (!this.el) return;
    this.el.classList.remove("cw-min");
    // 如果之前保存过尺寸，重新应用以恢复高度
    if (this.size) this._applySize(this.size.width, this.size.height);
    this._saveMin(false);
  };

  CalendarWidget.prototype._saveBox = function (panel, resetSize) {
    if (!panel) return;
    var r = panel.getBoundingClientRect();
    var payload = { pos: { left: Math.round(r.left), top: Math.round(r.top) } };
    payload.size = resetSize ? null
      : { width: Math.round(r.width), height: Math.round(r.height) };
    if (!resetSize) this.size = payload.size;
    if (this.settingsApi) {
      fetch(this.settingsApi, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).catch(function () {});
    } else {
      try { localStorage.setItem("cw_box", JSON.stringify(payload)); } catch (e) {}
    }
  };

  CalendarWidget.prototype._applySize = function (width, height) {
    if (!this.el || width == null || height == null) return;
    var r = this.el.getBoundingClientRect();
    var box = clampSize(width, height, r.left, r.top);
    this.el.style.width = box[0] + "px";
    this.el.style.height = box[1] + "px";
  };

  CalendarWidget.prototype._applyPos = function (left, top) {
    if (left == null || top == null || !this.el) return;
    var w = this.el.offsetWidth || 320;
    var h = this.el.offsetHeight || 360;
    var maxL = Math.max(0, (window.innerWidth || 1024) - w);
    var maxT = Math.max(0, (window.innerHeight || 768) - h);
    var L = Math.min(Math.max(0, Number(left) || 0), maxL);
    var T = Math.min(Math.max(0, Number(top) || 0), maxT);
    this.el.style.right = "auto";
    this.el.style.left = L + "px";
    this.el.style.top = T + "px";
  };

  // 公共 API
  CalendarWidget.mount = function (opts) {
    return new CalendarWidget(opts);
  };
  // 从挂载容器中移除（用于管理页预览刷新，清理时钟定时器 + 避免重复实例）
  CalendarWidget.prototype.destroy = function () {
    if (this._clockTimer) clearInterval(this._clockTimer);
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    this.el = null;
  };
  global.CalendarWidget = CalendarWidget;

  // 自动挂载：若 URL 带 ?demo=1 或脚本直接引入，默认挂一个（无服务端时用 localStorage）
  if (typeof document !== "undefined" && !window.__cw_mounted) {
    window.__cw_mounted = true;
    var params = new URLSearchParams(location.search);
    var auto = params.get("demo");
    var settingsApi = null;
    if (location.pathname.indexOf("/calw/") === 0) {
      settingsApi = "/calw/api/settings";
    }
    var initialNotes = {};
    try {
      var ln = localStorage.getItem("cw_notes");
      if (ln) initialNotes = JSON.parse(ln) || {};
    } catch (e) {}
    var box = null;
    try {
      var lb = localStorage.getItem("cw_box");
      if (lb) box = JSON.parse(lb);
    } catch (e) {}
    // 桌面注入场景由 inject.js 手动挂载（已置 __cw_noauto），避免重复实例；
    // 普通静态页访问（如演示页）才走自动挂载。
    var initialMin = false;
    try {
      var lm = localStorage.getItem("cw_min");
      if (lm) initialMin = lm === "1";
    } catch (e) {}
    var initialPin = false;
    try {
      var lp = localStorage.getItem("cw_pin");
      if (lp) initialPin = lp === "1";
    } catch (e) {}
    if (auto !== "0" && !window.__cw_noauto) {
      document.addEventListener("DOMContentLoaded", function () {
        CalendarWidget.mount({
          settingsApi: settingsApi,
          notes: initialNotes,
          pos: box ? box.pos : null,
          size: box ? box.size : null,
          min: initialMin,
          pinned: initialPin
        });
      });
    }
  }
})(window);
