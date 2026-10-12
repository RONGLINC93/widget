/* 便签悬浮窗组件（内容经 /api/notes 持久化到 notes.json）
 * 用法：NotesWidget.mount({ settingsApi, notesApi, pos, size, min, pinned })
 *   settingsApi：浮层位置/大小/最小化/固定（/api/notes_settings）
 *   notesApi    ：便签内容增删改（/api/notes）
 */
(function () {
  "use strict";

  var COLORS = ["#fff3a3", "#c8f7c5", "#a3d8ff", "#ffc9de", "#e3c8ff", "#ffe0b3"];

  function apiFetch(url, body) {
    return fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  var W = RLShell.create({
    id: "nt", title: "便签", icon: "📝", minW: 220, minH: 160, defW: 260,
    build: function (body, ctx) {
      var esc = ctx.esc;
      var API = ctx.opts.notesApi || null;
      var notes = [];
      var byId = function (id) {
        for (var i = 0; i < notes.length; i++) if (notes[i].id === id) return notes[i];
        return null;
      };
      var saveTimer = null;
      function saveText(id, text) {
        if (!API) return;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(function () {
          apiFetch(API, { action: "update", id: id, text: text }).catch(function () {});
        }, 400);
      }

      body.innerHTML =
        '<div class="nt-list" id="ntList"></div>' +
        '<button class="nt-add" id="ntAdd">＋ 新建便签</button>';
      var listEl = body.querySelector("#ntList");
      var addBtn = body.querySelector("#ntAdd");

      function load(cb) {
        if (!API) { render(); if (cb) cb(); return; }
        fetch(API, { cache: "no-store" }).then(function (r) { return r.json(); })
          .then(function (j) { notes = Array.isArray(j.notes) ? j.notes : []; render(); if (cb) cb(); })
          .catch(function () { render(); if (cb) cb(); });
      }

      function render() {
        if (!notes.length) {
          listEl.innerHTML = '<div class="nt-empty">还没有便签，点下方按钮新建一张</div>';
          return;
        }
        var ordered = notes.slice().sort(function (a, b) {
          if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
          return (a.created || 0) - (b.created || 0);
        });
        listEl.innerHTML = ordered.map(function (n) {
          var dots = COLORS.map(function (c) {
            return '<span class="nt-dot' + (c === n.color ? ' sel' : '') + '" style="background:' + c + '" data-id="' + esc(n.id) + '" data-c="' + c + '"></span>';
          }).join("");
          return '<div class="nt-note" style="background:' + esc(n.color || COLORS[0]) + '">' +
            '<textarea placeholder="写点什么…" data-id="' + esc(n.id) + '"></textarea>' +
            '<div class="nt-bar">' + dots +
            '<span class="nt-spacer"></span>' +
            '<button class="nt-pin' + (n.pinned ? ' on' : '') + '" data-id="' + esc(n.id) + '" title="置顶">📌</button>' +
            '<button class="nt-del" data-id="' + esc(n.id) + '" title="删除">🗑</button>' +
            '</div></div>';
        }).join("");
        listEl.querySelectorAll(".nt-note textarea").forEach(function (ta) {
          var n = byId(ta.dataset.id); if (n) ta.value = n.text || "";
          ta.addEventListener("input", function () { saveText(ta.dataset.id, ta.value); });
        });
        listEl.querySelectorAll(".nt-dot").forEach(function (d) {
          d.onclick = function () {
            var n = byId(d.dataset.id); if (!n) return;
            n.color = d.dataset.c;
            apiFetch(API, { action: "update", id: n.id, color: d.dataset.c }).catch(function () {});
            render();
          };
        });
        listEl.querySelectorAll(".nt-pin").forEach(function (b) {
          b.onclick = function () {
            var n = byId(b.dataset.id); if (!n) return;
            apiFetch(API, { action: "update", id: n.id, pinned: !n.pinned }).catch(function () {});
            load();
          };
        });
        listEl.querySelectorAll(".nt-del").forEach(function (b) {
          b.onclick = function () {
            var id = b.dataset.id;
            notes = notes.filter(function (x) { return x.id !== id; });
            apiFetch(API, { action: "delete", id: id }).catch(function () {});
            render();
          };
        });
      }

      addBtn.onclick = function () {
        if (!API) { notes.push({ id: "l" + Date.now(), text: "", color: COLORS[0], pinned: false, created: Date.now() / 1000 }); render(); return; }
        apiFetch(API, { action: "add", text: "", color: COLORS[0] })
          .then(function (j) { if (j && Array.isArray(j.notes)) notes = j.notes; render(); })
          .catch(function () { render(); });
      };

      load();
      return {};
    }
  });

  window.NotesWidget = W;

  if (!window.__nt_noauto) {
    window.addEventListener("DOMContentLoaded", function () {
      if (window.__nt_mounted) return;
      window.__nt_mounted = true;
      W.mount({ settingsApi: null, notesApi: null, pos: null, size: null });
    });
  }
})();
