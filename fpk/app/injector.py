# -*- coding: utf-8 -*-
"""
fnOS 桌面注入模块（可独立复用）
================================

把任意 <script> 注入到飞牛（fnOS）桌面 SPA，并使其在系统自愈
（trim_recover 每次 reload/restart 从加密包恢复 www / nginx conf）
之后依然持久生效。

背景
----
fnOS 的 nginx 内置 trim_recover 模块：
  - inotify 监控 /usr/trim/www，任何文件被修改 → nginx 退出 →
    systemd 重启时从加密的 www.zip 重新恢复 → 直接改 www 无法持久，
    持续写入还会造成“恢复风暴”；
  - 每次 nginx 成功 reload/restart，都会从加密的 ng.conf.zip
    恢复 /usr/trim/nginx/conf（含 conf.d/）→ 放 conf.d 的自定义配置
    会在 reload/restart 时被抹掉。

对策（被本模块封装）
  1. 注入页放在受保护的应用数据目录（vol1，恢复目录之外），内容 =
     系统 index.html + 一行 <script>；
  2. conf.d/<name>.conf 用 alias 把 GET /（及 /login）指向该注入页，
     并把小组件脚本/资源 alias 到应用目录；
  3. ng.conf.zip 的 ZipCrypto 密钥（用 bkcrack 对同版本 fnOS 离线恢复）
     已知，应用把 <name>.conf 以相同密钥加密后写进 ng.conf.zip →
     nginx 每次恢复都会“恢复出”我们的配置，注入天然持久；
  4. 维护线程低频巡检，全部只在缺失/不符时补写；永远不写
     /usr/trim/www 下任何文件。

使用方式
--------
前提（一次性准备）
  1. 获取与本机 fnOS 版本匹配的 ng.conf.zip ZipCrypto 内部密钥
     （K0,K1,K2）。用 bkcrack 对同版本 fnOS 做已知明文攻击
     （明文可取 conf.d/gzip.conf 等系统自带、内容已知的文件）离线恢复。
     每个 fnOS 小版本密钥可能不同，换版本需重新恢复。把结果存成 json：
        {"k0": 4516486, "k1": 2030073824, "k2": 324159466}
  2. 准备一份 nginx conf 文本，用 alias 把注入页与你的脚本/资源
     暴露出来（见下方模板）。

最小示例::

    from injector import FnOSInjector, InjectorConfig

    cfg = InjectorConfig(
        nginx_conf_zip="/usr/trim/share/.restore/ng.conf.zip",
        conf_arcname="conf.d/myapp.conf",    # 写入恢复包的条目名
        conf_d_dir="/usr/trim/nginx/conf/conf.d",
        www_index="/usr/trim/www/index.html",
        app_data_dir="/vol1/@appdata/com.my.app",
        keys_file="conf/ng_keys.json",        # 见前提 1
        conf_content=CONF,                     # 见前提 2
        script_tag='<script src="/myapp.js"></script>',
    )
    inj = FnOSInjector(cfg)

    inj.ensure_installed()      # 生成注入页 + 加密回写 ng.conf.zip + 同步 conf.d
    inj.start_maintenance()     # 可选：后台每 30s 巡检，只在缺失时补写

conf_content 模板（桌面页与脚本都交给 nginx 直接提供，零 www 修改）::

    CONF = '''
    location = /login { rewrite ^ /myapp-injected last; }
    location = /      { rewrite ^ /myapp-injected last; }
    location = /myapp-injected {
        alias /vol1/@appdata/com.my.app/desktop/index.html;
        default_type text/html;
        add_header cache-control no-store;
    }
    location = /myapp.js {
        alias /vol1/@appcenter/com.my.app/static/myapp.js;
        default_type application/javascript;
        add_header cache-control no-store;
    }
    '''

    说明：location = / 的 URI 以 / 结尾，nginx 的 index 模块会向 alias
    路径后再追加 index.html（产生 .../index.htmlindex.html → 500），因此
    先 rewrite 到一个不以 / 结尾的内部 URI（如 /myapp-injected）再 alias。
    /login 也必须返回同一注入页，否则 SPA 登录跳转会销毁我们的脚本。

常用 API
  - ensure_installed(allow_restart=True) -> (ok: bool, detail: str)
        完整安装/修复：注入页 + ng.conf.zip 加密条目 + conf.d 同步。
        conf.d 不符且距上次重启已超过 rate_limit_sec（默认 180s）时
        才重启 nginx，避免重启风暴。
  - uninstall() -> (ok: bool, detail: str)
        从 ng.conf.zip 删除条目、删除 conf.d 文件、清理桌面注入目录并重启 nginx。
  - status() -> dict
        返回 desktop_index_ok / ngconf_has_entry / confd_exists /
        keys_loaded / maintenance_running / method，可直接作为 HTTP 接口返回。
  - start_maintenance(interval=None) / stop_maintenance()
        启动/停止后台巡检线程（daemon），只做“缺失才补”的核对。
  - build_desktop_index() / desktop_index_ok() / expected_desktop_index()
        更细粒度的注入页控制，供调试或自定义流程使用。
  - sync_nginx_conf(allow_restart=True) -> (actions, error)
        仅同步 ng.conf.zip 与 conf.d，不处理注入页。

与现有 app.py 集成
  本项目（QWeather）的 app.py 已改为构造 InjectorConfig + FnOSInjector，
  并把 /api/inject、/api/uninstall、/api/inject_status 三个路由委托给它，
  启动即 ensure_installed() + start_maintenance()。可直接参照。

注意事项
  - 本模块导入时零副作用，仅在调用方法时才访问系统文件，可在任意环境安全 import。
  - 必须以 root 运行（要写 /usr/trim/... 与重启 nginx）。
  - 永远不写 /usr/trim/www 下任何文件，避免触发系统恢复风暴。
  - 注入页放在受保护区（vol1），build_desktop_index 已自动 chmod 755
    保证 nginx(www-data) 可穿越其目录。
"""
from __future__ import annotations

import os
import re
import sys
import json
import time
import struct
import shutil
import zlib
import zipfile
import threading
import subprocess

from dataclasses import dataclass


# ======================================================================
# 通用工具
# ======================================================================
def run_cmd(cmd, timeout=30):
    """执行 shell 命令，返回 (成功, 合并输出)。"""
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return result.returncode == 0, (result.stdout or "") + (result.stderr or "")
    except Exception as e:
        return False, str(e)


def read_file(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except Exception:
        return None


def write_file_direct(path, content, mode=0o644):
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(path, mode)
        return True
    except Exception:
        return False


# ======================================================================
# ZipCrypto（已知内部密钥时加密/解密新条目）
# 仅依赖标准库，可独立用于其它需要“往 fnOS 加密恢复包增删条目”的场景。
# =====================================================================
_CRC_TABLE = []
for _i in range(256):
    _c = _i
    for _ in range(8):
        _c = ((_c >> 1) ^ 0xEDB88320) if (_c & 1) else (_c >> 1)
    _CRC_TABLE.append(_c & 0xFFFFFFFF)


def crc32_bytes(b):
    return zlib.crc32(b) & 0xFFFFFFFF


def _zc_crc32(ch, crc):
    return (crc >> 8) ^ _CRC_TABLE[(crc ^ ch) & 0xFF]


def _zc_update_keys(keys, byte):
    keys[0] = _zc_crc32(byte, keys[0])
    keys[1] = (keys[1] + (keys[0] & 0xFF)) & 0xFFFFFFFF
    keys[1] = (keys[1] * 134775813 + 1) & 0xFFFFFFFF
    keys[2] = _zc_crc32((keys[1] >> 24) & 0xFF, keys[2])


def _zc_stream(keys):
    temp = (keys[2] | 2) & 0xFFFF
    return ((temp * (temp ^ 1)) >> 8) & 0xFF


def zipcrypto_encrypt(plaintext, keys, check_byte):
    """用已知内部密钥（K0,K1,K2）把明文按 ZipCrypto 加密。"""
    import random
    ks = list(keys)
    out = bytearray()
    # 12 字节头，最后一字节为校验字节
    header = bytes(random.randrange(256) for _ in range(11)) + \
        bytes([check_byte & 0xFF])
    for b in header:
        c = b ^ _zc_stream(ks)
        _zc_update_keys(ks, b)
        out.append(c)
    for b in plaintext:
        c = b ^ _zc_stream(ks)
        _zc_update_keys(ks, b)
        out.append(c)
    return bytes(out)


def zipcrypto_decrypt(cipher, keys):
    ks = list(keys)
    out = bytearray()
    for c in cipher:
        b = c ^ _zc_stream(ks)
        _zc_update_keys(ks, b)
        out.append(b)
    return bytes(out)


def dos_time(dt):
    """datetime 元组 -> (dos_time, dos_date)。dt 为 (y,m,d,hh,mm,ss)。"""
    y, m, d, hh, mm, ss = dt
    dos_date = ((max(y, 1980) - 1980) << 9) | (m << 5) | d
    dos_time = (hh << 11) | (mm << 5) | (ss // 2)
    return dos_time, dos_date


def build_new_extra(unix_ts, uid=0, gid=0):
    """构造与原条目一致的 28 字节扩展字段（UT + ux）。"""
    ut = b"UT" + struct.pack("<HBII", 9, 3, unix_ts, unix_ts)
    ux = b"ux" + struct.pack("<HBBIBI", 11, 1, 4, uid, 4, gid)
    return ut + ux


def read_raw_entries(zip_path):
    """解析 local headers，返回
    [(info, name:bytes, extra:bytes, data:bytes, descriptor:bytes)]。
    bit3 条目带 16 字节 data descriptor（PK0708+CRC+cs+us）。"""
    entries = []
    with zipfile.ZipFile(zip_path) as src:
        infos = src.infolist()
    with open(zip_path, "rb") as fh:
        for info in infos:
            fh.seek(info.header_offset)
            sig = fh.read(4)
            if sig != b"PK\x03\x04":
                raise ValueError("local header not found")
            hdr_rest = fh.read(26)
            nlen, xlen = struct.unpack("<HH", hdr_rest[22:26])
            name_extra = fh.read(nlen + xlen)
            data_raw = fh.read(info.compress_size)
            desc = b""
            if info.flag_bits & 0x0008:
                d = fh.read(16)
                if d[:4] == b"PK\x07\x08":
                    desc = d
            entries.append((info, name_extra[:nlen], name_extra[nlen:],
                            data_raw, desc))
    return entries


def _local_header(ver, flags, method, dtime, ddate, crc, csize, usize,
                  name, extra):
    return (b"PK\x03\x04" + struct.pack(
        "<HHHHHIIIHH", ver, flags, method, dtime, ddate, crc, csize, usize,
        len(name), len(extra)) + name + extra)


def _central_record(ver, flags, method, dtime, ddate, crc, csize, usize,
                    name, extra, offset, internal=0, external=0):
    return (b"PK\x01\x02" + struct.pack(
        "<HHHHHHIIIHHHHHII",
        0x0314, ver, flags, method, dtime, ddate, crc, csize, usize,
        len(name), len(extra), 0, 0, internal, external, offset) +
        name + extra)


def write_zip(zip_path, entries, new_entry=None):
    """重写 zip：entries 为原始 (info,name,extra,data)；
    new_entry 可选 (name:bytes, plaintext:bytes, keys)。"""
    tmp_path = zip_path + ".qwtemp"
    with open(tmp_path, "wb") as out:
        offsets = []
        for info, name, extra, data, desc in entries:
            offsets.append(out.tell())
            dtime, ddate = dos_time(info.date_time) if info.date_time[0] \
                else (0, 0)
            out.write(_local_header(
                info.extract_version, info.flag_bits, info.compress_type,
                dtime, ddate, info.CRC, info.compress_size, info.file_size,
                name, extra))
            out.write(data)
            if desc:
                out.write(desc)

        n_spec = None
        if new_entry is not None:
            nb, plaintext, keys = new_entry
            crc = zlib.crc32(plaintext) & 0xFFFFFFFF
            noff = out.tell()
            ndt = (1980, 1, 1, 12, 0, 0)
            ndtime, nddate = dos_time(ndt)
            nextra = build_new_extra(315576000)
            cipher = zipcrypto_encrypt(plaintext, keys,
                                       (ndtime >> 8) & 0xFF)
            out.write(_local_header(
                10, 0x0009, 0, ndtime, nddate, crc, len(cipher),
                len(plaintext), nb, nextra))
            out.write(cipher)
            out.write(b"PK\x07\x08" + struct.pack(
                "<III", crc, len(cipher), len(plaintext)))
            n_spec = (nb, crc, len(cipher), len(plaintext), noff,
                      ndtime, nddate, nextra)

        cd = bytearray()
        for (info, name, extra, _, _d), off in zip(entries, offsets):
            dtime, ddate = dos_time(info.date_time) if info.date_time[0] \
                else (0, 0)
            cd += _central_record(
                info.extract_version, info.flag_bits, info.compress_type,
                dtime, ddate, info.CRC, info.compress_size, info.file_size,
                name, extra, off, internal=info.internal_attr,
                external=info.external_attr)

        if n_spec is not None:
            nb, crc, clen, plen, noff, ndtime, nddate, nextra = n_spec
            cd += _central_record(
                10, 0x0009, 0, ndtime, nddate, crc, clen, plen,
                nb, nextra, noff, external=0x81ED0000)

        cd_start = out.tell()
        out.write(cd)
        cd_size = out.tell() - cd_start
        total = len(entries) + (1 if new_entry is not None else 0)
        out.write(b"PK\x05\x06" + struct.pack(
            "<HHHHIIH", 0, 0, total, total, cd_size, cd_start, 0))

    os.replace(tmp_path, zip_path)


def add_encrypted_entry(zip_path, arcname, plaintext_bytes, keys):
    """把新条目以 ZipCrypto + STORED 方式追加进 zip。"""
    entries = read_raw_entries(zip_path)
    write_zip(zip_path, entries,
              new_entry=(arcname.encode("utf-8"), plaintext_bytes, keys))
    return True


def remove_entry(zip_path, arcname):
    entries = [e for e in read_raw_entries(zip_path)
               if e[0].filename != arcname]
    write_zip(zip_path, entries)
    return True


def read_encrypted_entry(zip_path, arcname, keys):
    """解密指定条目并返回明文（不含 12 字节加密头）；
    不存在返回 None，解密结果 CRC 不符返回 False（视为损坏条目）。"""
    try:
        with zipfile.ZipFile(zip_path) as z:
            if arcname not in z.namelist():
                return None
            info = z.getinfo(arcname)
        with open(zip_path, "rb") as fh:
            fh.seek(info.header_offset)
            hdr = fh.read(30)
            if hdr[:4] != b"PK\x03\x04":
                return False
            nlen, xlen = struct.unpack("<HH", hdr[26:30])
            fh.read(nlen + xlen)
            raw = fh.read(info.compress_size)
        dec = zipcrypto_decrypt(raw, keys)
        body = dec[12:]
        if crc32_bytes(body) != info.CRC:
            return False
        return body
    except Exception:
        return False


def zip_contains(zip_path, arcname):
    try:
        with zipfile.ZipFile(zip_path) as z:
            return arcname in z.namelist()
    except Exception:
        return False


# ======================================================================
# 配置（全部参数化，方便其它程序注入不同 app）
# ======================================================================
@dataclass
class InjectorConfig:
    nginx_conf_zip: str                 # 加密恢复包，如 /usr/trim/share/.restore/ng.conf.zip
    conf_arcname: str                   # 写入恢复包的条目名，如 conf.d/myapp.conf
    conf_d_dir: str                     # 运行期 conf.d 目录，如 /usr/trim/nginx/conf/conf.d
    www_index: str                      # 系统桌面首页，如 /usr/trim/www/index.html
    app_data_dir: str                   # 受保护的应用数据目录，如 /vol1/@appdata/com.my.app
    keys_file: str                      # 含 k0/k1/k2 的 json（bkcrack 离线恢复）
    conf_content: str                   # 要写入恢复包的 nginx conf 文本
    script_tag: str                     # 注入到 </body> 前的 <script> 标签
    restart_cmd: str = "systemctl restart trim_nginx"
    rate_limit_sec: int = 180           # conf.d 不符时重启 nginx 的最小间隔
    maintenance_interval: int = 30      # 维护线程巡检间隔（秒）

    @property
    def conf_d_file(self):
        return os.path.join(self.conf_d_dir, os.path.basename(self.conf_arcname))

    @property
    def desktop_dir(self):
        return os.path.join(self.app_data_dir, "desktop")

    @property
    def desktop_index(self):
        return os.path.join(self.desktop_dir, "index.html")

    @property
    def pristine_hash_file(self):
        return os.path.join(self.desktop_dir, ".pristine.sha256")


# ======================================================================
# 注入器
# ======================================================================
class FnOSInjector:
    def __init__(self, config: InjectorConfig):
        self.cfg = config
        self._last_restart = 0.0
        self._maintenance_enabled = False
        self._maintenance_thread = None
        self._lock = threading.Lock()

    # ----- 密钥 -----
    def load_keys(self):
        try:
            data = json.loads(read_file(self.cfg.keys_file) or "")
            k0, k1, k2 = int(data["k0"]), int(data["k1"]), int(data["k2"])
            if not (0 <= k0 < 2**32 and 0 <= k1 < 2**32 and 0 <= k2 < 2**32):
                return None
            return [k0, k1, k2]
        except Exception:
            return None

    # ----- 注入页（系统首页 + script_tag 的副本）-----
    def expected_desktop_index(self):
        pristine = read_file(self.cfg.www_index)
        if pristine is None or self.cfg.script_tag in pristine:
            return None
        return pristine.replace("</body>", self.cfg.script_tag + "</body>", 1)

    def build_desktop_index(self):
        pristine = read_file(self.cfg.www_index)
        if pristine is None:
            return False, "无法读取系统 index.html"
        if self.cfg.script_tag in pristine:
            # 系统页已被旧方案注入（异常状态），不继续
            return False, "系统 index.html 含注入残留，需要先恢复系统"
        injected = pristine.replace("</body>", self.cfg.script_tag + "</body>", 1)
        os.makedirs(self.cfg.desktop_dir, exist_ok=True)
        # 显式保证 nginx(www-data) 可穿越目录（不依赖进程 umask）
        for d in (self.cfg.app_data_dir, self.cfg.desktop_dir):
            try:
                os.chmod(d, 0o755)
            except Exception:
                pass
        if not write_file_direct(self.cfg.desktop_index, injected):
            return False, "注入页写入失败"
        write_file_direct(
        self.cfg.pristine_hash_file,
        "%08x" % crc32_bytes(pristine.encode("utf-8")))
        return True, "注入页已生成"

    def desktop_index_ok(self):
        expected = self.expected_desktop_index()
        if expected is None:
            return False
        return read_file(self.cfg.desktop_index) == expected

    # ----- nginx -----
    def _nginx_restart(self):
        return run_cmd(self.cfg.restart_cmd, timeout=60)

    def sync_nginx_conf(self, allow_restart=True):
        """核对并同步 ng.conf.zip 中的加密条目 + 运行期 conf.d。
        返回本次实际执行的动作列表。"""
        detail = []
        keys = self.load_keys()
        if keys is None:
            return detail, "缺少 ZipCrypto 密钥文件"
        expected = self.cfg.conf_content.encode("utf-8")
        current = read_encrypted_entry(
            self.cfg.nginx_conf_zip, self.cfg.conf_arcname, keys)
        if current != expected:
            if current is not None:
                remove_entry(self.cfg.nginx_conf_zip, self.cfg.conf_arcname)
            add_encrypted_entry(
                self.cfg.nginx_conf_zip, self.cfg.conf_arcname, expected, keys)
            detail.append("ng.conf.zip")

        confd_current = read_file(self.cfg.conf_d_file)
        if confd_current != self.cfg.conf_content:
            if allow_restart and time.time() - self._last_restart > self.cfg.rate_limit_sec:
                self._nginx_restart()
                self._last_restart = time.time()
                time.sleep(3)
                detail.append("nginx-restart")
            else:
                detail.append("restart-rate-limited")
        return detail, None

    # ----- 安装 / 卸载 -----
    def ensure_installed(self, allow_restart=True):
        """完整安装/修复，返回 (成功, 描述)。"""
        detail = []

        # 1. 注入页
        if not self.desktop_index_ok():
            ok, msg = self.build_desktop_index()
            if not ok:
                return False, msg
            detail.append("desktop-index")

        # 2. ng.conf.zip 中的加密配置（核对内容，不仅是存在性）
        actions, err = self.sync_nginx_conf(allow_restart=allow_restart)
        if err:
            return False, err
        detail.extend(actions)

        return True, ",".join(detail) or "already-ok"

    def uninstall(self):
        """从桌面移除注入，返回 (成功, 描述)。"""
        try:
            if zip_contains(self.cfg.nginx_conf_zip, self.cfg.conf_arcname):
                remove_entry(self.cfg.nginx_conf_zip, self.cfg.conf_arcname)
        except Exception as e:
            return False, f"ng.conf.zip 清理失败: {e}"

        run_cmd(f"rm -f {self.cfg.conf_d_file}")
        self._nginx_restart()
        time.sleep(3)
        run_cmd(f"rm -rf {self.cfg.desktop_dir}")
        return True, "已卸载注入"

    # ----- 状态 -----
    def status(self):
        return {
            "desktop_index_ok": self.desktop_index_ok(),
            "ngconf_has_entry": zip_contains(
                self.cfg.nginx_conf_zip, self.cfg.conf_arcname),
            "confd_exists": os.path.exists(self.cfg.conf_d_file),
            "keys_loaded": self.load_keys() is not None,
            "maintenance_running":
                self._maintenance_thread is not None
                and self._maintenance_thread.is_alive(),
            "method": "alias + ng.conf.zip crypto-synced, zero www writes",
        }

    # ----- 维护线程（低频巡检，只在缺失时补写）-----
    def _maintenance_loop(self):
        while self._maintenance_enabled:
            try:
                self.ensure_installed()
            except Exception:
                pass
            time.sleep(self.cfg.maintenance_interval)

    def start_maintenance(self, interval=None):
        if interval is not None:
            self.cfg.maintenance_interval = interval
        with self._lock:
            self._maintenance_enabled = True
            if self._maintenance_thread is None or not self._maintenance_thread.is_alive():
                self._maintenance_thread = threading.Thread(
                    target=self._maintenance_loop, daemon=True)
                self._maintenance_thread.start()

    def stop_maintenance(self):
        with self._lock:
            self._maintenance_enabled = False
