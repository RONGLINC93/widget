/* 通用浮层外壳（新增小组件专用）
 * ============================================================================
 * 为新增的桌面浮层组件（世界时钟 / 便签 / 待办 / 系统监控）提供统一的
 * 拖拽 / 四边缩放 / 最小化 / 关闭 / 固定 能力，并复用桌面图标网格吸附
 * （window.__rl93_snapToGrid，由 inject.js 注入），让各组件只专注自身内容渲染。
 *
 * 现有的 dir / calendar / weather 三个组件为自包含实现，不依赖本文件；
 * 新组件统一走本外壳，外观与交互保持一致。
 *
 * 用法（以世界时钟为例）：
 *   var W = RLShell.create({
 *     id: "wc", title: "世界时钟", icon: "🕐",
 *     minW: 200, minH: 120, defW: 240, defH: null,
 *     build: function (body, ctx) {
 *       // 渲染内容到 body，按需用 ctx.saveMin()/ctx.saveVisible() 等
 *       return { onMin: fn, onRestore: fn, onClose: fn, refresh: fn };
 *     }
 *   });
 *   window.WorldClockWidget = W;   // 暴露 mount/unmount
 */
(function () {
  "use strict";

  // 真实桌面场景下，多个新组件若都没有记住位置，需要一个错开的默认坐标，
  // 否则 position:fixed 无 offset 会全部塌到 (0,0) 互相重叠，看起来"显示不出来"。
  // 每挂载一个就偏移一格，形成对角线铺开；已记住位置（OPTS.pos）时用记住值。
  var __cascade = 0;

  function computeResize(dir, dx, dy, r0, minW, minH) {
    var vw = window.innerWidth || 1024, vh = window.innerHeight || 768;
    var left = r0.left, top = r0.top, w = r0.width, h = r0.height;
    var right = r0.left + r0.width, bottom = r0.top + r0.height;
    if (dir.indexOf("e") >= 0) w = Math.max(minW, Math.min(r0.width + dx, Math.max(minW, vw - 8 - left)));
    if (dir.indexOf("w") >= 0) { left = Math.max(0, Math.min(r0.left + dx, right - minW)); w = right - left; }
    if (dir.indexOf("s") >= 0) h = Math.max(minH, Math.min(r0.height + dy, Math.max(minH, vh - 8 - top)));
    if (dir.indexOf("n") >= 0) { top = Math.max(0, Math.min(r0.top + dy, bottom - minH)); h = bottom - top; }
    return { left: left, top: top, width: w, height: h };
  }

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function create(opts) {
    var ID = opts.id, TITLE = opts.title, ICON = opts.icon || "🧩";
    var MINW = opts.minW || 200, MINH = opts.minH || 120;
    var DEFW = ("defW" in opts) ? opts.defW : 240;
    var DEFH = ("defH" in opts) ? opts.defH : null;

    var ROOT = null, BODY = null, HOOKS = null;
    var OPTS = null, API = null, MIN = false, PINNED = false;

    function send(b) {
      if (!API) return;
      fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(b)
      }).catch(function () {});
    }

    function saveBox(pos, size) {
      if (pos) OPTS.pos = pos;
      if (size) OPTS.size = size;
      if (!API) return;
      var b = {};
      if (pos) b.pos = pos;
      if (size) b.size = size;
      send(b);
    }
    function saveMin(v) { MIN = !!v; if (API) send({ min: MIN }); }
    function savePin(v) { PINNED = !!v; if (API) send({ pinned: PINNED }); }
    function saveVisible(v) { if (API) send({ visible: !!v }); }

    function applyBox() {
      if (!ROOT) return;
      var w = OPTS.size && OPTS.size.width ? OPTS.size.width : DEFW;
      var p = OPTS.pos && (OPTS.pos.left || OPTS.pos.top);
      var hasPos = OPTS.pos && (typeof OPTS.pos.left === "number" || typeof OPTS.pos.top === "number");
      if (hasPos) {
        if (typeof OPTS.pos.left === "number") ROOT.style.left = OPTS.pos.left + "px";
        if (typeof OPTS.pos.top === "number") ROOT.style.top = OPTS.pos.top + "px";
      } else if (!OPTS.preview) {
        // 真实桌面、且未记住位置：用错开默认值，避免多个新组件全塌在 (0,0) 互相重叠、
        // 看起来"显示不出来"。按 2 列网格铺开，每个组件都有独立且互不遮挡的默认位。
        var n = __cascade++;
        var col = n % 2, row = Math.floor(n / 2);
        ROOT.style.left = (24 + col * 300) + "px";
        ROOT.style.top = (24 + row * 300) + "px";
      }
      if (MIN) {
        ROOT.classList.add("rl-min");
        // 隐藏普通标题栏、显示最小化标题栏，否则点「—」只会一直最小化、无法恢复
        var mbar = el(ID + "-minbar"); if (mbar) mbar.style.display = "";
        var bar = el(ID + "-bar"); if (bar) bar.style.display = "none";
        ROOT.style.width = (OPTS.size && OPTS.size.width ? OPTS.size.width : DEFW) + "px";
        ROOT.style.height = "auto";
        return;
      }
      ROOT.classList.remove("rl-min");
      var mbar2 = el(ID + "-minbar"); if (mbar2) mbar2.style.display = "none";
      var bar2 = el(ID + "-bar"); if (bar2) bar2.style.display = "";
      if (w) ROOT.style.width = w + "px";
      var h = OPTS.size && OPTS.size.height ? OPTS.size.height : DEFH;
      ROOT.style.height = h ? h + "px" : "auto";
    }

    // ---- 视口钳制：保证浮层永远完整落在屏幕内 ----
    // 场景1：pos/size 是在另一台更大分辨率的设备上保存的，回到小屏就连组件
    //         一起超出屏幕（用户看不见也点不中，必须在这里拉回来）。
    // 场景2：高度为 auto 时内容变高，CSS 的 max-height:90vh 加上 top 偏移，
    //         底部会越过视口下沿——这里按当前 top 动态收紧 maxHeight。
    var onWinResize = function () { enforceViewport(); };
    function enforceViewport() {
      if (!ROOT) return;
      if (OPTS && (OPTS.preview || OPTS.embed)) return;   // 预览/嵌入容器，不按视口钳制
      var vw = window.innerWidth || 1024, vh = window.innerHeight || 768, M = 8;
      var rect = ROOT.getBoundingClientRect();
      var left = parseFloat(ROOT.style.left); if (isNaN(left)) left = rect.left;
      var top = parseFloat(ROOT.style.top); if (isNaN(top)) top = rect.top;
      // 宽度不超出视口
      var maxW = Math.max(MINW, vw - 2 * M);
      if (rect.width > maxW) ROOT.style.width = maxW + "px";
      // 高度不越过视口底部（auto 高度 + 高内容时的关键）
      ROOT.style.maxHeight = Math.max(MINH, vh - top - M) + "px";
      // 位置钳制：整个浮层回到视口内
      var r2 = ROOT.getBoundingClientRect();
      var nx = Math.max(M, Math.min(left, vw - r2.width - M));
      var ny = Math.max(M, Math.min(top, vh - r2.height - M));
      if (nx !== left) ROOT.style.left = Math.round(nx) + "px";
      if (ny !== top) {
        ROOT.style.top = Math.round(ny) + "px";
        ROOT.style.maxHeight = Math.max(MINH, vh - ny - M) + "px";
      }
    }

    function syncPin() {
      if (!ROOT) return;
      ROOT.classList.toggle("rl-pinned", PINNED);
      var btn = el(ID + "-pin");
      if (btn) {
        btn.classList.toggle("rl-active", PINNED);
        btn.title = PINNED ? "已固定（点击解锁）" : "固定位置（锁定，禁止拖动/缩放）";
      }
      var rs = el(ID + "-rsz");
      if (rs) rs.style.display = PINNED ? "none" : "";
    }

    function enableDrag() {
      var bar = el(ID + "-bar"), minbar = el(ID + "-minbar");
      if (bar) bar.style.touchAction = "none";
      if (minbar) minbar.style.touchAction = "none";
      function bind(handle) {
        if (!handle) return;
        handle.addEventListener("pointerdown", function (e) {
          if (PINNED) return;
          if (e.target.tagName === "BUTTON") return;
          e.stopPropagation();
          try { handle.setPointerCapture(e.pointerId); } catch (err) {}
          var sx = e.clientX, sy = e.clientY;
          var r = ROOT.getBoundingClientRect();
          var ox = r.left, oy = r.top;
          function move(ev) {
            ROOT.style.left = Math.max(0, ox + ev.clientX - sx) + "px";
            ROOT.style.top = Math.max(0, oy + ev.clientY - sy) + "px";
          }
          function up() {
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", up);
            handle.removeEventListener("pointercancel", up);
            var rr = ROOT.getBoundingClientRect();
            if (window.__rl93_snapToGrid) {
              var sn = window.__rl93_snapToGrid(rr.left, rr.top);
              ROOT.style.left = sn.left + "px";
              ROOT.style.top = sn.top + "px";
              rr = ROOT.getBoundingClientRect();
            }
            // 松手后再钳回视口，避免把浮层拖到屏幕外还被保存下来
            enforceViewport();
            rr = ROOT.getBoundingClientRect();
            saveBox({ left: Math.round(rr.left), top: Math.round(rr.top) }, OPTS.size);
          }
          handle.addEventListener("pointermove", move);
          handle.addEventListener("pointerup", up);
          handle.addEventListener("pointercancel", up);
          e.preventDefault();
        });
      }
      bind(bar); bind(minbar);
    }

    function enableResize() {
      if (!ROOT) return;
      var EDGE = 6;
      function edgeAt(e) {
        var r = ROOT.getBoundingClientRect();
        var x = e.clientX - r.left, y = e.clientY - r.top;
        var n = y <= EDGE, s = y >= r.height - EDGE, w = x <= EDGE, eR = x >= r.width - EDGE;
        if (!n && !s && !w && !eR) return null;
        return (n ? "n" : "") + (s ? "s" : "") + (w ? "w" : "") + (eR ? "e" : "");
      }
      ROOT.style.touchAction = "none";
      ROOT.addEventListener("pointerdown", function (e) {
        if (PINNED) return;
        if (e.target.tagName === "BUTTON") return;
        // 标题栏/最小化栏上的按下应交给拖拽逻辑，不要让边缘缩放抢先（否则顶部 6px 会变成向北缩放）
        if (e.target.closest && e.target.closest(".rl-bar, .rl-minbar")) return;
        var dir = edgeAt(e);
        if (!dir) return;
        e.preventDefault(); e.stopPropagation();
        try { ROOT.setPointerCapture(e.pointerId); } catch (err) {}
        var sx = e.clientX, sy = e.clientY, r0 = ROOT.getBoundingClientRect();
        function move(ev) {
          var b = computeResize(dir, ev.clientX - sx, ev.clientY - sy, r0, MINW, MINH);
          ROOT.style.left = b.left + "px"; ROOT.style.top = b.top + "px";
          ROOT.style.width = b.width + "px"; ROOT.style.height = b.height + "px";
        }
        function up() {
          ROOT.removeEventListener("pointermove", move);
          ROOT.removeEventListener("pointerup", up);
          ROOT.removeEventListener("pointercancel", up);
          // 缩放后再钳回视口，避免保存出屏幕外的尺寸/位置
          enforceViewport();
          var rr = ROOT.getBoundingClientRect();
          saveBox({ left: Math.round(rr.left), top: Math.round(rr.top) },
                  { width: Math.round(rr.width), height: Math.round(rr.height) });
        }
        ROOT.addEventListener("pointermove", move);
        ROOT.addEventListener("pointerup", up);
        ROOT.addEventListener("pointercancel", up);
      }, true);
      ROOT.addEventListener("dblclick", function (e) {
        if (PINNED) return;
        if (e.target.tagName === "BUTTON") return;
        if (!edgeAt(e)) return;
        ROOT.style.width = ""; ROOT.style.height = "";
        OPTS.size = null; send({ size: null });
        enforceViewport();   // 恢复默认后按内容重新钳制视口
      });
      ROOT.addEventListener("mousemove", function (e) {
        if (PINNED) { ROOT.style.cursor = ""; return; }
        if (e.target.closest && e.target.closest(".rl-bar, .rl-minbar")) { ROOT.style.cursor = ""; return; }
        var dir = edgeAt(e);
        var map = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
          ne: "nesw-resize", nw: "nwse-resize", se: "nwse-resize", sw: "nesw-resize" };
        ROOT.style.cursor = dir ? map[dir] : "";
      });
    }

    function bindDefault() {
      function doMin() { saveMin(true); applyBox(); if (HOOKS && HOOKS.onMin) HOOKS.onMin(); }
      function doRestore() { saveMin(false); applyBox(); if (HOOKS && HOOKS.onRestore) HOOKS.onRestore(); }
      function close() {
        if (HOOKS && HOOKS.onClose) HOOKS.onClose();
        if (ROOT && ROOT.parentNode) ROOT.parentNode.removeChild(ROOT);
        saveVisible(false);
        window.removeEventListener("resize", onWinResize);
        ROOT = null;
      }
      var minBtn = el(ID + "-min"); if (minBtn) minBtn.onclick = function () { if (MIN) doRestore(); else doMin(); };
      var minBar = el(ID + "-minbar");
      if (minBar) minBar.onclick = function (e) { if (e.target.tagName === "BUTTON") return; doRestore(); };
      var grip2 = el(ID + "-grip2"); if (grip2) grip2.onclick = doRestore;
      var x1 = el(ID + "-x"); if (x1) x1.onclick = close;
      var x2 = el(ID + "-x2"); if (x2) x2.onclick = close;
      var pin = el(ID + "-pin");
      if (pin) pin.onclick = function () { PINNED = !PINNED; syncPin(); savePin(PINNED); };
    }

    function mount(mountOpts) {
      OPTS = mountOpts || {};
      API = OPTS.settingsApi || null;
      if (el(ID + "-root")) return;   // 已挂载，避免重复
      ROOT = document.createElement("div");
      ROOT.id = ID + "-root";
      ROOT.className = "rl-root";
      var preview = !!OPTS.preview;
      var btns = preview ? "" :
        '<button class="rl-pin" id="' + ID + '-pin" title="固定位置（锁定，禁止拖动/缩放）">📌</button>' +
        '<button class="rl-min" id="' + ID + '-min" title="最小化">—</button>' +
        '<button class="rl-x" id="' + ID + '-x" title="关闭">×</button>';
      ROOT.innerHTML =
        '<div class="rl-bar" id="' + ID + '-bar">' +
          '<span class="rl-grip">' + ICON + '</span>' +
          '<span class="rl-title" id="' + ID + '-title">' + esc(TITLE) + '</span>' +
          '<span class="rl-spacer"></span>' + btns +
        '</div>' +
        '<div class="rl-minbar" id="' + ID + '-minbar" style="display:none">' +
          '<span class="rl-grip" id="' + ID + '-grip2">' + ICON + '</span>' +
          '<span class="rl-title" id="' + ID + '-mintitle">' + esc(TITLE) + '</span>' +
          '<span class="rl-spacer"></span>' +
          (preview ? "" : '<button class="rl-x" id="' + ID + '-x2" title="关闭">×</button>') +
        '</div>' +
        '<div class="rl-body" id="' + ID + '-body"></div>' +
        (preview ? "" : '<div class="rl-rsz" id="' + ID + '-rsz" title="拖拽缩放"></div>');
      // 注意：此刻 ROOT 尚未插入文档，getElementById 找不到子节点（返回 null），
      // 必须在 ROOT 自身范围内查询；否则 build(body=null) 抛错 → 四个组件内容区全空。
      BODY = ROOT.querySelector(".rl-body");
      var host = OPTS.container || document.body || document.documentElement;
      host.appendChild(ROOT);
      MIN = ("min" in OPTS) ? !!OPTS.min : false;
      PINNED = ("pinned" in OPTS) ? !!OPTS.pinned : false;
      applyBox();
      syncPin();
      if (!preview && !OPTS.embed) { enableDrag(); enableResize(); }
      bindDefault();
      if (typeof opts.build === "function") {
        HOOKS = opts.build(BODY, {
          root: ROOT, body: BODY, opts: OPTS,
          saveMin: saveMin, savePin: savePin, saveVisible: saveVisible,
          saveBox: saveBox, applyBox: applyBox, esc: esc
        }) || {};
      }
      // 内容渲染完再钳一次视口（build 可能把 auto 高度的浮层撑高），并跟随窗口缩放
      enforceViewport();
      window.addEventListener("resize", onWinResize);
      return {
        root: function () { return ROOT; },
        refresh: function () { if (HOOKS && HOOKS.refresh) HOOKS.refresh(); },
        destroy: function () {
          window.removeEventListener("resize", onWinResize);
          if (HOOKS && HOOKS.onDestroy) { try { HOOKS.onDestroy(); } catch (e) {} }
          if (ROOT && ROOT.parentNode) ROOT.parentNode.removeChild(ROOT);
          ROOT = null;
        }
      };
    }

    function unmount() {
      window.removeEventListener("resize", onWinResize);
      if (HOOKS && HOOKS.onDestroy) { try { HOOKS.onDestroy(); } catch (e) {} }
      if (ROOT && ROOT.parentNode) ROOT.parentNode.removeChild(ROOT);
      ROOT = null;
    }

    return {
      mount: mount, unmount: unmount, esc: esc,
      _destroy: function () {
        window.removeEventListener("resize", onWinResize);
        if (HOOKS && HOOKS.onDestroy) { try { HOOKS.onDestroy(); } catch (e) {} }
        if (ROOT && ROOT.parentNode) ROOT.parentNode.removeChild(ROOT);
        ROOT = null;
      }
    };
  }

  window.RLShell = { create: create, esc: esc };
})();
