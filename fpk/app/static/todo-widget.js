/* 待办清单悬浮窗组件（内容经 /api/todos 持久化到 todos.json）
 * 用法：TodoWidget.mount({ settingsApi, todosApi, pos, size, min, pinned })
 */
(function () {
  "use strict";

  function apiFetch(url, body) {
    return fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  var W = RLShell.create({
    id: "td", title: "待办清单", icon: "✅", minW: 240, minH: 160, defW: 280,
    build: function (body, ctx) {
      var esc = ctx.esc;
      var API = ctx.opts.todosApi || null;
      var todos = [];

      body.innerHTML =
        '<div class="td-list" id="tdList"></div>' +
        '<div class="td-add">' +
          '<input id="tdInput" placeholder="添加一项待办，回车提交" />' +
          '<button id="tdAddBtn">＋</button>' +
        '</div>';
      var listEl = body.querySelector("#tdList");
      var input = body.querySelector("#tdInput");
      var addBtn = body.querySelector("#tdAddBtn");

      function load() {
        if (!API) { render(); return; }
        fetch(API, { cache: "no-store" }).then(function (r) { return r.json(); })
          .then(function (j) { todos = Array.isArray(j.todos) ? j.todos : []; render(); })
          .catch(function () { render(); });
      }

      function render() {
        if (!todos.length) {
          listEl.innerHTML = '<div class="td-empty">还没有待办，添加一个开始吧</div>';
          return;
        }
        listEl.innerHTML = todos.map(function (t) {
          return '<div class="td-item' + (t.done ? ' done' : '') + '" data-id="' + esc(t.id) + '">' +
            '<input type="checkbox" data-id="' + esc(t.id) + '"' + (t.done ? ' checked' : '') + ' />' +
            '<span class="td-text">' + esc(t.text) + '</span>' +
            '<button class="td-del" data-id="' + esc(t.id) + '" title="删除">🗑</button>' +
            '</div>';
        }).join("");
        listEl.querySelectorAll('input[type=checkbox]').forEach(function (c) {
          c.onchange = function () {
            var t = byId(c.dataset.id); if (!t) return;
            t.done = c.checked;
            apiFetch(API, { action: "update", id: t.id, done: c.checked }).catch(function () {});
            render();
          };
        });
        listEl.querySelectorAll(".td-del").forEach(function (b) {
          b.onclick = function () {
            var id = b.dataset.id;
            todos = todos.filter(function (x) { return x.id !== id; });
            apiFetch(API, { action: "delete", id: id }).catch(function () {});
            render();
          };
        });
      }

      function byId(id) {
        for (var i = 0; i < todos.length; i++) if (todos[i].id === id) return todos[i];
        return null;
      }

      function add() {
        var v = input.value.trim();
        if (!v) return;
        input.value = "";
        if (!API) { todos.push({ id: "l" + Date.now(), text: v, done: false, created: Date.now() / 1000 }); render(); return; }
        apiFetch(API, { action: "add", text: v })
          .then(function (j) { if (j && Array.isArray(j.todos)) todos = j.todos; render(); })
          .catch(function () { render(); });
      }
      addBtn.onclick = add;
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") add(); });

      load();
      return {};
    }
  });

  window.TodoWidget = W;

  if (!window.__td_noauto) {
    window.addEventListener("DOMContentLoaded", function () {
      if (window.__td_mounted) return;
      window.__td_mounted = true;
      W.mount({ settingsApi: null, todosApi: null, pos: null, size: null });
    });
  }
})();
