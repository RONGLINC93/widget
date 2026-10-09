/* 目录文件列表浮层组件（纯原生 JS，零依赖）
 * 用法：
 *   DirWidget.mount({ path: "/vol1/share", api: "/api/list" });  // 编程式
 *   或直接引入本脚本，默认挂载到 document.body，读取当前页 URL 的 ?path=
 * 字段：名称 / 大小 / 类型 / 修改时间；支持目录点击进入、返回上级、刷新、拖拽、最小化。
 */
(function (global) {
  "use strict";

  function humanSize(n) {
    if (n == null) return "";
    var s = Number(n);
    var u = ["B", "KB", "MB", "GB", "TB"];
    for (var i = 0; i < u.length; i++) {
      if (s < 1024 || i === u.length - 1)
        return (i === 0 ? Math.round(s) : s.toFixed(1)) + " " + u[i];
      s /= 1024;
    }
    return s.toFixed(1) + " TB";
  }

  function normPath(p) {
    return String(p || "").replace(/[\\/]+$/, "") || "/";
  }

  function withinRoot(p, root) {
    if (!root) return true;
    var P = normPath(p), R = normPath(root);
    return P === R || P.indexOf(R + "/") === 0;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // 卡片最小 / 最大可调整尺寸（同时受视口约束，不允许拖出屏幕）
  var MIN_W = 280, MIN_H = 140;

  function clampSize(w, h, left, top) {
    var vw = window.innerWidth || 1024, vh = window.innerHeight || 768;
    var maxW = Math.max(MIN_W, vw - (left || 0) - 8);
    var maxH = Math.max(MIN_H, vh - (top || 0) - 8);
    return [Math.min(Math.max(MIN_W, Number(w) || MIN_W), maxW),
            Math.min(Math.max(MIN_H, Number(h) || MIN_H), maxH)];
  }

  function DirWidget(opts) {
    opts = opts || {};
    this.api = opts.api || "/api/list";
    this.path = opts.path || "";
    this.root = opts.root || "";   // 主目录边界，向上不可越过
    this.pos = opts.pos || null;   // 上次记住的位置 {left, top}
    this.size = opts.size || null; // 上次记住的大小 {width, height}
    this.opts = opts;
    this.el = null;
    this._build();
  }

  DirWidget.prototype._build = function () {
    var self = this;
    var root = document.createElement("div");
    root.id = "dw-root";
    root.innerHTML =
      '<div class="dw-header">' +
        '<span class="dw-title">📁 目录浏览器</span>' +
        '<span class="dw-spacer"></span>' +
        '<button class="dw-btn dw-min-btn" title="最小化">—</button>' +
        '<button class="dw-btn dw-close-btn" title="关闭">×</button>' +
      '</div>' +
      '<div class="dw-toolbar">' +
        '<input class="dw-path" type="text" placeholder="输入目录路径，如 /vol1/share" />' +
        '<button class="dw-btn dw-up-btn" title="上级目录">↑</button>' +
        '<button class="dw-btn dw-refresh-btn" title="刷新">⟳</button>' +
      '</div>' +
      '<div class="dw-body"></div>' +
      '<div class="dw-status"></div>' +
      '<span class="dw-resize" title="拖动调整大小（双击恢复默认）"></span>';
    document.body.appendChild(root);
    this.el = root;

    // 卡片搬进桌面容器后，点击/按下不能冒泡到桌面
    // （否则点卡片会误触发桌面自身的处理，如取消图标选中等）
    root.addEventListener("mousedown", function (e) { e.stopPropagation(); });
    root.addEventListener("click", function (e) { e.stopPropagation(); });

    this.pathInput = root.querySelector(".dw-path");
    this.body = root.querySelector(".dw-body");
    this.status = root.querySelector(".dw-status");
    // 未设置路径时显示提示，要求用户先输入路径
    this.body.innerHTML = this.path
      ? '<div class="dw-loading">加载中…</div>'
      : '<div class="dw-hint">请输入目录路径（如 /vol1/share 或 C:\\），回车查看</div>';

    this.pathInput.value = this.path;
    this.pathInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") self.go(self.pathInput.value.trim());
    });
    root.querySelector(".dw-refresh-btn").addEventListener("click", function () {
      self.refresh();
    });
    root.querySelector(".dw-up-btn").addEventListener("click", function () {
      var cur = normPath(self.path);
      // 已在主目录顶部，不能再向上
      if (self.root && normPath(cur) === normPath(self.root)) return;
      var idx = Math.max(cur.lastIndexOf("/"), cur.lastIndexOf("\\"));
      var parent = idx > 0 ? cur.slice(0, idx) : "/";
      // 不允许越过主目录：父级越界则回到主目录
      if (self.root && !withinRoot(parent, self.root)) parent = normPath(self.root);
      self.go(parent);
    });
    self._syncUpBtn();
    root.querySelector(".dw-close-btn").addEventListener("click", function () {
      root.remove();
      // 记住"已关闭"到服务端，否则刷新桌面时注入脚本会重新挂载
      if (self.opts.settingsApi) {
        fetch(self.opts.settingsApi, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ visible: false })
        }).catch(function () {});
      }
    });
    root.querySelector(".dw-min-btn").addEventListener("click", function () {
      root.classList.toggle("dw-min");
    });

    this._makeDraggable(root.querySelector(".dw-header"), root);
    this._makeResizable(root.querySelector(".dw-resize"), root);

    // 还原上次记住的大小（先尺寸后位置：位置钳制要用到实际尺寸）
    if (this.size) this._applySize(this.size.width, this.size.height);
    // 还原上次记住的位置（越界会被钳制回屏幕内）
    if (this.pos) this._applyPos(this.pos.left, this.pos.top);

    if (this.path) this.refresh();
  };

  DirWidget.prototype._makeDraggable = function (handle, panel) {
    var self = this;
    var sx, sy, ox, oy, drag = false;
    handle.addEventListener("mousedown", function (e) {
      if (e.target.closest(".dw-btn")) return;
      drag = true;
      sx = e.clientX; sy = e.clientY;
      var r = panel.getBoundingClientRect();
      ox = r.left; oy = r.top;
      panel.style.right = "auto";
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
      e.preventDefault();
    });
    function move(e) {
      if (!drag) return;
      panel.style.left = (ox + e.clientX - sx) + "px";
      panel.style.top = (oy + e.clientY - sy) + "px";
    }
    function up() {
      drag = false;
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      self._saveBox(panel);   // 拖动结束即记住位置
    }
  };

  // 右下角把手：拖动调整大小，双击恢复默认
  DirWidget.prototype._makeResizable = function (handle, panel) {
    var self = this;
    if (!handle) return;
    handle.addEventListener("mousedown", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var sx = e.clientX, sy = e.clientY;
      var r0 = panel.getBoundingClientRect();
      var sw = r0.width, sh = r0.height;
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
      function move(e) {
        var box = clampSize(sw + e.clientX - sx, sh + e.clientY - sy,
                            r0.left, r0.top);
        panel.style.width = box[0] + "px";
        panel.style.height = box[1] + "px";
      }
      function up() {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        self._saveBox(panel);   // 调整结束即记住大小
      }
    });
    handle.addEventListener("dblclick", function (e) {
      e.preventDefault();
      e.stopPropagation();
      panel.style.width = "";
      panel.style.height = "";
      self._saveBox(panel, true);   // size=null → 下次用默认大小
    });
  };

  DirWidget.prototype._saveBox = function (panel, resetSize) {
    if (!panel || !this.opts || !this.opts.settingsApi) return;
    var r = panel.getBoundingClientRect();
    // pos 与 size 一起提交：服务端是"读-改-写"，分两次请求会互相覆盖
    var payload = { pos: { left: Math.round(r.left), top: Math.round(r.top) } };
    payload.size = resetSize ? null
      : { width: Math.round(r.width), height: Math.round(r.height) };
    try {
      fetch(this.opts.settingsApi, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).catch(function () {});
    } catch (e) {}
  };

  DirWidget.prototype._applySize = function (width, height) {
    if (!this.el || width == null || height == null) return;
    var r = this.el.getBoundingClientRect();
    var box = clampSize(width, height, r.left, r.top);
    this.el.style.width = box[0] + "px";
    this.el.style.height = box[1] + "px";
  };

  DirWidget.prototype._applyPos = function (left, top) {
    if (left == null || top == null || !this.el) return;
    var w = this.el.offsetWidth || 420;
    var h = this.el.offsetHeight || 240;
    var maxL = Math.max(0, (window.innerWidth || 1024) - w);
    var maxT = Math.max(0, (window.innerHeight || 768) - h);
    var L = Math.min(Math.max(0, Number(left) || 0), maxL);
    var T = Math.min(Math.max(0, Number(top) || 0), maxT);
    this.el.style.right = "auto";
    this.el.style.left = L + "px";
    this.el.style.top = T + "px";
  };

  DirWidget.prototype.go = function (path) {
    if (!path) return;
    try { localStorage.setItem("rl93_path", path); } catch (e) {}
    this.path = path;
    this.pathInput.value = path;
    this.refresh();
  };

  DirWidget.prototype.refresh = function () {
    var self = this;
    this.body.innerHTML = '<div class="dw-loading">加载中…</div>';
    var url = this.api + "?path=" + encodeURIComponent(this.path);
    fetch(url, { cache: "no-store" })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok || res.j.error) {
          self._renderError(res.j.error || ("HTTP " + res.status));
          return;
        }
        self._render(res.j.path, res.j.entries || []);
      })
      .catch(function (e) {
        self._renderError("请求失败：" + e.message);
      });
  };

  DirWidget.prototype._renderError = function (msg) {
    this.body.innerHTML = '<div class="dw-error">⚠ ' + esc(msg) + '</div>';
    this.status.textContent = "";
  };

  DirWidget.prototype._render = function (path, entries) {
    var self = this;
    var dirs = 0, files = 0;
    var rows = entries.map(function (e) {
      if (e.is_dir) dirs++; else files++;
      var sizeCell, nameCell;
      if (e.is_dir) {
        nameCell = '<span class="dw-dir" data-path="' +
          esc(path.replace(/[\\/]+$/, "") + "/" + e.name) + '">' +
          '<span class="dw-ico">📂</span>' + esc(e.name) + '</span>';
        sizeCell = e.items == null ? "—" : (e.items + " 项");
      } else {
        nameCell = '<span class="dw-ico">📄</span>' + esc(e.name);
        sizeCell = humanSize(e.size);
      }
      var typeLabel = e.is_dir ? "文件夹" : (e.type && e.type !== "file" ? e.type : "文件");
      return '<tr>' +
        '<td class="name">' + nameCell + '</td>' +
        '<td class="size">' + esc(sizeCell) + '</td>' +
        '<td><span class="dw-type-pill">' + esc(typeLabel) + '</span></td>' +
        '<td class="mtime">' + esc(e.mtime_str) + '</td>' +
      '</tr>';
    }).join("");

    var html =
      '<table class="dw-table">' +
        '<thead><tr><th>名称</th><th>大小</th><th>类型</th><th>修改时间</th></tr></thead>' +
        '<tbody>' + (rows || '<tr><td colspan="4" class="dw-loading">（空目录）</td></tr>') + '</tbody>' +
      '</table>';
    this.body.innerHTML = html;

    Array.prototype.forEach.call(this.body.querySelectorAll(".dw-dir"), function (el) {
      el.addEventListener("click", function () { self.go(el.getAttribute("data-path")); });
    });

    this.status.textContent = path + "  ·  " + dirs + " 个文件夹, " + files + " 个文件";
    this._syncUpBtn();
  };

  DirWidget.prototype._syncUpBtn = function () {
    if (!this.el) return;
    var btn = this.el.querySelector(".dw-up-btn");
    if (!btn) return;
    var atTop = !!(this.root && normPath(this.path) === normPath(this.root));
    btn.disabled = atTop;
    btn.title = atTop ? "已在主目录，不能再向上" : "上级目录";
    btn.style.opacity = atTop ? ".4" : "";
  };

  // 公共 API
  DirWidget.mount = function (opts) {
    return new DirWidget(opts);
  };
  global.DirWidget = DirWidget;

  // 自动挂载：若 URL 带 ?path= 或脚本配置了 data-path，则直接挂载
  if (typeof document !== "undefined") {
    var params = new URLSearchParams(location.search);
    var autoPath = params.get("path");
    if (autoPath) {
      document.addEventListener("DOMContentLoaded", function () {
        new DirWidget({ path: autoPath });
      });
    }
  }
})(window);
