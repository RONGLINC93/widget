#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""push.py ["自定义提交信息"]
=============================
提交本地改动 -> 变基到远程最新 -> 推送到远端分支。
用法：双击运行；或命令行传入提交信息：push.py "自定义提交信息"
注意：git rebase 要求工作区干净，故必须「先提交、再变基、后推送」。
分支：默认当前分支（新仓库为 main），也可显式指定：push.py "说明" main
"""
import base64
import io
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(ROOT, "fpk", "manifest")
REPO_URL = "https://github.com/RONGLINC93/widget"


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


def has_upstream():
    return subprocess.run(["git", "rev-parse", "--abbrev-ref", "@{u}"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def main():
    os.chdir(ROOT)
    auth, has_tok = git_auth_args()
    print("[凭据] 使用 .env 中的 GITHUB_TOKEN" if has_tok else "[凭据] 无 GITHUB_TOKEN，使用系统凭据")

    if subprocess.run(["git", "rev-parse", "--is-inside-work-tree"],
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
        print("[错误] 当前目录不是 git 仓库，请先初始化：")
        print("        git init")
        print("        git branch -M main")
        print("        git remote add origin %s" % REPO_URL)
        return 1

    # 提交信息：优先命令行参数，否则自动生成（带 manifest 版本号）
    msg = sys.argv[1] if len(sys.argv) > 1 else ""
    branch = sys.argv[2] if len(sys.argv) > 2 else current_branch()
    if not msg:
        with io.open(MANIFEST, encoding="utf-8") as f:
            ver = get_version(f.read())
        msg = "release v%s: RONGLINC93 小组件（目录浏览器）" % (ver or "unknown")
    print("[信息] 目标分支：%s" % branch)

    print("")
    print("=== 1/4 暂存并提交本地改动 ===")
    if run(["git", "add", "-A"]) != 0:
        print("[错误] git add 失败")
        return 1

    have_commit = False
    if subprocess.run(["git", "diff", "--cached", "--quiet"]).returncode != 0:
        print("[信息] 提交信息：%s" % msg)
        if run(["git", "commit", "-m", msg]) != 0:
            print("[错误] git commit 失败")
            return 1
        have_commit = True
    else:
        print("[提示] 无本地改动，仅同步远程")

    print("")
    print("=== 2/4 变基到远程最新（pull --rebase）===")
    if run(["git"] + auth + ["pull", "--rebase", "origin", branch]) != 0:
        print("[错误] 拉取/变基失败。若有冲突请手动处理：")
        print("        查看：  git status")
        print("        解决后：git add -A && git rebase --continue")
        print("        放弃：  git rebase --abort")
        return 1

    print("")
    print("=== 3/4 推送到 origin/%s ===" % branch)
    push_cmd = ["git"] + auth + ["push"]
    if not has_upstream():
        print("[提示] 分支 %s 尚无上游，自动加 -u 建立跟踪" % branch)
        push_cmd.append("-u")
    push_cmd += ["origin", branch]
    if run(push_cmd) != 0:
        print("[错误] git push 失败")
        if not has_tok:
            print("        若是认证失败，可在 .env 中配置 GITHUB_TOKEN=xxx")
        return 1

    print("")
    print("=== 4/4 完成 ===")
    if have_commit:
        print("[完成] 已提交并推送到 %s" % REPO_URL)
    else:
        print("[完成] 已同步到远程最新")
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
