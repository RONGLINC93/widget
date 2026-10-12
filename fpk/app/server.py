# -*- coding: utf-8 -*-
"""
目录浏览器后端（仅标准库，零依赖）
=================================

fnOS 应用包 fpk/app/server.py：提供 HTTP 接口读取指定目录，并托管前端浮层组件。
  GET /                       ->  fpk/app/ui/index.html（桌面入口）
  GET /static/*               ->  前端静态资源（dir-widget.html/js/css）
  GET /api/list?path=<目录>   ->  JSON: { path, error?, entries:[...] }
  GET /api/notes             ->  便签列表；POST 增删改（action=add/update/delete/reorder）
  GET /api/todos              ->  待办列表；POST 增删改（action=add/update/delete/reorder）
  GET /api/monitor            ->  系统监控（CPU/内存/磁盘/运行时间/温度/风扇/显卡，Linux /proc + sysfs + nvidia-smi）
  GET /api/*_settings         ->  各浮层组件的位置/大小/最小化/固定/可见性
  GET /health                 ->  "ok"（供 cmd/main 探活）

条目字段：name, is_dir, size, items(目录条目数), type, mtime, mtime_str
排序：目录在前、文件在后，再按名称不区分大小写排序。

端口取自环境变量 TRIM_SERVICE_PORT（fnOS 注入），缺省 5668。
"""
from __future__ import annotations

from typing import Any, Dict

import os
import re
import shutil
import socket
import time
import subprocess
import json
import mimetypes
from datetime import datetime
from urllib.parse import urlparse, parse_qs, unquote, quote

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "static")
UI_DIR = os.path.join(HERE, "ui")
API_BASE = "/api/list"
API_FILE = "/api/file"
API_SEARCH = "/api/search"
APP_NAME = os.environ.get("TRIM_APPNAME", "ronglinc93widget")
GATEWAY_PREFIX = "/app/" + APP_NAME

# 文本预览：单次最多读取的字节数（超出截断，前端会提示）
TEXT_PREVIEW_MAX = 512 * 1024
# 单次列表最多返回的条目数（超大目录不至于把浏览器卡死）
LIST_MAX_ENTRIES = 3000
# 递归搜索的保护参数：结果上限 / 最深层级 / 最长耗时
SEARCH_MAX_RESULTS = 500
SEARCH_MAX_DEPTH = 6
SEARCH_TIMEOUT_SEC = 8

# 文件类型分类（供列表的 kind 字段与搜索的类型筛选共用）
IMG_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".ico",
    ".avif", ".heic",
}
VIDEO_EXTENSIONS = {
    ".mp4", ".m4v", ".mkv", ".webm", ".mov", ".avi", ".flv", ".wmv",
    ".mpg", ".mpeg", ".ts",
}
AUDIO_EXTENSIONS = {
    ".mp3", ".flac", ".wav", ".aac", ".m4a", ".ogg", ".opus", ".wma", ".ape",
}
ARCHIVE_EXTENSIONS = {
    ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".tgz", ".iso",
}
DOC_EXTENSIONS = {
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
}

# 按这些扩展名（或它们的 mimetype 前缀）判定为纯文本
TEXT_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".log", ".json", ".jsonl", ".yaml", ".yml",
    ".ini", ".conf", ".cfg", ".properties", ".env", ".toml", ".csv", ".tsv",
    ".xml", ".html", ".htm", ".css", ".js", ".jsx", ".ts", ".vue", ".py",
    ".rb", ".php", ".java", ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".cs",
    ".sh", ".bash", ".zsh", ".sql", ".plist", ".gitignore", ".dockerfile",
    ".service", ".conf.d", ".nfo", ".cue", ".srt", ".ass", ".vtt", ".lrc",
}

# ======================================================================
# 飞牛桌面注入（参照 QWeather：nginx alias + ng.conf.zip 持久化）
# 仅当以 root 运行且 conf/ng_keys.json 密钥与当前 fnOS 版本匹配时生效；
# 失败时不影响后端服务本身，桌面小组件只是不显示。
# ======================================================================
APP_DATA_DIR = os.environ.get("TRIM_PKGVAR", "/vol1/@appdata/" + APP_NAME)
APP_DEST_DIR = os.environ.get("TRIM_APPDEST", "/vol1/@appcenter/" + APP_NAME)
DESKTOP_INDEX = os.path.join(APP_DATA_DIR, "desktop", "index.html")
SETTINGS_FILE = os.path.join(APP_DATA_DIR, "settings.json")
# 便签 / 待办清单 的持久化数据文件（与 settings.json 同级，独立存放避免单文件过大）
NOTES_FILE = os.path.join(APP_DATA_DIR, "notes.json")
TODOS_FILE = os.path.join(APP_DATA_DIR, "todos.json")
# 注意：fnOS 解 app.tgz 时会去掉 app/ 前缀，静态资源实际在 <APP_DEST>/static/ 下
INJECT_JS_DIRECT = os.path.join(APP_DEST_DIR, "static", "inject.js")
KEYS_FILE = os.path.join(HERE, "conf", "ng_keys.json")
WIDGET_SCRIPT_TAG = '<script src="/ronglinc93widget-inject.js"></script>'

# 清理用的路径常量
NG_CONF_ZIP = "/usr/trim/share/.restore/ng.conf.zip"
CONF_D_DIR = "/usr/trim/nginx/conf/conf.d"
OUR_ARCNAME = "conf.d/ronglinc93widget.conf"
BACKUP_DIR = os.path.join(APP_DATA_DIR, "conf_backup")

# fnOS 自带配置白名单：清理时永不触碰，防止误删系统配置导致 Web 异常
SYSTEM_CONFS = {
    "accountsrv.conf", "auto_thumbnailer.conf", "baidu_netdisk.conf",
    "cloud_storage_dav.conf", "docker_web.conf", "download_web.conf",
    "dsmgr.conf", "file_version.conf", "fnmusic_enhance.conf", "gzip.conf",
    "html_nocache.conf", "multiple_downloads.conf", "safe_code_access.conf",
    "trim_app_center.conf", "trim_chromium.conf", "trimcon.conf",
    "trim_docs.conf", "trim_http_cgi.conf", "trim_iscsi.conf",
    "trim_license.conf", "trim_media.conf", "trim_music.conf",
    "trim_open_gateway.conf", "trim_photos.conf", "trim_sac.conf",
    "trim_seek.conf", "trim_sharelink.conf", "trim_snapshots.conf",
    "trim_sync.conf", "trim_text_editor.conf", "trim_txt_mime.conf",
    "trim_vm.conf",
}

# 注入页与脚本均由 nginx 直接 alias 提供（不经应用网关），/usr/trim/www 零修改。
# /rl93w/ 反向代理到本地后端(双栈监听 8099)，供浮层卡片拉取静态资源与目录 API。
# 因为 QWeather 不在这台机，location = / 与 /login 空闲，可安全重写（不会撞车）。
RL_NGINX_CONF = """\
# RONGLINC93 桌面小组件注入
location = /login { rewrite ^ /rl93-injected last; }
location = /      { rewrite ^ /rl93-injected last; }
location = /rl93-injected {
    alias %s;
    default_type text/html;
    add_header cache-control no-store;
}
location = /ronglinc93widget-inject.js {
    alias %s;
    default_type application/javascript;
    add_header cache-control no-store;
}
location /rl93w/ {
    proxy_pass http://127.0.0.1:8099/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
""" % (DESKTOP_INDEX, INJECT_JS_DIRECT)

INJECTOR = None
# 用小写命名：全大写会被类型检查器当作常量，重复赋值即报
# reportConstantRedefinition（本项目零类型标注，属既有噪声，但新增代码应避免）
remove_entry_fn = None
zip_contains_fn = None
try:
    from injector import (FnOSInjector, InjectorConfig,
                          remove_entry as _remove_entry,
                          zip_contains as _zip_contains)
    remove_entry_fn = _remove_entry
    zip_contains_fn = _zip_contains
    INJECTOR = FnOSInjector(InjectorConfig(
        nginx_conf_zip="/usr/trim/share/.restore/ng.conf.zip",
        conf_arcname="conf.d/ronglinc93widget.conf",
        conf_d_dir="/usr/trim/nginx/conf/conf.d",
        www_index="/usr/trim/www/index.html",
        app_data_dir=APP_DATA_DIR,
        keys_file=KEYS_FILE,
        conf_content=RL_NGINX_CONF,
        script_tag=WIDGET_SCRIPT_TAG,
    ))
except Exception:
    INJECTOR = None


# ======================================================================
# 目录读取 / 搜索
# ======================================================================
def file_kind(name: str, is_dir: bool) -> str:
    """把文件名归类成 image/video/audio/text/archive/doc/other。"""
    if is_dir:
        return "dir"
    ext = os.path.splitext(name)[1].lower()
    if ext in IMG_EXTENSIONS:
        return "image"
    if ext in VIDEO_EXTENSIONS:
        return "video"
    if ext in AUDIO_EXTENSIONS:
        return "audio"
    if ext in TEXT_EXTENSIONS:
        return "text"
    if ext in ARCHIVE_EXTENSIONS:
        return "archive"
    if ext in DOC_EXTENSIONS:
        return "doc"
    return "other"


def entry_of(name: str, full_path: str, is_dir: bool, st, extra_items=None) -> dict:
    """统一的条目结构，列表与搜索共用。"""
    items = extra_items
    if is_dir and extra_items is None:
        try:
            items = sum(1 for _ in os.scandir(full_path))
        except OSError:
            items = None
    return {
        "name": name,
        "path": full_path,
        "dir": os.path.dirname(full_path.rstrip("/\\")) or "/",
        "is_dir": is_dir,
        "size": None if is_dir else st.st_size,
        "items": items,          # 仅目录有意义
        "type": "dir" if is_dir
                else (os.path.splitext(name)[1].lower() or "file"),
        "kind": file_kind(name, is_dir),
        "mtime": st.st_mtime,
        "mtime_str": datetime.fromtimestamp(
            st.st_mtime).strftime("%Y-%m-%d %H:%M"),
    }


def list_directory(path: str):
    """列出单层目录。返回 (条目列表, 是否因超上限而被截断)。

    超大目录（上万项）会把浏览器卡住，因此超过 LIST_MAX_ENTRIES 就截断，
    由前端在状态栏提示"仅显示前 N 项，请用搜索定位"。
    """
    entries = []
    truncated = False
    with os.scandir(path) as it:
        for entry in it:
            if len(entries) >= LIST_MAX_ENTRIES:
                truncated = True
                break
            try:
                st = entry.stat()
            except OSError:
                continue
            is_dir = entry.is_dir()
            entries.append(entry_of(entry.name, entry.path, is_dir, st))
    entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
    return entries, truncated


def search_tree(root: str, kw: str, kind: str = "all",
                include_hidden: bool = False):
    """在 root 下递归按文件名搜索。

    保护：SEARCH_MAX_RESULTS 条上限、SEARCH_MAX_DEPTH 层深度、SEARCH_TIMEOUT_SEC 秒超时，
    任何一项先到就停（避免对着 /vol1 全盘扫描把服务拖死）。
    """
    kwl = (kw or "").lower()
    want = kind if kind in ("file", "dir", "image", "video", "audio",
                            "text", "archive", "doc", "other") else "all"
    base_depth = root.rstrip("/\\").count(os.sep)
    started = time.time()
    hits: list = []
    truncated = False

    def walk_error(e):     # 无权限的目录直接跳过，不让整个搜索失败
        return None

    for dirpath, dirnames, filenames in os.walk(
            root, topdown=True, onerror=walk_error, followlinks=False):
        if len(hits) >= SEARCH_MAX_RESULTS or \
                time.time() - started > SEARCH_TIMEOUT_SEC:
            truncated = True
            break
        depth = dirpath.rstrip("/\\").count(os.sep) - base_depth
        if depth >= SEARCH_MAX_DEPTH:
            dirnames[:] = []          # 到深度上限，不再往下钻
        if not include_hidden:
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]

        # 目录也算匹配目标（先按 dirnames 处理，再统一 hit）
        names = [(d, True) for d in dirnames] + [(f, False) for f in filenames]
        for name, is_dir in names:
            if not include_hidden and name.startswith("."):
                continue
            k = "dir" if is_dir else file_kind(name, False)
            if want != "all" and ((want == "file" and is_dir) or
                                  (want == "dir" and not is_dir) or
                                  (want not in ("file", "dir") and k != want)):
                continue
            if kwl and kwl not in name.lower():
                continue
            full = os.path.join(dirpath, name)
            try:
                st = os.stat(full)
            except OSError:
                continue
            hits.append(entry_of(name, full, is_dir, st, extra_items=None))
            if len(hits) >= SEARCH_MAX_RESULTS:
                truncated = True
                break
        if truncated:
            break

    hits.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
    return {
        "root": root,
        "keyword": kw or "",
        "kind": want,
        "entries": hits,
        "truncated": truncated,
        "elapsed_ms": int((time.time() - started) * 1000),
        "limit": SEARCH_MAX_RESULTS,
    }


def human_size(num) -> str:
    if num is None:
        return ""
    size = float(num)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            if unit == "B":
                return "%d %s" % (int(size), unit)
            return "%.1f %s" % (size, unit)
        size /= 1024
    return "%.1f TB" % size


def is_text_file(path: str) -> bool:
    """是否按纯文本预览：先看扩展名，再看 mimetype 前缀。"""
    ext = os.path.splitext(path)[1].lower()
    if ext in TEXT_EXTENSIONS:
        return True
    ctype, _ = mimetypes.guess_type(path)
    return bool(ctype and ctype.startswith("text/"))


def read_text_preview(path: str) -> dict:
    """读取文本文件内容做预览（限大小、多编码兜底），返回 JSON 可序列化 dict。"""
    with open(path, "rb") as f:
        raw = f.read(TEXT_PREVIEW_MAX + 1)
    truncated = len(raw) > TEXT_PREVIEW_MAX
    raw = raw[:TEXT_PREVIEW_MAX]
    for enc in ("utf-8", "gb18030", "latin-1"):
        try:
            return {"content": raw.decode(enc), "encoding": enc,
                    "truncated": truncated}
        except UnicodeDecodeError:
            continue
    return {"content": "", "encoding": "unknown", "truncated": truncated}


# ======================================================================
# HTTP 处理器
# ======================================================================
def load_settings() -> dict:
    """读取持久化设置（应用窗与桌面浮层共用同一份）。
    visible 记录用户在桌面上是否关过浮层，避免刷新后又自动弹出来。
    pos / size 记录浮层上次的位置与大小（None 表示用默认）。"""
    data = {"path": "", "root": "", "visible": True, "pos": None, "size": None,
            "dir_min": False,
            "calendar_visible": True, "calendar_pos": None, "calendar_size": None,
            "calendar_notes": {}, "calendar_min": False,
            "weather_visible": True, "weather_pos": None, "weather_size": None,
            "weather_location": "", "weather_min": False,
            "notes_visible": True, "notes_pos": None, "notes_size": None,
            "notes_min": False, "notes_pinned": False,
            "todo_visible": True, "todo_pos": None, "todo_size": None,
            "todo_min": False, "todo_pinned": False,
            "worldclock_visible": True, "worldclock_pos": None, "worldclock_size": None,
            "worldclock_min": False, "worldclock_pinned": False,
            "worldclock_cities": [{"name": "本地", "tz": ""}],
            "monitor_visible": True, "monitor_pos": None, "monitor_size": None,
            "monitor_min": False, "monitor_pinned": False}
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            data.update(json.loads(f.read() or "{}"))
    except Exception:
        pass
    return data


def _norm(p: str) -> str:
    return os.path.normpath(str(p)).rstrip("/\\") or "/"


def within_root(path: str, root: str) -> bool:
    """判断 path 是否在 root（主目录）之内。root 为空表示不限制。"""
    if not root:
        return True
    p, r = _norm(path), _norm(root)
    return p == r or p.startswith(r + os.sep)


def save_settings(data: dict) -> bool:
    try:
        os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            f.write(json.dumps(data, ensure_ascii=False))
        return True
    except Exception:
        return False


# ======================================================================
# 便签 / 待办清单 的内容存储（与 settings.json 分文件，避免单文件过大）
# ======================================================================
NOTE_COLORS = ["#fff3a3", "#c8f7c5", "#a3d8ff", "#ffc9de", "#e3c8ff", "#ffe0b3"]
MAX_NOTE_LEN = 2000
MAX_TODO_LEN = 500
MAX_ITEMS = 100


def _safe_id() -> str:
    import uuid
    return uuid.uuid4().hex[:12]


def load_notes() -> list:
    try:
        with open(NOTES_FILE, "r", encoding="utf-8") as f:
            d = json.loads(f.read() or "{}")
        notes = d.get("notes") if isinstance(d, dict) else None
        return notes if isinstance(notes, list) else []
    except Exception:
        return []


def save_notes(notes: list) -> bool:
    try:
        os.makedirs(os.path.dirname(NOTES_FILE), exist_ok=True)
        with open(NOTES_FILE, "w", encoding="utf-8") as f:
            f.write(json.dumps({"notes": notes}, ensure_ascii=False))
        return True
    except Exception:
        return False


def load_todos() -> list:
    try:
        with open(TODOS_FILE, "r", encoding="utf-8") as f:
            d = json.loads(f.read() or "{}")
        todos = d.get("todos") if isinstance(d, dict) else None
        return todos if isinstance(todos, list) else []
    except Exception:
        return []


def save_todos(todos: list) -> bool:
    try:
        os.makedirs(os.path.dirname(TODOS_FILE), exist_ok=True)
        with open(TODOS_FILE, "w", encoding="utf-8") as f:
            f.write(json.dumps({"todos": todos}, ensure_ascii=False))
        return True
    except Exception:
        return False


def _pos_of(p: Any) -> Any:
    if isinstance(p, dict):
        return {"left": int(p.get("left", 0) or 0), "top": int(p.get("top", 0) or 0)}
    return None


def _size_of(s: Any) -> Any:
    if isinstance(s, dict):
        return {"width": int(s.get("width", 0) or 0), "height": int(s.get("height", 0) or 0)}
    return None


def merge_widget_box(cur: dict, prefix: str, payload: dict) -> None:
    """把组件提交的明文 box 字段（visible/pos/size/min/pinned）合并进 cur 的
    `<prefix>_*` 键。各组件用各自独立的设置端点，绝不往 /api/settings 发明文，
    避免与目录浮层的 dir_min/pos/size 冲突。"""
    if "visible" in payload:
        cur[prefix + "_visible"] = bool(payload.get("visible"))
    if "pos" in payload:
        cur[prefix + "_pos"] = _pos_of(payload.get("pos"))
    if "size" in payload:
        cur[prefix + "_size"] = _size_of(payload.get("size"))
    if "min" in payload:
        cur[prefix + "_min"] = bool(payload.get("min"))
    if "pinned" in payload:
        cur[prefix + "_pinned"] = bool(payload.get("pinned"))


def widget_box_response(st: dict, prefix: str, extra: dict | None = None) -> dict:
    resp = {
        "visible": st.get(prefix + "_visible", True),
        "pos": st.get(prefix + "_pos"),
        "size": st.get(prefix + "_size"),
        "min": st.get(prefix + "_min", False),
        "pinned": st.get(prefix + "_pinned", False),
    }
    if extra:
        resp.update(extra)
    return resp


def handle_widget_settings(self, parsed: Any, prefix: str,
                           extra_payload=None, extra_response=None) -> bool:
    """通用组件设置端点：GET 返回 box 状态，POST 合并明文 box 字段到
    settings.json 的 <prefix>_* 键。extra_payload/extra_response 用于附加字段
    （如 worldclock 的城市列表）。"""
    if self.command == "POST":
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            payload = {}
        cur = load_settings()
        merge_widget_box(cur, prefix, payload)
        if extra_payload:
            extra_payload(cur, payload)
        ok = save_settings(cur)
        st = load_settings()
        resp = widget_box_response(st, prefix)
        if extra_response:
            extra_response(resp, st)
        self._send_json({"status": "success" if ok else "error", "settings": resp},
                        200 if ok else 500)
        return True
    st = load_settings()
    resp = widget_box_response(st, prefix)
    if extra_response:
        extra_response(resp, st)
    self._send_json({"settings": resp})
    return True


def _read_sysfs(path, cast: type = int):
    try:
        with open(path) as f:
            return cast(f.read().strip())
    except Exception:
        return None


def _disk_model(dev_path):
    """hwmon 设备目录 → 硬盘型号名。drivetemp/NVMe 的 hwmon 挂在盘设备节点下，
    device/model 即型号（如 "Samsung SSD 870 EVO 1TB"）；取不到时回退块设备名（sda）。"""
    model = _read_sysfs(os.path.join(dev_path, "model"), cast=str)
    if model:
        model = re.sub(r"\s+", " ", model).strip()
        if model:
            return model
    try:
        real = os.path.realpath(dev_path)
        blk = "/sys/class/block"
        if os.path.isdir(blk):
            for b in sorted(os.listdir(blk)):
                if os.path.realpath(os.path.join(blk, b, "device")) == real:
                    return b
    except Exception:
        pass
    return None


def _cn_temp_name(name):
    """把 Linux 温度传感器名（/sys/class/thermal type、hwmon 的 name/label，多为英文）
    尽力翻译成中文；认不出的保留原样，不丢信息。"""
    n = (name or "").strip()
    low = n.lower()
    m = re.search(r"package id (\d+)", low)
    if m:
        return "CPU 封装" + ("" if m.group(1) == "0" else " " + m.group(1))
    m = re.search(r"core (\d+)", low)
    if m:
        return "CPU 核心 " + m.group(1)
    m = re.search(r"dimm(\d+)", low)
    if m:
        return "内存 Dimm" + m.group(1)
    m = re.search(r"^sensor\s*(\d+)$", low)
    if m:
        return "传感器 " + m.group(1)
    table = [
        ("pkg", "CPU 封装"), ("x86_pkg", "CPU 封装"),
        ("k10temp", "CPU"), ("coretemp", "CPU"),
        ("tctl", "CPU"), ("tdie", "CPU 裸片"), ("tccd", "CPU CCD"),
        ("acpitz", "主板"), ("systin", "主板"), ("cputin", "CPU"),
        ("cpuvin", "CPU"),
        ("pch", "芯片组 PCH"), ("aux", "主板辅助"), ("peci", "PECI 总线"),
        ("composite", "NVMe 硬盘"), ("nvme", "NVMe 硬盘"), ("ssd", "硬盘"),
        ("drivetemp", "硬盘温度"),
        ("nct", "主板"), ("w83795", "主板"), ("it86", "主板"), ("f718", "主板"),
        ("iwlwifi", "无线网卡"), ("ath", "无线网卡"), ("rtl", "网卡"),
        ("gpu", "显卡"), ("amdgpu", "显卡"), ("nvidia", "显卡"),
        ("i915", "核显"), ("xe", "核显"),
        ("vrm", "供电模块"), ("soc", "SoC"), ("apu", "APU"),
        ("battery", "电池"), ("thermal_zone", "传感器"),
    ]
    for key, cn in table:
        if key in low:
            return cn
    return n


def _temp_group(cn):
    """把中文化后的温度名归类到一级分组（CPU/主板/硬盘/显卡/…），用于前端分组显示。
    认不出归「其它」，不丢信息。"""
    low = (cn or "").lower()
    if "cpu" in low:
        return "CPU"
    if "nvme" in low or "硬盘" in low:
        return "硬盘"
    if "核显" in cn or "显卡" in cn:
        return "显卡"
    if "网卡" in cn:
        return "网卡"
    if "内存" in cn or "dimm" in low:
        return "内存"
    if "电池" in cn:
        return "电池"
    if "主板" in cn or "pch" in low or "peci" in low:
        return "主板"
    return "其它"


def get_temps() -> list:
    """采集所有温度传感器（/sys/class/thermal + hwmon），返回 [{name, temp(°C), group}]。
    name 经 _cn_temp_name 尽力中文化（如 Tdie→CPU 裸片、nvme→NVMe 硬盘）；
    group 为一级分类（CPU/主板/硬盘/显卡/…，用于前端分组显示）。"""
    temps = []
    try:
        base = "/sys/class/thermal"
        if os.path.isdir(base):
            for z in sorted(os.listdir(base)):
                if not z.startswith("thermal_zone"):
                    continue
                zp = os.path.join(base, z)
                name = _read_sysfs(os.path.join(zp, "type"), cast=str) or z
                mv = _read_sysfs(os.path.join(zp, "temp"))
                if mv is not None:
                    cn = _cn_temp_name(name)
                    temps.append({"name": cn, "temp": round(mv / 1000.0, 1), "group": _temp_group(cn)})
    except Exception:
        pass
    try:
        hbase = "/sys/class/hwmon"
        if os.path.isdir(hbase):
            for hw in sorted(os.listdir(hbase)):
                hwp = os.path.join(hbase, hw)
                hname = _read_sysfs(os.path.join(hwp, "name"), cast=str) or hw
                for f in sorted(os.listdir(hwp)):
                    if not re.match(r"^temp\d+_input$", f):
                        continue
                    mv = _read_sysfs(os.path.join(hwp, f))
                    if mv is None:
                        continue
                    labf = f.replace("_input", "_label")
                    label = _read_sysfs(os.path.join(hwp, labf), cast=str) if os.path.exists(os.path.join(hwp, labf)) else ""
                    nm = label or ("%s %s" % (hname, f.split("_")[0]))
                    cn = _cn_temp_name(nm)
                    # 硬盘传感器补充具体型号：drivetemp/NVMe 的 hwmon 挂在盘设备下，
                    # device/model 即型号名；label 本身已含型号时不重复追加
                    if "硬盘" in cn:
                        model = _disk_model(os.path.join(hwp, "device"))
                        if model and model.lower() not in cn.lower():
                            cn = "%s %s" % (cn, model)
                    temps.append({"name": cn, "temp": round(mv / 1000.0, 1), "group": _temp_group(cn)})
    except Exception:
        pass
    # 剔除明显无效的读数：传感器未接 / 读数失败时内核常报 -128°C 量级的哨兵值
    return [t for t in temps if t["temp"] > -100]


def get_fans() -> list:
    """采集所有风扇转速（hwmon fan*_input，单位 RPM），返回 [{name, rpm}]。"""
    fans = []
    try:
        hbase = "/sys/class/hwmon"
        if os.path.isdir(hbase):
            for hw in sorted(os.listdir(hbase)):
                hwp = os.path.join(hbase, hw)
                hname = _read_sysfs(os.path.join(hwp, "name"), cast=str) or hw
                for f in sorted(os.listdir(hwp)):
                    if not re.match(r"^fan\d+_input$", f):
                        continue
                    rpm = _read_sysfs(os.path.join(hwp, f))
                    if rpm is None:
                        continue
                    labf = f.replace("_input", "_label")
                    label = _read_sysfs(os.path.join(hwp, labf), cast=str) if os.path.exists(os.path.join(hwp, labf)) else ""
                    nm = label or ("%s %s" % (hname, f.split("_")[0]))
                    fans.append({"name": _cn_fan_name(nm), "rpm": rpm})
    except Exception:
        pass
    return fans


def _cn_fan_name(name):
    """把 hwmon 风扇名尽力中文化：fan1→风扇 1，芯片名(如 nct6798)→主板。"""
    n = (name or "").strip()
    m = re.search(r"fan(\d+)", n, re.IGNORECASE)
    if m:
        chip = re.sub(r"fan\d+", "", n, flags=re.IGNORECASE).strip()
        chip = re.sub(r"[\d]+$", "", chip).strip().lower()  # 去尾随数字：nct6798→nct
        chip_cn = {"nct": "主板", "w83795": "主板", "it86": "主板", "it87": "主板",
                   "f718": "主板", "amdgpu": "显卡", "nvidia": "显卡",
                   "coretemp": "CPU", "k10temp": "CPU"}
        cn = chip_cn.get(chip)
        if cn is None:  # 前缀兜底：it8688e→it86→主板
            for k, v in chip_cn.items():
                if chip.startswith(k):
                    cn = v
                    break
        return ("%s 风扇 %s" % (cn, m.group(1))) if cn else ("风扇 " + m.group(1))
    return n


def get_gpus() -> list:
    """采集显卡。以 /sys/class/drm/card* 为权威 GPU 清单（内核为每块 GPU 建一个 card 节点，
    集成显卡 / 独显都在——hwmon 关键字过滤会漏掉 Intel 核显）；nvidia-smi 只作 N 卡的
    使用率 / 温度 / 型号名数据填充（DRM 给不出这些，按厂商匹配、卡序对应）。"""
    PCI_VENDORS = {"0x8086": "Intel", "0x10de": "NVIDIA", "0x1002": "AMD", "0x1022": "AMD"}

    # 1) nvidia-smi：N 卡的型号名 / 使用率 / 温度（多卡逐行）
    nvlist = []
    try:
        nv = shutil.which("nvidia-smi")
        if nv:
            out = subprocess.run(
                [nv, "--query-gpu=name,utilization.gpu,temperature.gpu",
                 "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=2).stdout
            for line in out.strip().splitlines():
                parts = [p.strip() for p in line.split(",")]
                if len(parts) < 3:
                    continue
                def _num(x):
                    try:
                        return float(x)
                    except Exception:
                        return None
                nvlist.append({"name": parts[0], "usage": _num(parts[1]), "temp": _num(parts[2])})
    except Exception:
        pass

    # 2) DRM card 枚举全部 GPU（card0/card1/...；过滤 renderD*、card0-DP-1 等连接器节点）
    cards = []
    try:
        base = "/sys/class/drm"
        if os.path.isdir(base):
            for card in sorted(os.listdir(base)):
                if not re.match(r"^card\d+$", card):
                    continue
                cdev = os.path.join(base, card, "device")
                vendor = (_read_sysfs(os.path.join(cdev, "vendor"), cast=str) or "").strip().lower()
                if not vendor.startswith("0x"):
                    continue  # 非 PCI 设备（虚拟卡等）
                # 温度：该卡设备下的 hwmon（N/A 时保留为 None）
                temp = None
                hwdir = os.path.join(cdev, "hwmon")
                if os.path.isdir(hwdir):
                    for hw in sorted(os.listdir(hwdir)):
                        hwp = os.path.join(hwdir, hw)
                        try:
                            files = os.listdir(hwp)
                        except Exception:
                            continue
                        for f in sorted(files):
                            if re.match(r"^temp\d+_input$", f):
                                mv = _read_sysfs(os.path.join(hwp, f))
                                if mv is not None:
                                    temp = round(mv / 1000.0, 1)
                                    break
                        if temp is not None:
                            break
                # 使用率：amdgpu 暴露 gpu_busy_percent，其它驱动一般没有
                usage = None
                busy = _read_sysfs(os.path.join(cdev, "gpu_busy_percent"))
                if busy is not None:
                    try:
                        usage = float(busy)
                    except Exception:
                        usage = None
                cards.append({"card": card, "vendor": vendor, "temp": temp, "usage": usage})
    except Exception:
        pass

    # 3) 合并：NVIDIA 卡按卡序填充 nvidia-smi 数据（带真实型号名），其余厂商用通用名
    gpus = []
    nvi = 0
    for c in cards:
        if c["vendor"] == "0x10de" and nvi < len(nvlist):
            nv = nvlist[nvi]
            nvi += 1
            gpus.append({"name": nv["name"], "usage": nv["usage"], "temp": nv["temp"]})
        else:
            vname = PCI_VENDORS.get(c["vendor"], "GPU")
            gpus.append({"name": "%s 显卡 (%s)" % (vname, c["card"]),
                         "usage": c["usage"], "temp": c["temp"]})
    # nvidia-smi 有、DRM 却没枚举到的（罕见），追加以免丢卡
    while nvi < len(nvlist):
        nv = nvlist[nvi]
        nvi += 1
        gpus.append(nv)
    return gpus


def get_disks() -> list:
    """枚举所有本地磁盘 / 卷（解析 /proc/mounts，剔除伪文件系统），返回
    [{path, fstype, total, used, free, percent}]。NAS 多卷（/vol1、/vol2、系统盘 /）都会列出，
    而非仅取其一。"""
    PSEUDO_FS = {
        "proc", "sysfs", "devtmpfs", "devpts", "cgroup", "cgroup2", "pstore",
        "bpf", "configfs", "debugfs", "tracefs", "securityfs", "mqueue",
        "hugetlbfs", "fusectl", "binfmt_misc", "autofs", "ramfs", "tmpfs",
        "overlay", "rpc_pipefs", "nsfs", "efivarfs", "squashfs", "fuse",
        "fuse.gvfsd-fuse", "fuse.sshfs", "proc", "sysctl",
    }
    VIRT_MP = {"/dev", "/proc", "/sys", "/run", "/run/shm", "/sys/fs/cgroup"}
    disks = []
    seen = []
    try:
        with open("/proc/mounts") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) < 3:
                    continue
                device, mp, fstype = parts[0], parts[1], parts[2]
                if fstype in PSEUDO_FS:
                    continue
                if mp in VIRT_MP:
                    continue
                # 只收真实块设备挂载（/dev/*）；zfs 等 device 形如 rpool/... 也允许
                if not (device.startswith("/dev/") or fstype == "zfs"):
                    continue
                try:
                    st = os.statvfs(mp)
                except Exception:
                    continue
                total = st.f_blocks * st.f_frsize
                if total <= 0:
                    continue
                free = st.f_bavail * st.f_frsize
                used = total - free
                pct = round(used / total * 100, 1) if total > 0 else 0.0
                # 跳过嵌套挂载（如 /vol1 下的子卷），只保留顶层
                if any(mp == s or mp.startswith(s + "/") for s in seen):
                    continue
                # /proc/mounts 路径是八进制转义（空格->\040），还原成可读路径
                mp = mp.replace("\\040", " ")
                seen.append(mp)
                disks.append({
                    "path": mp, "fstype": fstype,
                    "total": total, "used": used, "free": free, "percent": pct,
                })
        # 排序：/vol 卷在前、/ 放最后，稳定可读
        disks.sort(key=lambda d: (not d["path"].startswith("/vol"), d["path"]))
    except Exception:
        pass
    return disks


def get_monitor_stats() -> dict:
    """读取宿主机 CPU/内存/磁盘/运行时间/温度/风扇/显卡。仅 Linux（fnOS）可取；/proc 不可读或
    非 Linux 时返回 ok:false，前端据此显示「不可用」，不报错。"""
    if not os.path.exists("/proc/stat"):
        return {"ok": False, "reason": "unsupported"}
    try:
        def cpu_sample():
            with open("/proc/stat") as f:
                parts = f.readline().split()
            vals = [int(x) for x in parts[1:] if x.isdigit()]
            return sum(vals), sum(vals[3:])  # total, idle
        t1, i1 = cpu_sample()
        time.sleep(0.2)
        t2, i2 = cpu_sample()
        cpu = 0.0 if (t2 - t1) <= 0 else round((1 - (i2 - i1) / (t2 - t1)) * 100, 1)

        # CPU 型号：取 /proc/cpuinfo 首个 model name，去重并压缩空白
        cpu_model = ""
        try:
            models = set()
            with open("/proc/cpuinfo") as f:
                for line in f:
                    k, _, v = line.partition(":")
                    if k.strip() == "model name" and v.strip():
                        models.add(re.sub(r"\s+", " ", v).strip())
            if models:
                cpu_model = " / ".join(sorted(models))
        except Exception:
            cpu_model = ""

        mem = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, _, v = line.partition(":")
                v = v.strip().split()
                if len(v) >= 1 and v[0].isdigit():
                    mem[k.strip()] = int(v[0]) * 1024  # KB -> 字节
        total = mem.get("MemTotal", 0)
        avail = mem.get("MemAvailable", mem.get("MemFree", 0))
        mem_used = max(0, total - avail)
        mem_pct = 0.0 if total <= 0 else round(mem_used / total * 100, 1)

        disks = get_disks()
        # 兼容旧字段：取主数据盘（/vol1 优先，否则任意 /vol*，否则 /，否则首盘）
        disk = (next((d for d in disks if d["path"] == "/vol1"), None)
                or next((d for d in disks if d["path"].startswith("/vol")), None)
                or next((d for d in disks if d["path"] == "/"), None)
                or (disks[0] if disks else None))

        uptime = 0.0
        try:
            with open("/proc/uptime") as f:
                uptime = float(f.readline().split()[0])
        except Exception:
            uptime = 0.0

        return {
            "ok": True,
            "cpu": cpu,
            "cpu_model": cpu_model,
            "mem": {"total": total, "used": mem_used, "available": avail,
                    "percent": mem_pct},
            "disks": disks,
            "disk": disk,
            "temps": get_temps(),
            "fans": get_fans(),
            "gpus": get_gpus(),
            "uptime": uptime,
        }
    except Exception as e:
        return {"ok": False, "reason": "error", "message": str(e)}


def _nginx_restart() -> bool:
    """重启 nginx 使 conf.d 变更生效。注意：必须先改 ng.conf.zip，
    否则 trim_recover 会在重启时把刚删掉的配置又恢复出来。"""
    try:
        subprocess.run("systemctl restart trim_nginx", shell=True,
                       timeout=60, capture_output=True)
        return True
    except Exception:
        return False


def _deferred_nginx_restart(delay: int = 5) -> None:
    """后台延迟重启 nginx。

    Why：卸载/配置请求本身是经 nginx(5666/5667) 下发的，若在处理请求的
    同时同步重启 nginx，会把正在进行的请求掐断，浏览器报 "Failed to fetch"。
    因此改为"先返回响应、几秒后再重启"。"""
    try:
        subprocess.Popen(
            ["bash", "-c", "sleep %d; systemctl restart trim_nginx" % delay],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True)
    except Exception:
        pass


def _app_installed(stem: str) -> bool:
    """根据 conf 文件名主干判断对应应用是否仍处于安装状态。
    例：qweather.conf -> 匹配 /var/apps/com.qweather.widget"""
    base = "/var/apps"
    try:
        for d in os.listdir(base):
            if stem and stem in d:
                return True
    except Exception:
        pass
    return False


def detect_live_conflicts() -> list:
    """找出「仍在安装状态」且劫持 location = / 的其它注入器。
    与它们共存必然 duplicate location 崩溃，因此注入前必须先发现它们。"""
    live = []
    try:
        names = sorted(os.listdir(CONF_D_DIR))
    except Exception:
        return live
    for name in names:
        if not name.endswith(".conf") or name in SYSTEM_CONFS:
            continue
        if ("conf.d/" + name) == OUR_ARCNAME:
            continue
        path = os.path.join(CONF_D_DIR, name)
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                text = f.read()
        except Exception:
            continue
        if not re.search(r"location\s*=\s*/", text):
            continue
        if _app_installed(name[:-5]):
            live.append(name)
    return live


def cleanup_conflicts(include_ours: bool = False) -> list:
    """清理会劫持 `location = /` 的其它注入配置（运行时 conf.d + zip 加密条目）。

    Why: 应用卸载时若不清注入（本项目旧版、QWeather 都会如此），残留配置会永久
    占用 location = /；再有注入器进来就 duplicate location → nginx 起不来 → Web 宕。
    在「程序启动」和「注入前」先跑一次，即可自愈，避免撞车。

    默认不动我们自己的配置（include_ours=False），保证重启后桌面浮层仍然在。
    返回被清理的条目名列表。
    """
    removed = []
    try:
        names = sorted(os.listdir(CONF_D_DIR))
    except Exception:
        return removed

    for name in names:
        if not name.endswith(".conf"):
            continue
        if name in SYSTEM_CONFS:
            continue
        arcname = "conf.d/" + name
        if arcname == OUR_ARCNAME and not include_ours:
            continue
        path = os.path.join(CONF_D_DIR, name)
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                text = f.read()
        except Exception:
            continue
        # 只处理确实劫持根路径的配置，绝不碰 fnOS 自带配置
        if not re.search(r"location\s*=\s*/", text):
            continue
        # 只清理"孤儿"残留（对应应用已卸载）。仍处于安装状态的注入器不动：
        # 它的维护线程会立刻写回，我们删它写会反复打架并引发 nginx 重启风暴。
        if _app_installed(name[:-5]):
            continue
        # 删除前先备份，误删时可还原
        try:
            os.makedirs(BACKUP_DIR, exist_ok=True)
            shutil.copy2(path, os.path.join(BACKUP_DIR, name))
        except Exception:
            pass
        try:
            os.remove(path)
            removed.append(arcname)
        except Exception:
            pass
        try:
            if (zip_contains_fn is not None and remove_entry_fn is not None
                    and zip_contains_fn(NG_CONF_ZIP, arcname)):
                remove_entry_fn(NG_CONF_ZIP, arcname)
                removed.append(arcname + " (zip)")
        except Exception:
            pass
    return removed


def _nginx_listening() -> bool:
    """飞牛 Web 是否真的在监听 5666（崩溃时这里会是 False）。"""
    try:
        r = subprocess.run(
            "ss -ltn 2>/dev/null | grep -q ':5666 '", shell=True, timeout=10)
        return r.returncode == 0
    except Exception:
        return False


def _hijackers() -> list:
    """列出所有劫持 location = / 的第三方注入配置（含是否仍安装）。"""
    out = []
    try:
        names = sorted(os.listdir(CONF_D_DIR))
    except Exception:
        return out
    for name in names:
        if not name.endswith(".conf") or name in SYSTEM_CONFS:
            continue
        path = os.path.join(CONF_D_DIR, name)
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                text = f.read()
        except Exception:
            continue
        if not re.search(r"location\s*=\s*/", text):
            continue
        arcname = "conf.d/" + name
        out.append({
            "name": name,
            "ours": arcname == OUR_ARCNAME,
            "installed": _app_installed(name[:-5]),
            "in_zip": bool(zip_contains_fn
                           and zip_contains_fn(NG_CONF_ZIP, arcname)),
        })
    return out


def diagnose() -> dict:
    """体检：Web 是否可用、有几份 location = /、谁是冲突方。"""
    hs = _hijackers()
    foreign = [h for h in hs if not h["ours"]]
    return {
        "web_ok": _nginx_listening(),
        "duplicate": len(hs) > 1,
        "hijackers": hs,
        "ours_present": any(h["ours"] for h in hs),
        "live_conflicts": [h["name"] for h in foreign if h["installed"]],
        "orphans": [h["name"] for h in foreign if not h["installed"]],
        "settings": load_settings(),
    }


def rescue() -> dict:
    """一键急救：修掉 duplicate location 导致的 nginx 崩溃。

    步骤（顺序不可调换）：
      1) 先杀掉其它注入器的进程 —— 否则它的维护线程会立刻把配置写回来；
      2) 删除它们的 conf.d 文件（先备份）+ ng.conf.zip 加密条目 —— 只删 conf.d
         会被 trim_recover 在重启时恢复，崩溃必然复发；
      3) 重启 nginx 并复查 5666 是否恢复监听。
    """
    # 显式标注：避免值被推断成 bool | list 联合类型，导致 .append 误报
    report: Dict[str, Any] = {
        "web_ok_before": _nginx_listening(),
        "killed": [], "removed": [], "restarted": False,
    }
    try:
        os.makedirs(BACKUP_DIR, exist_ok=True)
    except Exception:
        pass

    foreign = [h for h in _hijackers() if not h["ours"]]
    # 1) 停进程
    for h in foreign:
        stem = h["name"][:-5]
        if not stem:
            continue
        try:
            subprocess.run("pkill -9 -f '%s'" % stem, shell=True, timeout=15)
            report["killed"].append(stem)
        except Exception:
            pass
    # 2) 删配置（conf.d 备份后删除 + zip 条目）
    for h in foreign:
        name = h["name"]
        arcname = "conf.d/" + name
        path = os.path.join(CONF_D_DIR, name)
        try:
            shutil.copy2(path, os.path.join(BACKUP_DIR, name))
        except Exception:
            pass
        try:
            os.remove(path)
            report["removed"].append(arcname)
        except Exception:
            pass
        try:
            if (zip_contains_fn is not None and remove_entry_fn is not None
                    and zip_contains_fn(NG_CONF_ZIP, arcname)):
                remove_entry_fn(NG_CONF_ZIP, arcname)
                report["removed"].append(arcname + " (zip)")
        except Exception:
            pass

    # 3) 重启并复查
    _nginx_restart()
    time.sleep(8)
    report["restarted"] = True
    report["web_ok_after"] = _nginx_listening()
    report["diagnose_after"] = diagnose()
    return report


class DirHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send_json(self, obj, code: int = 200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_file(self, path: str, ctype=None):
        if not os.path.isfile(path):
            self.send_error(404)
            return
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            self.send_error(404)
            return
        if ctype is None:
            ctype, _ = mimetypes.guess_type(path)
        self.send_response(200)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _send_file_content(self, path: str, download: bool = False):
        """返回文件内容。支持断点续传（Range），视频/音频才能拖动进度条。
        download=True 时用 Content-Disposition: attachment 触发浏览器下载。"""
        try:
            size = os.stat(path).st_size
        except OSError:
            self.send_error(404)
            return

        ctype, _ = mimetypes.guess_type(path)
        if ctype is None:
            ctype = "application/octet-stream"
        # 文本类带上 charset，浏览器内联打开才不会乱码
        if is_text_file(path) and ctype.startswith("text/"):
            ctype += "; charset=utf-8"

        status = 200
        start, end = 0, size - 1
        rng = self.headers.get("Range") if self.headers else None
        if rng and size:
            m = re.match(r"bytes=(\d*)-(\d*)", rng.strip())
            if m:
                if m.group(1):
                    start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), size - 1)
                if start >= size or end < start or start < 0:
                    self.send_response(416)
                    self.send_header("Content-Range", "bytes */%d" % size)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status = 206
        length = end - start + 1

        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range",
                             "bytes %d-%d/%d" % (start, end, size))
        if download:
            fname = quote(os.path.basename(path))
            self.send_header(
                "Content-Disposition",
                "attachment; filename*=UTF-8''%s" % fname)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        if self.command == "HEAD":
            return
        try:
            with open(path, "rb") as f:
                f.seek(start)
                left = length
                while left > 0:
                    chunk = f.read(min(65536, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            return   # 客户端取消（关预览 / 快进拖动），正常现象

    def do_GET(self):
        parsed = urlparse(self.path)
        # 兼容 fnOS 应用网关：桌面小组件 iframe 可能经 /app/<appname>/ 前缀访问
        if parsed.path.startswith(GATEWAY_PREFIX):
            stripped = parsed.path[len(GATEWAY_PREFIX):]
            parsed = parsed._replace(path=stripped or "/")
        qs = parse_qs(parsed.query)

        if parsed.path == API_BASE:
            path = qs.get("path", [None])[0]
            if not path:
                self._send_json({"error": "缺少 path 参数"}, 400)
                return
            path = unquote(path)
            # 主目录边界：设置的路径必须属于主目录，不允许向上越界
            root = load_settings().get("root", "")
            if not within_root(path, root):
                self._send_json({"path": path,
                                 "error": "路径超出主目录范围（%s），无法访问" % root},
                                403)
                return
            if not os.path.isdir(path):
                self._send_json(
                    {"path": path, "error": "目录不存在或不是文件夹"}, 404)
                return
            try:
                entries, truncated = list_directory(path)
            except PermissionError:
                self._send_json(
                    {"path": path, "error": "无权限访问该目录"}, 403)
                return
            self._send_json({"path": path, "entries": entries,
                             "truncated": truncated,
                             "limit": LIST_MAX_ENTRIES})
            return

        # ===== 递归搜索（按文件名，可筛类型）=====
        # GET /api/search?path=<起始目录>&kw=<关键字>&kind=<all|dir|file|image|video|audio|text|archive|doc>&hidden=1
        if parsed.path == API_SEARCH:
            root = unquote(qs.get("path", [None])[0] or "")
            if not root:
                self._send_json({"error": "缺少 path 参数"}, 400)
                return
            root = unquote(root)
            if not within_root(root, load_settings().get("root", "")):
                self._send_json(
                    {"path": root,
                     "error": "路径超出主目录范围，无法搜索"}, 403)
                return
            if not os.path.isdir(root):
                self._send_json({"path": root, "error": "目录不存在"}, 404)
                return
            kw = unquote(qs.get("kw", [""])[0] or "")
            if not kw and qs.get("kind", ["all"])[0] == "all":
                self._send_json(
                    {"path": root, "error": "请输入关键字或选择文件类型"}, 400)
                return
            kind = qs.get("kind", ["all"])[0] or "all"
            hidden = bool(qs.get("hidden", [None])[0])
            try:
                self._send_json(search_tree(root, kw, kind, hidden))
            except PermissionError:
                self._send_json({"path": root, "error": "无权限搜索该目录"}, 403)
            return

        if parsed.path == "/health":
            self._send_json({"status": "ok"})
            return

        # ===== 文件预览 / 下载 =====
        # GET /api/file?path=<文件>              内联（图片/视频/音频直接播）
        # GET /api/file?path=<文件>&dl=1         下载（Content-Disposition）
        # GET /api/file?path=<文件>&mode=text    返回文件内容 JSON（文本预览）
        # 受主目录边界约束，与 /api/list 同一套校验。
        if parsed.path == API_FILE:
            path = qs.get("path", [None])[0]
            if not path:
                self._send_json({"error": "缺少 path 参数"}, 400)
                return
            path = unquote(path)
            root = load_settings().get("root", "")
            if not within_root(path, root):
                self._send_json(
                    {"path": path,
                     "error": "路径超出主目录范围（%s），无法访问" % root}, 403)
                return
            if not os.path.isfile(path):
                self._send_json({"path": path, "error": "文件不存在"}, 404)
                return
            try:
                if qs.get("mode", [None])[0] == "text":
                    info = read_text_preview(path)
                    info.update({"path": path, "size": human_size(
                        os.stat(path).st_size)})
                    self._send_json(info)
                    return
                self._send_file_content(
                    path, download=bool(qs.get("dl", [None])[0]))
            except PermissionError:
                self._send_json({"path": path, "error": "无权限读取该文件"}, 403)
            except OSError as e:
                self._send_json(
                    {"path": path, "error": "读取失败：%s" % e.strerror}, 500)
            return

        # 桌面入口
        if parsed.path in ("/", "/index.html"):
            self._send_file(os.path.join(UI_DIR, "index.html"),
                            "text/html; charset=utf-8")
            return

        # 静态资源（限定在 STATIC_DIR 内）
        if parsed.path.startswith("/static/"):
            rel = parsed.path[len("/static/"):].lstrip("/")
            full = os.path.normpath(os.path.join(STATIC_DIR, rel))
            if os.path.abspath(full).startswith(os.path.abspath(STATIC_DIR)):
                self._send_file(full)
            else:
                self.send_error(403)
            return

        # 演示页便捷访问：根路径下直接请求 *-widget.html 时，301 重定向到 /static/ 下同名文件。
        # 必须用重定向而非直接读取：演示页用相对路径引用 widget-shell.js/css，直接读取会让
        # 这些相对资源解析到根路径（如 /widget-shell.js）而 404，导致组件整段无法挂载
        # （之前便签演示页“点击新建没反应”即此原因：外壳脚本没加载，RLShell 未定义）。
        if parsed.path.endswith("-widget.html"):
            sep = parsed.path.rfind("/")
            target = parsed.path[:sep] + "/static" + parsed.path[sep:]
            self.send_response(301)
            self.send_header("Location", target)
            self.end_headers()
            return

        # ===== 目录路径设置（应用窗口写、桌面浮层读，落盘到应用数据目录）=====
        if parsed.path == "/api/settings":
            if self.command == "POST":
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    payload = json.loads(raw.decode("utf-8") or "{}")
                except Exception:
                    payload = {}
                cur = load_settings()
                # 只合并请求里实际带过来的字段，避免单独改一项时把另一项覆盖掉
                if "path" in payload:
                    cur["path"] = str(payload.get("path") or "")
                if "root" in payload:
                    cur["root"] = str(payload.get("root") or "")
                if "visible" in payload:
                    cur["visible"] = bool(payload.get("visible"))
                if "pinned" in payload:
                    cur["pinned"] = bool(payload.get("pinned"))
                if "min" in payload:
                    cur["dir_min"] = bool(payload.get("min"))
                if "pos" in payload:
                    p = payload.get("pos")
                    if isinstance(p, dict):
                        cur["pos"] = {"left": int(p.get("left", 0) or 0),
                                      "top": int(p.get("top", 0) or 0)}
                    elif p is None:
                        cur["pos"] = None
                if "size" in payload:
                    s = payload.get("size")
                    if isinstance(s, dict):
                        cur["size"] = {
                            "width": int(s.get("width", 0) or 0),
                            "height": int(s.get("height", 0) or 0),
                        }
                    elif s is None:
                        cur["size"] = None
                # 日历组件独立开关（与目录浏览器浮层互不干扰）
                if "calendar_visible" in payload:
                    cur["calendar_visible"] = bool(payload.get("calendar_visible"))
                if "calendar_pos" in payload:
                    p = payload.get("calendar_pos")
                    if isinstance(p, dict):
                        cur["calendar_pos"] = {"left": int(p.get("left", 0) or 0),
                                               "top": int(p.get("top", 0) or 0)}
                    elif p is None:
                        cur["calendar_pos"] = None
                if "calendar_size" in payload:
                    s = payload.get("calendar_size")
                    if isinstance(s, dict):
                        cur["calendar_size"] = {
                            "width": int(s.get("width", 0) or 0),
                            "height": int(s.get("height", 0) or 0),
                        }
                    elif s is None:
                        cur["calendar_size"] = None
                if "calendar_notes" in payload and isinstance(
                        payload.get("calendar_notes"), dict):
                    cur["calendar_notes"] = payload.get("calendar_notes")
                # 天气组件独立开关与地点
                if "weather_visible" in payload:
                    cur["weather_visible"] = bool(payload.get("weather_visible"))
                if "weather_pos" in payload:
                    p = payload.get("weather_pos")
                    if isinstance(p, dict):
                        cur["weather_pos"] = {"left": int(p.get("left", 0) or 0),
                                              "top": int(p.get("top", 0) or 0)}
                    elif p is None:
                        cur["weather_pos"] = None
                if "weather_size" in payload:
                    s = payload.get("weather_size")
                    if isinstance(s, dict):
                        cur["weather_size"] = {
                            "width": int(s.get("width", 0) or 0),
                            "height": int(s.get("height", 0) or 0),
                        }
                    elif s is None:
                        cur["weather_size"] = None
                if "weather_location" in payload:
                    cur["weather_location"] = str(payload.get("weather_location") or "")
                # 新增 4 个组件独立开关（便签/待办/世界时钟/系统监控），与日历/天气一致走主 settings
                if "notes_visible" in payload:
                    cur["notes_visible"] = bool(payload.get("notes_visible"))
                if "todo_visible" in payload:
                    cur["todo_visible"] = bool(payload.get("todo_visible"))
                if "worldclock_visible" in payload:
                    cur["worldclock_visible"] = bool(payload.get("worldclock_visible"))
                if "monitor_visible" in payload:
                    cur["monitor_visible"] = bool(payload.get("monitor_visible"))
                ok = save_settings(cur)
                self._send_json({"status": "success" if ok else "error",
                                 "settings": cur}, 200 if ok else 500)
                return
            self._send_json({"settings": load_settings()})
            return

        # ===== 日历组件独立设置（与目录浏览器浮层共用 settings.json，字段加 calendar_ 前缀）=====
        # 前端 calendar-widget.js 用 plain 字段（visible/pos/size/notes）读写，
        # 这里负责映射到 calendar_visible / calendar_pos / calendar_size / calendar_notes。
        if parsed.path == "/api/calendar_settings":
            if self.command == "POST":
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    payload = json.loads(raw.decode("utf-8") or "{}")
                except Exception:
                    payload = {}
                cur = load_settings()
                if "visible" in payload:
                    cur["calendar_visible"] = bool(payload.get("visible"))
                if "pos" in payload:
                    p = payload.get("pos")
                    if isinstance(p, dict):
                        cur["calendar_pos"] = {"left": int(p.get("left", 0) or 0),
                                               "top": int(p.get("top", 0) or 0)}
                    elif p is None:
                        cur["calendar_pos"] = None
                if "size" in payload:
                    s = payload.get("size")
                    if isinstance(s, dict):
                        cur["calendar_size"] = {
                            "width": int(s.get("width", 0) or 0),
                            "height": int(s.get("height", 0) or 0),
                        }
                    elif s is None:
                        cur["calendar_size"] = None
                if "notes" in payload and isinstance(payload.get("notes"), dict):
                    cur["calendar_notes"] = payload.get("notes")
                if "min" in payload:
                    cur["calendar_min"] = bool(payload.get("min"))
                if "pinned" in payload:
                    cur["calendar_pinned"] = bool(payload.get("pinned"))
                ok = save_settings(cur)
                self._send_json({"status": "success" if ok else "error",
                                 "settings": {
                                     "visible": cur.get("calendar_visible", True),
                                     "pos": cur.get("calendar_pos"),
                                     "size": cur.get("calendar_size"),
                                     "min": cur.get("calendar_min", False),
                                     "notes": cur.get("calendar_notes") or {},
                                 }}, 200 if ok else 500)
                return
            st = load_settings()
            self._send_json({"settings": {
                "visible": st.get("calendar_visible", True),
                "pos": st.get("calendar_pos"),
                "size": st.get("calendar_size"),
                "min": st.get("calendar_min", False),
                "pinned": st.get("calendar_pinned", False),
                "notes": st.get("calendar_notes") or {},
            }})
            return

        # ===== 天气组件独立设置（与目录/日历浮层共用 settings.json，字段加 weather_ 前缀）=====
        # 前端 weather-widget.js 用 plain 字段（visible/pos/size/location）读写，
        # 这里负责映射到 weather_visible / weather_pos / weather_size / weather_location。
        if parsed.path == "/api/weather_settings":
            if self.command == "POST":
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    payload = json.loads(raw.decode("utf-8") or "{}")
                except Exception:
                    payload = {}
                cur = load_settings()
                if "visible" in payload:
                    cur["weather_visible"] = bool(payload.get("visible"))
                if "pos" in payload:
                    p = payload.get("pos")
                    if isinstance(p, dict):
                        cur["weather_pos"] = {"left": int(p.get("left", 0) or 0),
                                              "top": int(p.get("top", 0) or 0)}
                    elif p is None:
                        cur["weather_pos"] = None
                if "size" in payload:
                    s = payload.get("size")
                    if isinstance(s, dict):
                        cur["weather_size"] = {
                            "width": int(s.get("width", 0) or 0),
                            "height": int(s.get("height", 0) or 0),
                        }
                    elif s is None:
                        cur["weather_size"] = None
                if "location" in payload:
                    cur["weather_location"] = str(payload.get("location") or "")
                if "min" in payload:
                    cur["weather_min"] = bool(payload.get("min"))
                if "pinned" in payload:
                    cur["weather_pinned"] = bool(payload.get("pinned"))
                ok = save_settings(cur)
                self._send_json({"status": "success" if ok else "error",
                                 "settings": {
                                     "visible": cur.get("weather_visible", True),
                                     "pos": cur.get("weather_pos"),
                                     "size": cur.get("weather_size"),
                                     "min": cur.get("weather_min", False),
                                     "pinned": cur.get("weather_pinned", False),
                                     "location": cur.get("weather_location") or "",
                                 }}, 200 if ok else 500)
                return
            st = load_settings()
            self._send_json({"settings": {
                "visible": st.get("weather_visible", True),
                "pos": st.get("weather_pos"),
                "size": st.get("weather_size"),
                "min": st.get("weather_min", False),
                "location": st.get("weather_location") or "",
            }})
            return

        # ===== 便签组件设置（独立端点，明文 box 字段映射到 notes_*）=====
        if parsed.path == "/api/notes_settings":
            handle_widget_settings(self, parsed, "notes")
            return

        # ===== 待办清单组件设置 =====
        if parsed.path == "/api/todo_settings":
            handle_widget_settings(self, parsed, "todo")
            return

        # ===== 世界时钟组件设置（含城市列表 worldclock_cities）=====
        if parsed.path == "/api/worldclock_settings":
            def _wc_payload(cur, payload):
                if "cities" in payload and isinstance(payload.get("cities"), list):
                    cities = []
                    for c in payload["cities"][:12]:
                        if isinstance(c, dict) and isinstance(c.get("name"), str):
                            cities.append({"name": c["name"][:40],
                                           "tz": str(c.get("tz") or "")[:60]})
                    cur["worldclock_cities"] = cities
            def _wc_response(resp, st):
                resp["cities"] = st.get("worldclock_cities") or [{"name": "本地", "tz": ""}]
            handle_widget_settings(self, parsed, "worldclock",
                                  extra_payload=_wc_payload, extra_response=_wc_response)
            return

        # ===== 系统监控组件设置 =====
        if parsed.path == "/api/monitor_settings":
            handle_widget_settings(self, parsed, "monitor")
            return

        # ===== 便签内容 CRUD（notes.json 持久化）=====
        if parsed.path == "/api/notes":
            if self.command == "POST":
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    payload = json.loads(raw.decode("utf-8") or "{}")
                except Exception:
                    payload = {}
                notes = load_notes()
                action = payload.get("action")
                if action == "add":
                    # 新建便签允许空文本：前端先建一张空便签卡，用户随后的输入
                    # 由 update(action) 防抖保存。若此处丢弃空文本 add，
                    # 点击「新建便签」将永远无反应（返回列表不变）。
                    text = str(payload.get("text") or "")
                    color = payload.get("color")
                    if color not in NOTE_COLORS:
                        color = NOTE_COLORS[0]
                    notes.append({"id": _safe_id(), "text": text[:MAX_NOTE_LEN],
                                  "color": color, "pinned": False,
                                  "created": int(time.time())})
                    notes = notes[-MAX_ITEMS:]
                elif action == "update":
                    nid = payload.get("id")
                    for n in notes:
                        if n.get("id") == nid:
                            if "text" in payload and payload["text"] is not None:
                                n["text"] = str(payload["text"])[:MAX_NOTE_LEN]
                            if "color" in payload and payload["color"] in NOTE_COLORS:
                                n["color"] = payload["color"]
                            if "pinned" in payload:
                                n["pinned"] = bool(payload["pinned"])
                            break
                elif action == "delete":
                    nid = payload.get("id")
                    notes = [n for n in notes if n.get("id") != nid]
                elif action == "reorder":
                    ids = payload.get("ids")
                    if isinstance(ids, list):
                        m = {n.get("id"): n for n in notes}
                        ordered = [m[i] for i in ids if i in m]
                        for n in notes:
                            if n.get("id") not in ids:
                                ordered.append(n)
                        notes = ordered[:MAX_ITEMS]
                ok = save_notes(notes)
                self._send_json({"status": "success" if ok else "error", "notes": notes},
                                200 if ok else 500)
                return
            self._send_json({"notes": load_notes()})
            return

        # ===== 待办清单内容 CRUD（todos.json 持久化）=====
        if parsed.path == "/api/todos":
            if self.command == "POST":
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    payload = json.loads(raw.decode("utf-8") or "{}")
                except Exception:
                    payload = {}
                todos = load_todos()
                action = payload.get("action")
                if action == "add":
                    text = str(payload.get("text") or "").strip()
                    if text:
                        todos.append({"id": _safe_id(), "text": text[:MAX_TODO_LEN],
                                      "done": False, "created": int(time.time())})
                        todos = todos[-MAX_ITEMS:]
                elif action == "update":
                    tid = payload.get("id")
                    for t in todos:
                        if t.get("id") == tid:
                            if "text" in payload and payload["text"] is not None:
                                t["text"] = str(payload["text"])[:MAX_TODO_LEN]
                            if "done" in payload:
                                t["done"] = bool(payload["done"])
                            break
                elif action == "delete":
                    tid = payload.get("id")
                    todos = [t for t in todos if t.get("id") != tid]
                elif action == "reorder":
                    ids = payload.get("ids")
                    if isinstance(ids, list):
                        m = {t.get("id"): t for t in todos}
                        ordered = [m[i] for i in ids if i in m]
                        for t in todos:
                            if t.get("id") not in ids:
                                ordered.append(t)
                        todos = ordered[:MAX_ITEMS]
                ok = save_todos(todos)
                self._send_json({"status": "success" if ok else "error", "todos": todos},
                                200 if ok else 500)
                return
            self._send_json({"todos": load_todos()})
            return

        # ===== 系统监控实时数据（Linux /proc，异常降级）=====
        if parsed.path == "/api/monitor":
            self._send_json(get_monitor_stats())
            return

        # ===== 体检 / 一键急救（Web 崩溃时通过 :8099 直接访问本页自救）=====
        if parsed.path == "/api/diagnose":
            self._send_json(diagnose())
            return

        if parsed.path == "/api/rescue" and self.command == "POST":
            try:
                self._send_json({"status": "success", "report": rescue()})
            except Exception as e:
                self._send_json({"status": "error", "message": str(e)}, 500)
            return

        # ===== 清理冲突注入（卸载残留/重复注入的急救，可手动触发）=====
        if parsed.path == "/api/cleanup" and self.command == "POST":
            removed = cleanup_conflicts()
            if removed:
                _nginx_restart()
            self._send_json({
                "status": "success",
                "removed": removed,
                "message": ("已清理冲突注入: %s" % removed) if removed
                           else "没有冲突注入，无需清理",
            })
            return

        # ===== 桌面注入状态 / 安装 / 卸载 =====
        if parsed.path == "/api/inject_status":
            if INJECTOR is None:
                self._send_json({"status": "unavailable", "reason": "无注入器"})
            else:
                self._send_json(INJECTOR.status())
            return

        # 手动触发桌面注入（需以 root 运行，会写 ng.conf.zip 并重启 nginx，耗时较久）
        if parsed.path == "/api/inject" and self.command == "POST":
            if INJECTOR is None:
                self._send_json({"status": "error",
                                 "message": "无注入器（缺少 injector 模块或密钥）"}, 500)
                return
            # 单方面避让：若仍有别的注入器处于安装状态，拒绝注入。
            # 强行注入必然产生两份 location = / -> nginx duplicate location 崩溃。
            live = detect_live_conflicts()
            if live:
                self._send_json({
                    "status": "error",
                    "live_conflicts": live,
                    "message": ("检测到另一个桌面注入器仍处于安装状态：%s。"
                                "它和本组件都占用 location = /，同时存在必然导致 "
                                "nginx duplicate location 崩溃，因此已拒绝注入。"
                                "请先卸载该应用，再用「清理残留注入」清掉它的残留后重试；"
                                "或直接使用原生桌面组件（不注入，不会冲突）。" % live),
                }, 409)
                return
            try:
                # 注入前先清掉其它劫持 location = / 的残留，确保不会 duplicate
                cleaned = cleanup_conflicts()
                ok, msg = INJECTOR.ensure_installed(allow_restart=True)
                self._send_json({"status": "success" if ok else "error",
                                 "message": msg,
                                 "cleaned": cleaned,
                                 "detail": INJECTOR.status()})
            except Exception as e:
                self._send_json({"status": "error", "message": str(e)}, 500)
            return

        if parsed.path == "/api/uninstall" and self.command == "POST":
            # 手动撤销本组件注入。注意：**不在此同步重启 nginx**，
            # 否则会打断正在进行的卸载请求（浏览器 "Failed to fetch"）。
            # 只有在实际清理了东西时才后台延迟重启。
            if INJECTOR is not None:
                INJECTOR.stop_maintenance()
            removed = []
            try:
                if (zip_contains_fn is not None and remove_entry_fn is not None
                        and zip_contains_fn(NG_CONF_ZIP, OUR_ARCNAME)):
                    remove_entry_fn(NG_CONF_ZIP, OUR_ARCNAME)
                    removed.append(OUR_ARCNAME + " (zip)")
            except Exception:
                pass
            try:
                cf = os.path.join(CONF_D_DIR, "ronglinc93widget.conf")
                if os.path.exists(cf):
                    os.remove(cf)
                    removed.append("conf.d/ronglinc93widget.conf")
            except Exception:
                pass
            try:
                d = os.path.join(APP_DATA_DIR, "desktop")
                if os.path.isdir(d):
                    shutil.rmtree(d, ignore_errors=True)
                    removed.append("desktop/")
            except Exception:
                pass
            if removed:
                _deferred_nginx_restart(5)
            self._send_json({
                "status": "success",
                "removed": removed,
                "message": ("已撤销注入 %s（nginx 稍后自动重启）" % removed)
                           if removed else "无注入可撤",
            })
            return

        self.send_error(404)

    do_POST = do_GET


def main():
    port = int(os.environ.get("TRIM_SERVICE_PORT", "8099"))
    host = os.environ.get("BIND_HOST", "0.0.0.0")

    # 【启动自愈】先清掉其它劫持 location = / 的孤儿注入（应用卸载残留是
    # duplicate location 导致 nginx 崩溃的根源）。默认不动我们自己的配置，
    # 因此重启后桌面浮层依然保留。
    try:
        cleaned = cleanup_conflicts()
        if cleaned:
            print("启动清理：已移除冲突注入 %s" % cleaned)
            _nginx_restart()
        else:
            print("启动清理：无冲突注入")
    except Exception as e:
        print("启动清理异常（忽略，不影响服务）: %s" % e)

    # 双栈监听：绑定 0.0.0.0 / 127.0.0.1 / 空时，改为监听 [::] 并关闭 IPV6_V6ONLY，
    # 让单个 socket 同时接受 IPv4 与 IPv6。fnOS 默认给第三方应用设 BIND_HOST=127.0.0.1
    # （仅回环），会导致桌面浮层直连 ip:8099 失败；这里统一改成可被发现式双栈监听。
    if host in ("0.0.0.0", "127.0.0.1", "", None):
        class DualStackHTTPServer(ThreadingHTTPServer):
            address_family = socket.AF_INET6

            def server_bind(self):
                self.socket.setsockopt(
                    socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
                super().server_bind()
        httpd = DualStackHTTPServer(("::", port), DirHandler)
        bind_desc = "0.0.0.0 + [::] (双栈)"
    else:
        httpd = ThreadingHTTPServer((host, port), DirHandler)
        bind_desc = host
    print("目录浏览器已启动: http://%s:%d/  (static=%s, ui=%s)"
          % (bind_desc, port, STATIC_DIR, UI_DIR))
    print("安全模式：不修改系统 nginx / ng.conf.zip。"
          "桌面小组件改用 fnOS 原生 ui/config 机制（无系统侵入）。")
    print("如需清理旧注入残留，可调用 POST /api/uninstall（需应用仍在运行）。")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
