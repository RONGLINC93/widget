#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""pull.py - 从远端拉取最新代码（rebase 方式）
==============================================
凭据：若 .env 中有 GITHUB_TOKEN 则用它认证（不落盘、不写进 remote URL）；
      否则回退到系统凭据管理器。

用法：双击运行；或命令行：pull.py [分支名，默认当前分支/main]
"""
import base64
import io
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
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


def run(cmd):
    print("> " + " ".join(cmd))
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

    branch = sys.argv[1] if len(sys.argv) > 1 else current_branch()
    print("=== 从 origin/%s 拉取并变基 ===" % branch)
    rc = run(["git"] + auth + ["pull", "--rebase", "origin", branch])
    if rc != 0:
        print("")
        print("[错误] 拉取失败。若存在冲突，请手动处理：")
        print("        查看冲突：git status")
        print("        解决后：  git add -A && git rebase --continue")
        print("        放弃：    git rebase --abort")
        if not has_tok:
            print("        若是认证失败，可在 .env 中配置 GITHUB_TOKEN=xxx")
        return 1

    print("")
    print("=== 当前状态 ===")
    subprocess.run(["git", "--no-pager", "log", "--oneline", "-5"])
    print("")
    print("[完成] 已同步到远程最新（%s）" % REPO_URL)
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
