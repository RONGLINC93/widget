#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GitHub Release 发布助手：凭据取自项目根目录 .env，不依赖 gh CLI。

用法：python _gh_release.py <版本号>
行为：校验凭据 -> 创建/复用 Release -> 上传 ronglinc93widget-<ver>-all.fpk -> 输出清单
Release 说明取自 fpk/manifest 的 changelog 字段。
凭据只在内存中使用，不会打印或写入日志。
"""
import io
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import urllib.error

ROOT = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(ROOT, "fpk", "manifest")


def load_env(path):
    data = {}
    if not os.path.exists(path):
        return data
    for line in io.open(path, encoding="utf-8", errors="ignore"):
        s = line.strip()
        if s and not s.startswith("#") and "=" in s:
            k, v = s.split("=", 1)
            data[k.strip()] = v.strip().strip("'").strip('"')
    return data


def repo_slug(cfg):
    url = cfg.get("GITHUB_REPO_URL") or ""
    if url:
        tail = url.rstrip("/").split("/")[-2:]
        if len(tail) == 2 and tail[0] and tail[1]:
            return tail[0] + "/" + tail[1].replace(".git", "")
    return "RONGLINC93/widget"


def manifest_changelog():
    if not os.path.exists(MANIFEST):
        return "详见 CHANGELOG.md"
    with io.open(MANIFEST, encoding="utf-8", errors="ignore") as f:
        m = re.search(r"(?m)^\s*changelog\s*=\s*(.*)$", f.read())
    if not m or not m.group(1).strip():
        return "详见 CHANGELOG.md"
    # <br> 在 Markdown 里换行效果差，转成列表项
    body = m.group(1).strip().replace("<br>", "\n- ")
    return "- " + body if not body.startswith("- ") else body


def api(url, token, data=None, method=None, ctype="application/json"):
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("User-Agent", "ronglinc93widget-release")
    req.add_header("Accept", "application/vnd.github+json")
    if data is not None:
        req.add_header("Content-Type", ctype)
    resp = urllib.request.urlopen(req, timeout=120)
    return json.loads(resp.read().decode("utf-8"))


def main():
    ver = sys.argv[1] if len(sys.argv) > 1 else ""
    if not ver:
        print("[错误] 请传入版本号，例如：python _gh_release.py 0.1.1")
        return 2

    cfg = load_env(os.path.join(ROOT, ".env"))
    token = cfg.get("GITHUB_TOKEN", "")
    if not token:
        print("[错误] .env 中没有 GITHUB_TOKEN")
        return 2
    slug = repo_slug(cfg)
    api_root = "https://api.github.com/repos/" + slug
    up_root = "https://uploads.github.com/repos/" + slug

    try:
        me = api("https://api.github.com/user", token)
        print("[凭据] 有效，登录用户：" + str(me.get("login")))
    except urllib.error.HTTPError as e:
        print("[错误] Token 无效或已过期（HTTP %d）" % e.code)
        return 2

    tag = "v" + ver
    pkgs = [os.path.join(ROOT, "ronglinc93widget-%s-all.fpk" % ver)]
    extras = [os.path.join(ROOT, "fpk", "ICON_256.PNG")]
    missing = [p for p in pkgs if not os.path.exists(p)]
    if missing:
        for p in missing:
            print("[错误] 缺少构建产物：" + os.path.basename(p))
        return 2

    rel = None
    try:
        rel = api(api_root + "/releases/tags/" + tag, token)
        print("[Release] 已存在：id=%s" % rel.get("id"))
    except urllib.error.HTTPError as e:
        if e.code != 404:
            print("[错误] 查询 Release 失败 HTTP %d" % e.code)
            return 2
        print("[Release] 不存在，准备创建 ...")

    if rel is None:
        payload = json.dumps({
            "tag_name": tag,
            "name": tag,
            "body": manifest_changelog(),
            "draft": False,
            "prerelease": False,
        }).encode("utf-8")
        rel = api(api_root + "/releases", token, data=payload, method="POST")
        print("[Release] 创建成功：id=%s" % rel.get("id"))

    rid = rel["id"]
    existing = set()
    try:
        for a in api(api_root + "/releases/%s/assets" % rid, token):
            existing.add(a["name"])
    except Exception:
        pass

    for p in pkgs + [x for x in extras if os.path.exists(x)]:
        name = os.path.basename(p)
        if name in existing:
            print("[资产] 已存在同名资产，跳过：" + name)
            continue
        data = io.open(p, "rb").read()
        url = up_root + "/releases/%s/assets?name=%s" % (rid, urllib.parse.quote(name))
        out = api(url, token, data=data, method="POST",
                  ctype="application/octet-stream")
        print("[资产] 已上传：%s  %d bytes" % (out.get("name"), out.get("size")))

    rel = api(api_root + "/releases/tags/" + tag, token)
    print("")
    print("[成功] Release 地址：" + str(rel.get("html_url")))
    for a in rel.get("assets", []):
        print("       - %-36s %d bytes" % (a["name"], a["size"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
