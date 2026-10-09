#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""release.py [版本号] [--no-bump]
=================================
构建安装包 -> 推送分支 -> 打版本标签 -> 推送标签 -> 创建 GitHub Release 并上传 fpk
-> 递增 manifest 版本号（进入下一开发版）-> 同步 CHANGELOG.md / README.md -> 提交推送。

版本号：默认读取 fpk/manifest 的 version=；也可显式传入（release.py 0.1.2）。
发布成功后自动：
  1. manifest：version 补丁号 +1（0.1.1 -> 0.1.2）进入下一开发版，
     version_released 记为刚发布的版本；
  2. CHANGELOG.md：给刚发布的 [ver] 小节补上发布日期，并为下一版开一个「未发布」小节；
  3. README.md：版本行推进为「下一版（开发中）｜已发布：v刚发布版本」；
  4. 以 "chore: bump version to x.y.z" 提交并推送以上文件，仓库保持干净。
加 --no-bump 可关闭递增（同时也不同步文档）。
凭据：优先用 .env 中的 GITHUB_TOKEN（无需装 gh）；其次用 gh（需已登录）。
仓库: RONGLINC93/widget（可用 .env 的 GITHUB_REPO_URL 覆盖）
"""
import base64
import datetime
import io
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(ROOT, "fpk", "manifest")
CHANGELOG = os.path.join(ROOT, "CHANGELOG.md")
REPO = "RONGLINC93/widget"


def load_env(path):
    data = {}
    if not os.path.exists(path):
        return data
    with io.open(path, encoding="utf-8", errors="ignore") as f:
        for line in f:
            s = line.strip()
            if s and not s.startswith("#") and "=" in s:
                k, v = s.split("=", 1)
                data[k.strip()] = v.strip().strip("'").strip('"')
    return data


def git_auth_args():
    env = load_env(os.path.join(ROOT, ".env"))
    tok = env.get("GITHUB_TOKEN", "")
    if tok:
        b64 = base64.b64encode(("x-access-token:" + tok).encode("utf-8")).decode("ascii")
        return ["-c", "http.https://github.com/.extraheader=AUTHORIZATION: basic " + b64], True
    return [], False


def get_version(text):
    m = re.search(r"(?m)^\s*version\s*=\s*(\S+)\s*$", text)
    return m.group(1).strip() if m else ""


def get_changelog(text):
    m = re.search(r"(?m)^\s*changelog\s*=\s*(.*)$", text)
    return m.group(1).strip() if m else None


def md_to_html(text):
    return re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)


def read_changelog_md(ver):
    """从 CHANGELOG.md 的 [ver] 小节取更新条目列表（不含版本号）。"""
    if not os.path.exists(CHANGELOG):
        return []
    items = []
    cur = None
    with io.open(CHANGELOG, encoding="utf-8") as f:
        for line in f:
            m = re.match(r"^##\s*\[([0-9][^\]]*)\]", line)
            if m:
                cur = m.group(1).strip()
                continue
            if line.startswith("## "):
                cur = None
                continue
            if cur == ver and line.strip().startswith("- "):
                items.append(line.strip()[2:].strip())
    return items


MAX_ITEMS = 12


def changelog_for(ver):
    """CHANGELOG.md 该版本的条目（含 <br> 换行），条数过多时截断提示。"""
    items = read_changelog_md(ver)
    if not items:
        return None
    if len(items) > MAX_ITEMS:
        items = items[:MAX_ITEMS] + ["其余 %d 项详见 CHANGELOG.md" % (len(items) - MAX_ITEMS)]
    return md_to_html("<br>".join(items))


def run(cmd):
    # 打印时脱敏：extraheader 里的 base64 可还原成明文 token
    shown = []
    for a in cmd:
        shown.append(a.split("=", 1)[0] + "=***" if "extraheader" in a else a)
    print("> " + " ".join(shown))
    return subprocess.run(cmd).returncode


def current_branch():
    r = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"],
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    name = (r.stdout or "").strip()
    if r.returncode == 0 and name and name != "HEAD":
        return name
    r2 = subprocess.run(["git", "symbolic-ref", "--short", "HEAD"],
                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    name2 = (r2.stdout or "").strip()
    return name2 or "main"


def read_multiline():
    print("请逐行输入本次更新内容（每行一条；空行结束，直接回车跳过）：")
    lines = []
    try:
        while True:
            ln = input("  > ").strip()
            if ln == "":
                break
            lines.append(ln)
    except (EOFError, KeyboardInterrupt):
        print("")
    return "<br>".join(lines)


def ensure_changelog(ver):
    """发布前检查：manifest 的 changelog 顶部必须含当前版本条目；
    缺失时优先从 CHANGELOG.md 自动获取，取不到则交互输入；跳过仅告警不阻断。
    """
    with io.open(MANIFEST, encoding="utf-8", newline="") as f:
        text = f.read()
    cur = get_changelog(text)
    if cur is None:
        print("[提示] manifest 无 changelog 字段，跳过检查（请确认格式）")
        return True
    if re.match(r"^v%s(?![\d.])" % re.escape(ver), cur):
        print("[信息] manifest 已包含 v%s 的更新日志，跳过" % ver)
        return True

    print("")
    print("=== 发布前：为 v%s 填写更新日志 ===" % ver)
    print("manifest changelog 顶部仍是旧版本（%s），缺少 v%s 条目。"
          % (cur[:40] + ("..." if len(cur) > 40 else ""), ver))

    content = changelog_for(ver)
    if content:
        print("[信息] 已从 CHANGELOG.md 自动获取 v%s 的更新日志。" % ver)
    else:
        content = read_multiline()
        if not content:
            print("[警告] 未输入 v%s 更新日志，请发布前务必手动补充 manifest changelog！" % ver)
            return True

    new_entry = "v%s：%s" % (ver, content)
    new_cl = new_entry + ("。" + cur if cur else "")
    text2 = re.sub(r"(?m)^(\s*changelog\s*=\s*).*$",
                   lambda m: m.group(1) + new_cl, text, count=1)
    with io.open(MANIFEST, "w", encoding="utf-8", newline="") as f:
        f.write(text2)
    with io.open(MANIFEST, encoding="utf-8", newline="") as f:
        back = get_changelog(f.read())
    if back and back.startswith("v%s：" % ver):
        print("[完成] 已将 v%s 更新日志写入 manifest 顶部" % ver)
    else:
        print("[警告] 写回校验失败，请手动检查 manifest changelog")
    return True


def bump_manifest_version(ver):
    """发布成功后递增：version 补丁号 +1（下一开发版），version_released 记为刚发布的 ver。
    仅替换相应行，其余内容（含 UTF-8 无 BOM 与原有换行）原样保留。
    返回新版本号；失败返回空串。
    """
    with io.open(MANIFEST, encoding="utf-8", newline="") as f:
        text = f.read()
    m = re.match(r"^([0-9]+)\.([0-9]+)\.([0-9]+)", ver)
    if not m:
        print("[警告] 无法解析版本号 %s，跳过自动递增" % ver)
        return ""
    ma, mi, pa = m.groups()
    nxt = "%s.%s.%d" % (ma, mi, int(pa) + 1)
    cur = get_version(text)
    text2 = re.sub(r"(?m)^(\s*version\s*=\s*)\S+(\s*)$",
                   lambda x: x.group(1) + nxt + x.group(2), text, count=1)
    if re.search(r"(?m)^\s*version_released\s*=", text2):
        text2 = re.sub(r"(?m)^(\s*version_released\s*=\s*)\S+(\s*)$",
                       lambda x: x.group(1) + ver + x.group(2), text2, count=1)
    else:
        if not text2.endswith("\n"):
            text2 += "\n"
        text2 += "version_released = %s\n" % ver
    with io.open(MANIFEST, "w", encoding="utf-8", newline="") as f:
        f.write(text2)
    with io.open(MANIFEST, encoding="utf-8", newline="") as f:
        back = get_version(f.read())
    if back == nxt:
        print("[完成] manifest 已递增：%s -> %s（下一开发版），version_released = %s" % (cur, nxt, ver))
        return nxt
    print("[警告] 递增后读回版本为 %s，预期 %s，请手动检查 fpk/manifest" % (back, nxt))
    return ""


def _read_doc(path):
    """读文档并返回 (统一换行后的文本, 原文件是否 CRLF)。"""
    with io.open(path, encoding="utf-8", newline="") as f:
        raw = f.read()
    return raw.replace("\r\n", "\n"), ("\r\n" in raw)


def _write_doc(path, text, crlf):
    out = text.replace("\n", "\r\n") if crlf else text
    with io.open(path, "w", encoding="utf-8", newline="") as f:
        f.write(out)


def sync_docs_after_release(ver, new_ver):
    """发布成功后同步文档，返回确实被改动的文件（相对路径）。

    - CHANGELOG.md：把刚发布版本的 `## [ver] — 未发布` 补成发布日期，
      并插入下一版的 `## [next] — 未发布` 小节（已存在则不重复插）。
    - README.md：版本行推进为「下一开发版（开发中）｜已发布：v已发布版本」。

    为什么要自动做：手工改容易漏——版本发出去了却还标着"未发布"，
    README 的版本行也会停在旧的开发版上（0.1.2 那次就是这么漏的）。
    """
    changed = []

    # ---- CHANGELOG.md ----
    if os.path.exists(CHANGELOG):
        text, crlf = _read_doc(CHANGELOG)
        before = text
        today = datetime.date.today().isoformat()

        m = re.search(r"(?m)^##\s*\[%s\][^\n]*$" % re.escape(ver), text)
        if m:
            if not re.search(r"\d{4}-\d{2}-\d{2}", m.group(0)):
                text = text[:m.start()] + "## [%s] — %s" % (ver, today) + text[m.end():]
                print("[完成] CHANGELOG.md：[%s] 已标记发布日期 %s" % (ver, today))
        else:
            print("[提示] CHANGELOG.md 里没有 [%s] 小节，跳过日期回填" % ver)

        if not re.search(r"(?m)^##\s*\[%s\]" % re.escape(new_ver), text):
            anchor = re.search(r"(?m)^##\s*\[%s\]" % re.escape(ver), text)
            if anchor:
                block = "## [%s] — 未发布\n\n---\n\n" % new_ver
                text = text[:anchor.start()] + block + text[anchor.start():]
                print("[完成] CHANGELOG.md：已开新的 [%s] 未发布小节" % new_ver)

        if text != before:
            _write_doc(CHANGELOG, text, crlf)
            if "CHANGELOG.md" not in changed:
                changed.append("CHANGELOG.md")

    # ---- README.md ----
    readme = os.path.join(ROOT, "README.md")
    if os.path.exists(readme):
        text, crlf = _read_doc(readme)
        line = "- 版本：`%s`（开发中）｜已发布：`v%s`" % (new_ver, ver)
        new_text, n = re.subn(r"(?m)^-\s*版本：.*$", line, text, count=1)
        if not n:
            print("[提示] README.md 没找到「- 版本：…」那一行，跳过")
        elif new_text != text:
            _write_doc(readme, new_text, crlf)
            changed.append("README.md")
            print("[完成] README.md：版本行 -> %s" % line)
        else:
            print("[信息] README.md 版本行已是最新，无需改动")

    return changed


def commit_and_push_bump(new_ver, auth, extra_files=None):
    """把递增后的 manifest（及同步过的文档）提交并推送，保证发布后工作区干净。"""
    run(["git", "add", os.path.join("fpk", "manifest")])
    for rel in (extra_files or []):
        run(["git", "add", rel])
    if run(["git", "commit", "-m", "chore: bump version to %s" % new_ver]) != 0:
        print("[警告] 递增后的提交失败（可能无改动），请手动检查")
        return False
    if run(["git"] + auth + ["push", "origin", current_branch()]) != 0:
        print("[警告] 递增提交未推送成功，请手动运行 push.py")
        return False
    print("[完成] 递增提交已推送")
    return True


def main():
    os.chdir(ROOT)
    args = [a for a in sys.argv[1:]]
    no_bump = "--no-bump" in args
    args = [a for a in args if a != "--no-bump"]
    ver = args[0] if args else ""
    if not ver:
        with io.open(MANIFEST, encoding="utf-8") as f:
            ver = get_version(f.read())
    if not ver:
        print("[错误] 无法从 fpk/manifest 读取版本号，请显式指定：release.py 0.1.2")
        return 1

    env = load_env(os.path.join(ROOT, ".env"))
    url = env.get("GITHUB_REPO_URL", "")
    if url:
        tail = url.rstrip("/").split("/")[-2:]
        if len(tail) == 2 and tail[0] and tail[1]:
            repo = tail[0] + "/" + tail[1].replace(".git", "")
        else:
            repo = REPO
    else:
        repo = REPO

    print("[信息] 发布版本：%s" % ver)
    print("[信息] 目标仓库：%s" % repo)

    with io.open(MANIFEST, encoding="utf-8") as f:
        mfver = get_version(f.read())
    if mfver and mfver != ver:
        print("[警告] manifest 中的版本是 %s，与本次发布 %s 不一致！" % (mfver, ver))

    r = subprocess.run(["git", "status", "--porcelain"],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if r.stdout.strip():
        print("[提示] 存在未提交改动，建议先运行「push.py」再发布")

    ensure_changelog(ver)

    # ---- 1/4 构建安装包 ----
    print("")
    print("=== 1/4 构建安装包 ===")
    if run([sys.executable, os.path.join(ROOT, "build_fp.py")]) != 0:
        print("[错误] 构建失败")
        return 1
    pkg = os.path.join(ROOT, "ronglinc93widget-%s-all.fpk" % ver)
    if not os.path.exists(pkg):
        print("[错误] 未找到构建产物 %s" % pkg)
        return 1
    print("[完成] 产物：%s（%d bytes）" % (os.path.basename(pkg), os.path.getsize(pkg)))

    # ---- 2/4 推送分支 ----
    print("")
    print("=== 2/4 推送当前分支 ===")
    auth, has_tok = git_auth_args()
    branch = current_branch()
    has_up = subprocess.run(["git", "rev-parse", "--abbrev-ref", "@{u}"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    push_cmd = ["git"] + auth + ["push"] + ([] if has_up else ["-u"]) + ["origin", branch]
    if run(push_cmd) != 0:
        print("[警告] 分支推送失败（不影响打标签，请检查工作区是否已提交）")

    # ---- 3/4 打标签并推送 ----
    print("")
    print("=== 3/4 创建并推送版本标签 v%s ===" % ver)
    tag_rc = 0
    run(["git", "tag", "-a", "v%s" % ver, "-m", "v%s" % ver])
    tag_rc = run(["git"] + auth + ["push", "origin", "v%s" % ver])
    if tag_rc != 0:
        print("[警告] 标签推送失败（若远程已存在该标签可忽略；"
              "需覆盖用：git tag -d v%s && git push origin :refs/tags/v%s）" % (ver, ver))
    else:
        print("[完成] 标签 v%s 已在远程" % ver)

    # ---- 4/4 创建 Release 并上传资产 ----
    print("")
    print("=== 4/4 创建 GitHub Release 并上传安装包 ===")
    tok = env.get("GITHUB_TOKEN", "")
    rel_rc = 1
    if tok:
        print("[凭据] 使用 .env 中的 GITHUB_TOKEN")
        rel_rc = run([sys.executable, os.path.join(ROOT, "_gh_release.py"), ver])
    elif subprocess.run(["where", "gh"], stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL).returncode == 0:
        print("[凭据] 使用 gh")
        if subprocess.run(["gh", "auth", "status"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            if subprocess.run(["gh", "release", "view", "v%s" % ver, "--repo", repo],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
                run(["gh", "release", "create", "v%s" % ver, pkg,
                     "--repo", repo, "--title", "v%s" % ver,
                     "--notes", "详见 CHANGELOG.md / manifest changelog"])
            else:
                run(["gh", "release", "upload", "v%s" % ver, pkg,
                     "--clobber", "--repo", repo])
            rel_rc = 0
        else:
            print("[提示] gh 已安装但未登录")
    else:
        print("[提示] 未安装 gh 命令行工具")

    if rel_rc != 0:
        print("[跳过] 无可用凭据（.env 无 GITHUB_TOKEN，且 gh 未安装/未登录）")
        print("        办法一：在 .env 中配置 GITHUB_TOKEN=xxx（需 repo 权限）")
        print("        办法二：winget install GitHub.cli 然后 gh auth login")
        print("        办法三：手动创建 https://github.com/%s/releases/new" % repo)
        print("        需选择标签 v%s 并上传：ronglinc93widget-%s-all.fpk" % (ver, ver))

    print("")
    print("============== 发布结果 ==============")
    if rel_rc == 0:
        print("[成功] v%s 发布完成：标签 + Release + 安装包均已就绪" % ver)
    else:
        print("[未完成] 仅完成本地构建与标签")
        print("        Release 未创建，见上方说明")
    print("=======================================")

    # ---- 发布后递增版本号（进入下一开发版）----
    if no_bump:
        print("[提示] 已加 --no-bump，跳过版本号递增")
        return 0
    if rel_rc != 0:
        print("[提示] Release 未成功，跳过版本号递增（避免把未发布的版本推进开发版）")
        return 0

    print("")
    print("=== 递增版本号（进入下一开发版）===")
    new_ver = bump_manifest_version(ver)
    if new_ver:
        print("")
        print("=== 同步 CHANGELOG.md / README.md ===")
        changed = sync_docs_after_release(ver, new_ver)
        if not changed:
            print("[提示] 文档无需改动")
        commit_and_push_bump(new_ver, auth, changed)
    print("")
    print("提示：下一版开发完成后，直接在 CHANGELOG.md 的 [%s] 未发布小节下写条目，" % (new_ver or "x.y.z"))
    print("      再运行 release.py 发布即可（日期与版本行会自动回填）。")
    return 0


if __name__ == "__main__":
    rc = 1
    try:
        rc = main()
    except KeyboardInterrupt:
        rc = 0
    print("")
    print("窗口将在 5 秒后自动关闭...")
    time.sleep(5)
    sys.exit(rc)
