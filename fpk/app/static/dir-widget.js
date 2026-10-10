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

  // ---- 文件类型识别（用于图标与预览方式）----
  function extOf(name) {
    var i = String(name || "").lastIndexOf(".");
    return i > 0 ? String(name).slice(i).toLowerCase() : "";
  }
  function has(map, ext) { return Object.prototype.hasOwnProperty.call(map, ext); }

  var IMG_EXT = {
    ".jpg": 1, ".jpeg": 1, ".png": 1, ".gif": 1, ".webp": 1, ".bmp": 1,
    ".svg": 1, ".ico": 1, ".avif": 1, ".heic": 1
  };
  var VID_EXT = {
    ".mp4": 1, ".m4v": 1, ".mkv": 1, ".webm": 1, ".mov": 1, ".avi": 1,
    ".flv": 1, ".wmv": 1, ".mpg": 1, ".mpeg": 1, ".ts": 1
  };
  var AUD_EXT = {
    ".mp3": 1, ".flac": 1, ".wav": 1, ".aac": 1, ".m4a": 1, ".ogg": 1,
    ".opus": 1, ".wma": 1, ".ape": 1
  };
  var ARC_EXT = {
    ".zip": 1, ".rar": 1, ".7z": 1, ".tar": 1, ".gz": 1, ".bz2": 1,
    ".xz": 1, ".tgz": 1, ".iso": 1
  };
  var TXT_EXT = {
    ".txt": 1, ".md": 1, ".markdown": 1, ".log": 1, ".json": 1, ".jsonl": 1,
    ".yaml": 1, ".yml": 1, ".ini": 1, ".conf": 1, ".cfg": 1, ".toml": 1,
    ".csv": 1, ".tsv": 1, ".xml": 1, ".html": 1, ".htm": 1, ".css": 1,
    ".js": 1, ".jsx": 1, ".ts": 1, ".vue": 1, ".py": 1, ".rb": 1, ".php": 1,
    ".java": 1, ".go": 1, ".rs": 1, ".c": 1, ".h": 1, ".cpp": 1, ".hpp": 1,
    ".cs": 1, ".sh": 1, ".bash": 1, ".sql": 1, ".srt": 1, ".ass": 1,
    ".vtt": 1, ".lrc": 1, ".nfo": 1
  };
  var DOC_EXT = {
    ".pdf": 1, ".doc": 1, ".docx": 1, ".xls": 1, ".xlsx": 1, ".ppt": 1,
    ".pptx": 1
  };

  // image / video / audio / text / archive / doc / other
  function kindOf(name) {
    var ext = extOf(name);
    if (has(IMG_EXT, ext)) return "image";
    if (has(VID_EXT, ext)) return "video";
    if (has(AUD_EXT, ext)) return "audio";
    if (has(TXT_EXT, ext)) return "text";
    if (has(ARC_EXT, ext)) return "archive";
    if (has(DOC_EXT, ext)) return "doc";
    return "other";
  }

  var KIND_ICON = {
    image: "🖼", video: "🎬", audio: "🎵", text: "📝",
    archive: "🗜", doc: "📄", other: "📄"
  };
  var KIND_LABEL = {
    image: "图片", video: "视频", audio: "音频", text: "文本",
    archive: "压缩包", doc: "文档", other: "文件"
  };

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
    this.fileApi = opts.fileApi || "/api/file";
    this.searchApi = opts.searchApi || "/api/search";
    this.path = opts.path || "";
    this.root = opts.root || "";   // 主目录边界，向上不可越过
    this.pos = opts.pos || null;   // 上次记住的位置 {left, top}
    this.size = opts.size || null; // 上次记住的大小 {width, height}
    this.entries = [];        // 当前目录的原始条目
    this.files = [];          // 当前列表里的文件（供预览上下翻）
    this.sortKey = "name";    // 排序键：name / size / type / mtime
    this.sortDesc = false;
    this.filter = "";         // 文件名过滤
    this.pvIndex = -1;        // 预览中文件在 this.files 里的下标
    this.pvOpen = false;
    this.mode = "list";       // 列表模式 list | 搜索模式 search
    this.showHidden = true;   // 是否显示以 . 开头的隐藏文件
    this.lastSearch = null;   // 上次的搜索参数 {kw, kind}
    this.searchSeq = 0;       // 请求序号，丢弃过期响应
    this.listTruncated = false;   // 列表是否因超上限被服务端截断
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
        '<button class="dw-btn dw-up-btn" title="上级目录（Alt+↑）">↑</button>' +
        '<button class="dw-btn dw-refresh-btn" title="刷新">⟳</button>' +
        '<button class="dw-btn dw-search-btn" title="搜索子目录（Ctrl+F）">🔍</button>' +
        '<button class="dw-btn dw-hidden-btn" title="显示/隐藏以 . 开头的隐藏文件">👁</button>' +
      '</div>' +
      '<div class="dw-searchbar" hidden>' +
        '<input class="dw-search" type="text" placeholder="在当前目录及其子目录中搜文件名…" />' +
        '<select class="dw-kind" title="按类型筛选">' +
          '<option value="all">全部</option>' +
          '<option value="dir">文件夹</option>' +
          '<option value="file">文件</option>' +
          '<option value="image">图片</option>' +
          '<option value="video">视频</option>' +
          '<option value="audio">音频</option>' +
          '<option value="text">文本</option>' +
          '<option value="archive">压缩包</option>' +
          '<option value="doc">文档</option>' +
        '</select>' +
        '<button class="dw-btn dw-search-go" title="开始搜索">⌕</button>' +
        '<button class="dw-btn dw-search-exit" title="退出搜索（Esc）">✕</button>' +
      '</div>' +
      '<div class="dw-breadcrumb" hidden></div>' +
      '<div class="dw-filterbar">' +
        '<input class="dw-filter" type="text" placeholder="过滤当前目录的文件名…（即时生效）" />' +
        '<button class="dw-btn dw-filter-clear" title="清除过滤">✕</button>' +
      '</div>' +
      '<div class="dw-body"></div>' +
      '<div class="dw-status"></div>' +
      '<span class="dw-resize" title="拖动调整大小（双击恢复默认）"></span>' +
      '<div class="dw-preview" hidden>' +
        '<div class="dw-pv-header">' +
          '<span class="dw-pv-title"></span>' +
          '<span class="dw-spacer"></span>' +
          '<button class="dw-btn dw-pv-prev" title="上一个（←）">‹</button>' +
          '<button class="dw-btn dw-pv-next" title="下一个（→）">›</button>' +
          '<a class="dw-btn dw-pv-dl" title="下载" download>⤓</a>' +
          '<button class="dw-btn dw-pv-close" title="关闭（Esc）">×</button>' +
        '</div>' +
        '<div class="dw-pv-body"></div>' +
        '<div class="dw-pv-status"></div>' +
      '</div>';
    var host = (this.opts && this.opts.container) || document.body;
    host.appendChild(root);
    this.el = root;
    if (this.opts && this.opts.embed) root.classList.add("dw-embed");

    // 卡片搬进桌面容器后，点击/按下不能冒泡到桌面
    // （否则点卡片会误触发桌面自身的处理，如取消图标选中等）
    root.addEventListener("mousedown", function (e) { e.stopPropagation(); });
    root.addEventListener("click", function (e) { e.stopPropagation(); });

    this.pathInput = root.querySelector(".dw-path");
    this.body = root.querySelector(".dw-body");
    this.status = root.querySelector(".dw-status");
    this.filterInput = root.querySelector(".dw-filter");
    this.filterBar = root.querySelector(".dw-filterbar");
    this.searchBar = root.querySelector(".dw-searchbar");
    this.searchInput = root.querySelector(".dw-search");
    this.kindSelect = root.querySelector(".dw-kind");
    this.crumb = root.querySelector(".dw-breadcrumb");
    this.preview = root.querySelector(".dw-preview");
    this.pvTitle = root.querySelector(".dw-pv-title");
    this.pvBody = root.querySelector(".dw-pv-body");
    this.pvStatus = root.querySelector(".dw-pv-status");
    // 未设置路径时显示提示，要求用户先输入路径
    this.body.innerHTML = this.path
      ? '<div class="dw-loading">加载中…</div>'
      : '<div class="dw-hint">请输入目录路径（如 /vol1/share 或 C:\\），回车查看</div>';

    this.pathInput.value = this.path;
    this.pathInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") self.go(self.pathInput.value.trim());
    });
    // 文件名过滤：输入即筛（大小写不敏感），只重排已有数据不再请求服务端
    this.filterInput.addEventListener("input", function () {
      self.setFilter(self.filterInput.value);
    });
    this.filterInput.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        self.filterInput.value = "";
        self.setFilter("");
      }
      e.stopPropagation();
    });
    root.querySelector(".dw-filter-clear").addEventListener("click", function () {
      self.filterInput.value = "";
      self.setFilter("");
    });
    root.querySelector(".dw-search-btn").addEventListener("click", function () {
      self.toggleSearch();
    });
    root.querySelector(".dw-search-go").addEventListener("click", function () {
      self.runSearch();
    });
    root.querySelector(".dw-search-exit").addEventListener("click", function () {
      self.toggleSearch(false);
    });
    this.searchInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") self.runSearch();
      else if (e.key === "Escape") self.toggleSearch(false);
      e.stopPropagation();
    });
    root.querySelector(".dw-hidden-btn").addEventListener("click", function () {
      self.showHidden = !self.showHidden;
      // 切换后立刻生效；正在搜索结果里则重发搜索
      root.querySelector(".dw-hidden-btn").classList.toggle("dw-off", !self.showHidden);
      root.querySelector(".dw-hidden-btn").title =
        self.showHidden ? "隐藏 . 开头的隐藏文件" : "显示 . 开头的隐藏文件";
      if (self.mode === "search" && self.lastSearch) {
        self.runSearch(true);
      } else {
        self._renderList();
      }
    });
    root.querySelector(".dw-pv-close").addEventListener("click", function () {
      self._closePreview();
    });
    root.querySelector(".dw-pv-prev").addEventListener("click", function () {
      self._stepPreview(-1);
    });
    root.querySelector(".dw-pv-next").addEventListener("click", function () {
      self._stepPreview(1);
    });
    // 快捷键：
    //   预览中  Esc 关闭 / ← → 翻上一个、下一个文件
    //   浏览中  Backspace 或 Alt+↑ 返回上级、Ctrl+F 打开搜索、Esc 退出搜索
    document.addEventListener("keydown", function (e) {
      var t = e.target;
      var typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" ||
                         t.tagName === "SELECT");
      if (self.pvOpen) {
        if (typing) return;
        if (e.key === "Escape") { self._closePreview(); e.preventDefault(); }
        else if (e.key === "ArrowLeft") { self._stepPreview(-1); e.preventDefault(); }
        else if (e.key === "ArrowRight") { self._stepPreview(1); e.preventDefault(); }
        return;
      }
      if (e.key === "f" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        self.toggleSearch(true);
        return;
      }
      if (typing) return;
      if (e.key === "Escape" && self.mode === "search") {
        e.preventDefault();
        self.toggleSearch(false);
        return;
      }
      if (e.key === "Backspace" || (e.key === "ArrowUp" && e.altKey)) {
        var parent = self._parentPath();
        if (parent) { e.preventDefault(); self.go(parent); }
      }
    });
    root.querySelector(".dw-refresh-btn").addEventListener("click", function () {
      self.refresh();
    });
    root.querySelector(".dw-up-btn").addEventListener("click", function () {
      var parent = self._parentPath();
      if (parent) self.go(parent);
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

    if (!(this.opts && this.opts.embed)) {
      this._makeDraggable(root.querySelector(".dw-header"), root);
      this._makeResizable(root.querySelector(".dw-resize"), root);
    }

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
      // 松手吸附到桌面图标网格（与图标行列对齐，视觉整齐）
      var r = panel.getBoundingClientRect();
      if (window.__rl93_snapToGrid) {
        var sn = window.__rl93_snapToGrid(r.left, r.top);
        panel.style.left = sn.left + "px";
        panel.style.top = sn.top + "px";
      }
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

  // 上级目录路径；已在根本（或已到主目录边界）时返回 null
  DirWidget.prototype._parentPath = function () {
    var cur = normPath(this.path);
    // 已在主目录顶部，不能再向上
    if (this.root && cur === normPath(this.root)) return null;
    var idx = Math.max(cur.lastIndexOf("/"), cur.lastIndexOf("\\"));
    var parent = idx > 0 ? cur.slice(0, idx) : "/";
    if (!parent || parent === cur) return null;   // 已经在根目录
    // 不允许越过主目录：父级越界则回到主目录
    if (this.root && !withinRoot(parent, this.root)) parent = normPath(this.root);
    return parent;
  };

  DirWidget.prototype.go = function (path) {
    if (!path) return;
    if (this.pvOpen) this._closePreview();   // 换目录时先把预览收起来
    if (this.mode === "search") this.toggleSearch(false);   // 换目录时退出搜索
    try { localStorage.setItem("rl93_path", path); } catch (e) {}
    this.path = path;
    this.pathInput.value = path;
    this.refresh();
  };

  DirWidget.prototype.refresh = function () {
    var self = this;
    if (this.mode === "search") this.toggleSearch(false);   // 刷新就回到列表视图
    this.body.innerHTML = '<div class="dw-loading">加载中…</div>';
    var url = this.api + "?path=" + encodeURIComponent(this.path);
    fetch(url, { cache: "no-store" })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok || res.j.error) {
          self._renderError(res.j.error || ("HTTP " + res.status));
          return;
        }
        self.listTruncated = !!res.j.truncated;
        self._render(res.j.path, res.j.entries || []);
      })
      .catch(function (e) {
        self._renderError("请求失败：" + e.message);
      });
  };

  DirWidget.prototype._renderError = function (msg) {
    // 出错要把数据清掉，否则用户再改过滤框会把上一次的旧列表刷回来
    this.entries = [];
    this.files = [];
    this.dirPath = this.path;
    this.body.innerHTML = '<div class="dw-error">⚠ ' + esc(msg) + '</div>';
    this.status.textContent = "";
  };

  // 客户端排序：目录永远排在文件之前，再按当前排序键排
  function sortEntries(entries, key, desc) {
    function nameCmp(a, b) {
      return String(a.name).localeCompare(String(b.name), undefined,
                                          { numeric: true, sensitivity: "base" });
    }
    function val(e, key) {
      if (key === "size") {
        return e.is_dir ? (e.items == null ? -1 : Number(e.items))
                        : (Number(e.size) || 0);
      }
      if (key === "mtime") return Number(e.mtime) || 0;
      if (key === "type") return e.is_dir ? "0文件夹" : (String(e.type) || "file");
      return null;
    }
    var arr = entries.slice();
    arr.sort(function (a, b) {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      if (key === "name") return desc ? nameCmp(b, a) : nameCmp(a, b);
      var av = val(a, key), bv = val(b, key);
      if (av < bv) return desc ? 1 : -1;
      if (av > bv) return desc ? -1 : 1;
      return nameCmp(a, b);   // 同值时按名称兜底，顺序稳定
    });
    return arr;
  }

  DirWidget.prototype.setFilter = function (text) {
    this.filter = String(text || "").trim();
    if (this.entries.length || this.path) this._renderList();
  };

  DirWidget.prototype.setSort = function (key) {
    if (this.sortKey === key) this.sortDesc = !this.sortDesc;
    else { this.sortKey = key; this.sortDesc = (key === "size" || key === "mtime"); }
    this._renderList();
  };

  DirWidget.prototype._render = function (path, entries) {
    this.entries = entries || [];
    this.dirPath = path;
    this._renderList();
  };

  DirWidget.prototype._renderList = function () {
    var self = this;
    if (!this.el) return;
    var path = this.dirPath != null ? this.dirPath : this.path;
    var base = path.replace(/[\\/]+$/, "");

    // 1) 过滤（隐藏文件开关 + 关键字，均大小写不敏感）
    var list = this.entries;
    if (!this.showHidden) {
      list = list.filter(function (e) { return String(e.name).charAt(0) !== "."; });
    }
    var kw = this.filter.toLowerCase();
    if (kw) {
      list = list.filter(function (e) {
        return String(e.name).toLowerCase().indexOf(kw) >= 0;
      });
    }
    // 2) 排序
    list = sortEntries(list, this.sortKey, this.sortDesc);

    var dirs = 0, files = 0, totalSize = 0;
    var rows = list.map(function (e) {
      var fullPath = esc(base + "/" + e.name);
      var sizeCell, nameCell, typeLabel;
      if (e.is_dir) {
        dirs++;
        nameCell = '<span class="dw-dir" title="进入该文件夹" data-path="' + fullPath + '">' +
          '<span class="dw-ico">📂</span>' + esc(e.name) + '</span>';
        sizeCell = e.items == null ? "—" : (e.items + " 项");
        typeLabel = "文件夹";
      } else {
        files++;
        totalSize += Number(e.size) || 0;
        var kind = e.kind || kindOf(e.name);
        nameCell = '<span class="dw-file" title="点击查看/下载" data-path="' + fullPath +
          '"><span class="dw-ico">' + (KIND_ICON[kind] || "📄") + '</span>' +
          esc(e.name) + '</span>';
        sizeCell = humanSize(e.size);
        typeLabel = KIND_LABEL[kind] || (e.type && e.type !== "file" ? e.type : "文件");
      }
      return '<tr>' +
        '<td class="name">' + nameCell + '</td>' +
        '<td class="size">' + esc(sizeCell) + '</td>' +
        '<td><span class="dw-type-pill">' + esc(typeLabel) + '</span></td>' +
        '<td class="mtime">' + esc(e.mtime_str) + '</td>' +
      '</tr>';
    }).join("");

    // 首行的 ".."：返回上级目录（已在根目录 / 主目录边界时不显示）
    var up = this._parentPath();
    var upRow = up
      ? '<tr class="dw-up-row">' +
          '<td class="name"><span class="dw-dir dw-parent" title="返回上级目录" data-path="' +
            esc(up) + '"><span class="dw-ico">↩</span>..</span></td>' +
          '<td class="size">—</td>' +
          '<td><span class="dw-type-pill">上级目录</span></td>' +
          '<td class="mtime"></td>' +
        '</tr>'
      : "";

    function th(key, label) {
      var cls = "dw-sortable" + (self.sortKey === key ? " dw-sorted" : "");
      var arrow = self.sortKey === key ? (self.sortDesc ? " ▾" : " ▴") : "";
      return '<th class="' + cls + '" data-sort="' + key + '" title="点击按此列排序">' +
        label + '<span class="dw-arrow">' + arrow + '</span></th>';
    }

    var html =
      '<table class="dw-table">' +
        '<thead><tr>' + th("name", "名称") + th("size", "大小") +
          th("type", "类型") + th("mtime", "修改时间") + '</tr></thead>' +
        '<tbody>' + upRow +
          (rows || '<tr><td colspan="4" class="dw-loading">' +
            (kw ? "没有匹配「" + esc(this.filter) + "」的文件" : "（空目录）") +
          '</td></tr>') +
        '</tbody>' +
      '</table>';
    this.body.innerHTML = html;

    Array.prototype.forEach.call(this.body.querySelectorAll(".dw-dir"), function (el) {
      el.addEventListener("click", function () { self.go(el.getAttribute("data-path")); });
    });
    Array.prototype.forEach.call(this.body.querySelectorAll(".dw-file"), function (el) {
      el.addEventListener("click", function () {
        self._openPreview(el.getAttribute("data-path"), el.getAttribute("title"));
      });
    });
    Array.prototype.forEach.call(this.body.querySelectorAll("th.dw-sortable"), function (el) {
      el.addEventListener("click", function () { self.setSort(el.getAttribute("data-sort")); });
    });

    // 预览上下翻用的文件清单（跟随当前过滤/排序）
    this.files = list.filter(function (e) { return !e.is_dir; })
                     .map(function (e) { return base + "/" + e.name; });

    this.status.textContent = path + "  ·  " + dirs + " 个文件夹, " + files + " 个文件" +
      "（合计 " + humanSize(totalSize) + "）" +
      (kw ? "  ·  已过滤：" + this.filter : "") +
      (this.listTruncated ? "  ·  目录过大，仅显示前 N 项，请用 Ctrl+F 搜索定位" : "");
    this._renderBreadcrumb(path);
    this._syncUpBtn();
  };

  // 路径面包屑：每一段可点击直接跳到该层
  DirWidget.prototype._renderBreadcrumb = function (path) {
    if (!this.crumb) return;
    if (!path) { this.crumb.hidden = true; return; }
    var posix = String(path).replace(/\\/g, "/");
    var parts = posix.split("/").filter(function (s) { return s !== ""; });
    if (!parts.length) { this.crumb.hidden = true; return; }
    this.crumb.hidden = false;
    function chip(label, p) {
      return '<span class="dw-crumb" data-path="' + esc(p) + '" title="' +
        esc(p) + '">' + esc(label) + '</span>';
    }
    var html = [chip("/", "/")];
    var acc = "";
    for (var i = 0; i < parts.length; i++) {
      acc += "/" + parts[i];
      html.push(chip(parts[i], acc));
    }
    this.crumb.innerHTML = html.join('<span class="dw-crumb-sep">›</span>');
    var self = this;
    Array.prototype.forEach.call(this.crumb.querySelectorAll(".dw-crumb"), function (el) {
      el.addEventListener("click", function () { self.go(el.getAttribute("data-path")); });
    });
  };

  DirWidget.prototype._syncUpBtn = function () {
    if (!this.el) return;
    var btn = this.el.querySelector(".dw-up-btn");
    if (!btn) return;
    // 与列表里的 ".." 保持一致：算不出上级就置灰
    var parent = this._parentPath();
    btn.disabled = !parent;
    btn.title = parent ? "上级目录"
      : (this.root ? "已在主目录，不能再向上" : "已在根目录，不能再向上");
    btn.style.opacity = parent ? "" : ".4";
  };

  // ===================== 搜索 =====================
  DirWidget.prototype.toggleSearch = function (force) {
    var on = typeof force === "boolean" ? force : (this.mode !== "search");
    this.mode = on ? "search" : "list";
    this.searchBar.hidden = !on;
    this.filterBar.hidden = on;
    if (on) {
      this.searchInput.focus();
      this.searchInput.select();
      if (!this.searchInput.value && !this.lastSearch) {
        this.body.innerHTML =
          '<div class="dw-hint">输入关键字后回车，搜索当前目录及其子目录的文件名' +
          '<br />（也可以只选类型不输关键字，列出该类型全部文件）</div>';
      }
    } else {
      this.lastSearch = null;
      this._renderList();     // 回到普通列表
    }
    this._syncUpBtn();
  };

  DirWidget.prototype.runSearch = function (silent) {
    var self = this;
    var kw = this.searchInput.value.trim();
    var kind = this.kindSelect.value;
    if (!this.path) {
      if (!silent) {
        this.body.innerHTML =
          '<div class="dw-error">⚠ 请先在上方输入框里填一个要搜索的目录路径</div>';
      }
      return;
    }
    if (!kw && kind === "all") {
      if (!silent) {
        this.body.innerHTML =
          '<div class="dw-error">⚠ 请输入关键字，或选择一种文件类型</div>';
      }
      return;
    }
    this.lastSearch = { kw: kw, kind: kind };
    this.searchSeq++;
    var seq = this.searchSeq;
    this.body.innerHTML = '<div class="dw-loading">搜索中…</div>';
    this.status.textContent = "搜索「" + (kw || kind) + "」于 " + this.path;

    var url = this.searchApi + "?path=" + encodeURIComponent(this.path) +
      "&kw=" + encodeURIComponent(kw) + "&kind=" + encodeURIComponent(kind) +
      (this.showHidden ? "&hidden=1" : "");
    fetch(url, { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (seq !== self.searchSeq) return;   // 已有更新的请求，丢弃本次结果
        if (j.error) {
          self._renderError(j.error);
          return;
        }
        self._renderResults(j);
      })
      .catch(function (e) {
        if (seq !== self.searchSeq) return;
        self._renderError("搜索失败：" + e.message);
      });
  };

  DirWidget.prototype._renderResults = function (j) {
    var self = this;
    var hits = j.entries || [];
    var rows = hits.map(function (e) {
      var icon = e.is_dir ? "📂" : (KIND_ICON[e.kind] || KIND_ICON[kindOf(e.name)] || "📄");
      var nameCell = '<span class="' + (e.is_dir ? "dw-dir" : "dw-file") +
        '" data-path="' + esc(e.path) + '">' +
        '<span class="dw-ico">' + icon + '</span>' + esc(e.name) + '</span>';
      return '<tr>' +
        '<td class="name">' + nameCell + '</td>' +
        '<td class="dir-path" title="' + esc(e.dir) + '">' + esc(e.dir) + '</td>' +
        '<td class="size">' + esc(e.is_dir ? "—" : humanSize(e.size)) + '</td>' +
        '<td class="mtime">' + esc(e.mtime_str) + '</td>' +
      '</tr>';
    }).join("");

    this.body.innerHTML =
      '<table class="dw-table dw-result">' +
        '<thead><tr><th>名称</th><th>所在目录</th><th>大小</th><th>修改时间</th></tr></thead>' +
        '<tbody>' + (rows ||
          '<tr><td colspan="4" class="dw-loading">没有匹配的文件</td></tr>') +
        '</tbody>' +
      '</table>';

    Array.prototype.forEach.call(this.body.querySelectorAll(".dw-dir"), function (el) {
      el.addEventListener("click", function () {
        self.toggleSearch(false);
        self.go(el.getAttribute("data-path"));
      });
    });
    Array.prototype.forEach.call(this.body.querySelectorAll(".dw-file"), function (el) {
      el.addEventListener("click", function () {
        // 预览的"上一个/下一个"范围 = 本次搜索命中的文件
        self.files = hits.filter(function (e) { return !e.is_dir; })
                         .map(function (e) { return e.path; });
        self._openPreview(el.getAttribute("data-path"));
      });
    });

    this.status.textContent =
      "搜索「" + (j.keyword || j.kind) + "」命中 " + hits.length + " 项" +
      "  ·  " + j.elapsed_ms + " ms" +
      (j.truncated ? "  ·  已达上限 " + j.limit + " 条，请缩小范围或细化关键字" : "");
  };

  // ===================== 文件预览 =====================
  DirWidget.prototype._fileUrl = function (path, extra) {
    return this.fileApi + "?path=" + encodeURIComponent(path) + (extra || "");
  };

  DirWidget.prototype._openPreview = function (path) {
    if (!this.el || !path) return;
    var idx = this.files.indexOf(path);
    if (idx < 0) {           // 不在当前清单里（理论上不会），单独预览它
      this.files = [path];
      idx = 0;
    }
    this.pvIndex = idx;
    this.pvOpen = true;
    this.preview.hidden = false;
    this._renderPreview();
  };

  DirWidget.prototype._stepPreview = function (step) {
    if (!this.pvOpen || this.files.length < 2) return;
    var n = this.files.length;
    this.pvIndex = (this.pvIndex + step + n) % n;   // 首尾循环
    this._renderPreview();
  };

  DirWidget.prototype._closePreview = function () {
    this.pvOpen = false;
    this.preview.hidden = true;
    // 必须暂停，否则界面关了声音还在响
    Array.prototype.forEach.call(this.preview.querySelectorAll("video, audio"),
      function (m) { try { m.pause(); m.removeAttribute("src"); } catch (e) {} });
    this.pvBody.innerHTML = "";
  };

  DirWidget.prototype._renderPreview = function () {
    var self = this;
    var path = this.files[this.pvIndex];
    if (!path) return;
    var name = path.split(/[\\/]/).pop();
    var kind = kindOf(name);

    this.pvTitle.textContent = name;
    this.pvTitle.title = path;
    var dl = this.el.querySelector(".dw-pv-dl");
    dl.href = this._fileUrl(path, "&dl=1");
    dl.setAttribute("download", name);
    this.pvStatus.textContent = (this.pvIndex + 1) + " / " + this.files.length;
    this.pvBody.innerHTML = '<div class="dw-loading">加载中…</div>';

    if (kind === "text") {
      fetch(this._fileUrl(path, "&mode=text"), { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.error) {
            self.pvBody.innerHTML =
              '<div class="dw-error">⚠ ' + esc(j.error) + '</div>';
            return;
          }
          self.pvBody.innerHTML =
            '<pre class="dw-pv-text">' + esc(j.content || "(空文件)") + '</pre>';
          self.pvStatus.textContent += "  ·  " + (j.encoding || "") +
            (j.truncated ? "（超过 512KB，已截断）" : "");
        })
        .catch(function (e) {
          self.pvBody.innerHTML =
            '<div class="dw-error">⚠ 读取失败：' + esc(e.message) + '</div>';
        });
      return;
    }

    var url = esc(this._fileUrl(path));
    if (kind === "image") {
      this.pvBody.innerHTML =
        '<img class="dw-pv-img" src="' + url + '" alt="' + esc(name) + '" />';
      return;
    }
    if (kind === "video") {
      this.pvBody.innerHTML =
        '<video class="dw-pv-media" controls autoplay playsinline src="' + url + '"></video>';
      return;
    }
    if (kind === "audio") {
      this.pvBody.innerHTML =
        '<div class="dw-pv-audio"><div class="dw-pv-audio-ico">🎵</div>' +
        '<audio class="dw-pv-media" controls autoplay src="' + url + '"></audio></div>';
      return;
    }
    this.pvBody.innerHTML =
      '<div class="dw-hint">该类型不支持在线预览<br />点右上角 ⤓ 下载后用其它程序打开</div>';
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
