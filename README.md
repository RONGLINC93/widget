# RONGLINC93 小组件（目录浏览器）

飞牛 fnOS（Trim）桌面小组件：把一个**目录浏览器浮层**显示在飞牛桌面上，可浏览 NAS 上的文件夹。
纯 Python 标准库实现（零第三方依赖），后端自带 HTTP 服务。

- 包名：`ronglinc93widget`
- 版本：`0.1.2`（开发中）｜已发布：`v0.1.1`
- 产物：`ronglinc93widget-<版本>-all.fpk`
- 仓库：<https://github.com/RONGLINC93/widget>

---

## 功能

- 📁 桌面上常驻的目录浏览器浮层（可拖动、最小化、关闭）
- 目录点击进入、↑ 返回上级、路径手工输入
- 显示 名称 / 大小 / 类型 / 修改时间
- 应用窗口内可配置：**目录路径、主目录边界、显示开关、注入桌面、清理残留注入**
- 「主目录边界」限制：只能在该目录内浏览，**向上不可越过**（服务端强制校验）
- 关闭浮层后**刷新桌面不会再弹出**（状态存服务端）；可在应用窗口重新开启
- 设置跨浏览器/跨设备一致（存在 NAS 上，不依赖 localStorage）

---

## 工作原理

本组件有**两套显示方式**，互不冲突：

### 1. 原生应用窗口（始终可用，零侵入）
fnOS 原生机制：`ui/config` 声明一个 `type: iframe` 的桌面组件，
点桌面图标即打开窗口，访问后端 `http://<主机>:8099/`。
**不修改 nginx、不改系统文件**，永远不会引起冲突。

### 2. 桌面浮层（需点「注入桌面」，有前提）
参照 QWeather 的做法：nginx `alias` + 写加密的 `ng.conf.zip` 实现持久化注入。
注入由三部分组成：

| 组成 | 说明 |
|---|---|
| `conf.d/ronglinc93widget.conf` | 重写 `location = /` `/login` 到注入页，并反代 `/rl93w/` |
| `ng.conf.zip` 里的加密条目 | 让配置在 nginx 重启 / 系统自愈后仍能恢复 |
| `@appdata/ronglinc93widget/desktop/index.html` | 注入页 = 系统首页副本 + 我们的 `<script>` |

注入后 `/rl93w/static/*` 与 `/rl93w/api/list` 经 nginx 反代到本地后端 `127.0.0.1:8099`。

---

## ⚠️ 重要：注入只能有一个（否则飞牛会崩）

`location = /` **全局只能有一个**。若同时存在另一个注入器
（典型：**QWeather**），nginx 会报：

```
[emerg] duplicate location "/" in conf.d/ronglinc93widget.conf:3
```

nginx 拒绝加载 → **飞牛 Web 完全宕机**（5666/5667/80/443 全部无监听），
且会形成每 6 秒一次的崩溃循环。

本组件已内置三层自保：

1. **启动自愈**：服务启动时清理**孤儿**注入（对应应用**已卸载**却残留的配置），
   连 `ng.conf.zip` 里的加密条目一起删——只删 `conf.d` 会被 `trim_recover` 恢复回来。
2. **注入前避让**：若检测到仍有**处于安装状态**的其它注入器，
   **拒绝注入**并返回明确提示（HTTP 409），绝不写第二份。
3. **系统配置白名单 + 删除前备份**：绝不碰 fnOS 自带 conf，误删可还原。

> 结论：想用桌面浮层，这台机器上**不要装 QWeather**（或任何同类注入器）。
> 只想用窗口方式，则可与任何应用共存。

---

## 安装

1. 打包（或修改后重新打包）：
   ```bash
   python build_fp.py     # 产出 ronglinc93widget-0.1.0-all.fpk
   ```
2. fnOS **应用中心 → 本地安装**，选择该 fpk。
3. 装完点桌面图标「RONGLINC93小组件」打开设置窗口。

> 注意：应用中心是**异步解包**的，装完后 `static/`、`conf/` 里的文件
> 可能要过几分钟才落盘，不必急于判定"打包有问题"。

---

## 使用

设置窗口内：

| 控件 | 作用 |
|---|---|
| 目录路径 | 浮层显示的目录，如 `/vol1/share` |
| 主目录边界 | 向上不可越过的目录，留空 = 不限制 |
| 保存 | 写入服务端 `settings.json`（跨浏览器/设备一致） |
| 在桌面显示浮层 | 开关；在桌面点 × 关闭后可在此勾回来 |
| 清理残留注入 | 清除其它应用卸载后残留的孤儿注入 |
| 注入桌面 | 执行桌面注入（会重启 nginx，Web 短暂中断数秒） |

之后刷新飞牛桌面（`Ctrl+Shift+R`）即可看到浮层。

---

## 🆘 急救：Web 崩溃时自救

**原理**：nginx 崩了，但本组件后端是独立的 Python 服务（**不依赖 nginx**），
所以它仍在 `8099` 上正常提供服务。因此即使飞牛桌面完全打不开，也能自救。

**操作**：浏览器直接访问

```
http://<飞牛地址>:8099/
```

页面顶部就是红色 **🆘 急救** 面板（打开页面会自动体检一次）：

| 控件 | 作用 |
|---|---|
| 检查状态 | 显示 Web 是否监听、有几份 `location = /`、谁在冲突 |
| **一键修复崩溃** | 自动执行下述修复流程 |

「一键修复崩溃」做的事（顺序不可调换）：

1. **杀掉**其它注入器的进程 —— 否则它的维护线程会立刻把配置写回来；
2. **删除**它们的 `conf.d` 文件（先备份）**和 `ng.conf.zip` 里的加密条目**
   —— 只删 `conf.d` 会被 `trim_recover` 恢复，崩溃必然复发；
3. **重启 nginx** 并复查 `5666` 是否恢复监听，结果直接显示在页面上。

> 修复完成后刷新飞牛桌面即可恢复。若页面提示"已清理但 Web 仍未监听"，
> 再点一次即可。

---

## 接口一览

后端监听 **8099（双栈 IPv4+IPv6）**，支持 fnOS 应用网关前缀 `/app/ronglinc93widget/`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 设置窗口页面 |
| GET | `/static/*` | 前端静态资源 |
| GET | `/api/list?path=<目录>` | 目录列表 JSON（受主目录边界约束） |
| GET | `/health` | 健康检查 |
| GET | `/api/settings` | 读取设置 `{path, root, visible}` |
| POST | `/api/settings` | 保存设置（只合并提交的字段） |
| POST | `/api/inject` | 执行桌面注入（有冲突时拒绝） |
| POST | `/api/cleanup` | 清理孤儿注入配置 |
| GET | `/api/diagnose` | 体检：Web 是否可用 / 冲突方 / 孤儿 |
| POST | `/api/rescue` | **一键急救**：修复 duplicate location 崩溃 |
| GET | `/api/inject_status` | 注入状态 |
| POST | `/api/uninstall` | 撤销本组件的注入 |

设置持久化在 `@appdata/ronglinc93widget/settings.json`。

---

## 目录结构

```
fpk/
├── manifest              # 包描述（appname/service_port/desktop_uidir 等）
├── ICON.PNG              # 包图标 128
├── ICON_256.PNG          # 包图标 256
├── cmd/                  # 生命周期脚本
│   ├── main              # start/stop/status
│   ├── install_init / install_callback
│   ├── uninstall_init    # ★ 卸载前先撤注入，再停服务
│   ├── uninstall_callback
│   ├── stop / upgrade_*
├── config/               # privilege / resource
├── wizard/install
└── app/                  # 应用本体（打成 app.tgz）
    ├── server.py         # 后端：HTTP 服务 + 注入器 + 设置持久化
    ├── injector.py       # fnOS 注入模块（nginx conf + ng.conf.zip 加解密）
    ├── conf/ng_keys.json # ng.conf.zip 的 ZipCrypto 密钥（同版本 fnOS 有效）
    ├── ui/index.html     # 设置窗口
    ├── ui/config         # 桌面组件声明（原生 iframe）
    ├── ui/images/        # 组件图标 64/256
    └── static/           # inject.js（桌面注入）与 dir-widget.*（浮层）
build_fp.py               # 打包脚本
pull.py                   # 拉取：pull --rebase（默认当前分支）
push.py                   # 推送：commit -> rebase -> push
release.py                # 发布：打包 -> 标签 -> Release -> 版本号自动 +1
_gh_release.py            # 被 release.py 调用：调 GitHub API 建 Release、传资产
.env                      # GITHUB_TOKEN / GITHUB_REPO_URL（已被 .gitignore 排除）
pyrightconfig.json        # 类型检查配置（屏蔽零类型标注脚本的既有噪声）
README.md / CHANGELOG.md  # 文档
```

### 开发说明

- **打包**：`python build_fp.py`（产出 `ronglinc93widget-<版本>-<平台>.fpk`）。
- **类型检查**：本项目是零类型标注的脚本型应用，编辑器默认的 `recommended`
  模式会产生大量误报（约 20+ ERROR / 100+ WARNING）。
  已提供 `pyrightconfig.json`：`standard` 模式 + 关闭
  `reportConstantRedefinition`、`reportMissingTypeArgument`、`reportUnknown*`、
  `reportOptionalCall`、`reportAttributeAccessIssue` 等严格扩展，
  从根因屏蔽**既有**噪声，同时保留真实错误（语法、未定义变量等）。
- **新增代码请避免引入新告警**，两条实操经验：
  - 模块级函数句柄用**小写**命名（全大写会被当作常量，二次赋值即报重定义）；
  - 可能为 `None` 的对象调用前**必须判空**（`is not None`）。

### Git 工作流（拉取 / 推送 / 发布）

三个脚本封装日常 git 操作，凭据读根目录 `.env` 的 `GITHUB_TOKEN`
（不落盘到 remote URL，打印命令时脱敏为 `...extraheader=***`）：

| 脚本 | 作用 |
|---|---|
| `python pull.py [分支]` | 从 `origin` 拉取并变基（默认当前分支） |
| `python push.py ["说明"]` | 提交全部改动 → 变基到远程最新 → 推送；省略说明时用 `release v<版本>: …` |
| `python release.py [版本]` | 见下方发布流程 |
| `python _gh_release.py <版本>` | 被 `release.py` 调用：直接用 token 调 GitHub API 建 Release、传资产 |

**发布流程**（`release.py`，版本默认取 `fpk/manifest` 的 `version`）：

1. 先在 `CHANGELOG.md` 添加 `## [x.y.z]` 小节（条目写成 `- …` 列表）；
2. 运行 `python release.py`，它依次做：
   - 把该版本更新日志自动写进 manifest 的 `changelog` 字段（最多 12 条，超出提示详见 CHANGELOG）；
   - `build_fp.py` 打包并校验产物存在；
   - 推送当前分支 → 打并推送 `vX.Y.Z` 标签；
   - 创建 GitHub Release 并上传 `ronglinc93widget-<版本>-all.fpk` + `ICON_256.PNG`；
   - **版本号自动 +1**（`version` 补丁号 +1 进入下一开发版，`version_released` 记为刚发布的版本），
     并以 `chore: bump version to x.y.z` 提交推送，仓库保持干净。
3. 需要发布到指定版本：`python release.py 0.2.0`；不想递增加 `--no-bump`。

> 首次使用需先建仓库并配远端：
> `git init -b main` → `git remote add origin https://github.com/RONGLINC93/widget.git`
> → `python push.py "初始提交"`。

---

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 桌面浮层不显示 | 确认已点「注入桌面」；检查 `visible` 是否被关掉；刷新桌面 |
| 浮层出来但目录拉不到 | 检查 `/rl93w/` 反代是否生效；后端 8099 是否在跑 |
| Web 打不开（5666/5667 无监听） | 几乎一定是 `duplicate location "/"`，见上文"注入只能有一个" |
| 验证注入却总失败 | **桌面在 5666(HTTP)/5667(HTTPS)，不是 80/443**；用这两个端口 curl |
| 浏览器连不上后端 | 后端已做双栈监听（`::` + `IPV6_V6ONLY=0`），IPv4/IPv6 都可连 |
| 卸载后配置还在 | 旧版卸载不清注入；用「清理残留注入」或新版 `uninstall_init` 自动清理 |
| 改了代码没生效 | 需重新 `python build_fp.py` 并在应用中心重装 fpk |

---

## 已知限制

- 桌面浮层依赖 nginx 注入，与同类注入器（QWeather）**互斥**，不可共存。
- `ng_keys.json` 中的密钥与 fnOS 版本相关，换版本可能需重新获取密钥。
- 注入页是系统首页的副本，fnOS 大版本更新后建议重新注入一次。
