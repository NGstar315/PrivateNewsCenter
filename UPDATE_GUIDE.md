# PrivateNewsCenter 自动更新方案

## 方案概述

本项目采用**增量热更新（asar 热交换）**：日常更新只替换 `resources/app.asar`（网页 + 后端代码），体积约 0.5MB，后台下载、重启即用，无需代码签名、无需管理员权限。仅当 Electron 运行时大版本变化（主.次号不同）时才引导下载完整安装包覆盖。

该方案兼顾了你的两个核心诉求：
- **单目录**：安装目录下 `NewsCenter.exe` + `resources/app.asar` + `data/` 始终在一起，更新只动 `app.asar`。
- **最大通用性**：朋友装到任意位置都能无感更新——
  - 装在可写目录（如 D:\、便携版）：直接替换 `resources/app.asar`，无 UAC。
  - 装在 `C:\Program Files`（默认安装器路径，受 UAC 保护）：新 asar 暂存到 `%LOCALAPPDATA%/app.asar` 覆盖层，下次启动由主程序以 `--app` 加载，**安装目录一个字节都不必写**。

---

## 客户端行为

1. 启动 5 秒后自动检查更新；之后每 4 小时再检查一次。
2. 设置页可点击 **"检查更新"** 手动触发。
3. 发现新版本时，顶部出现提示条：
   - **普通更新**（同 Electron 版本）：点 **"更新并重启"** → 后台下载 asar → 自动替换 → 重启。进度实时显示。
   - **大版本更新**（Electron 主.次号变化）：点 **"下载安装包"** → 打开完整安装包下载页，手动运行覆盖安装。
   - 可点 **✕** 忽略本次。
4. 更新**只替换程序**，绝不触碰 `data/`（收藏、设置、缓存天然保留）。

---

## version.json 格式

发布新版本时，将以下文件放到更新服务器（或 GitHub/Gitee 仓库根目录）：

```json
{
  "version": "1.1.8",
  "minVersion": "1.0.0",
  "releaseNotes": "修复…",
  "electronVersion": "31.3",
  "asar": {
    "url": "https://github.com/你的用户名/PrivateNewsCenter/releases/download/v1.1.8/app.asar",
    "mirror": "https://gitee.com/你的用户名/PrivateNewsCenter/releases/download/v1.1.8/app.asar"
  },
  "installer": {
    "url": "https://github.com/你的用户名/PrivateNewsCenter/releases/download/v1.1.8/实时新闻中心-Setup-1.1.8.exe",
    "mirror": "https://gitee.com/你的用户名/PrivateNewsCenter/releases/download/v1.1.8/实时新闻中心-Setup-1.1.8.exe"
  },
  "mandatory": false
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `version` | 是 | 最新版本号 `x.y.z` |
| `minVersion` | 否 | 低于此版本会强制更新 |
| `releaseNotes` | 否 | 更新说明，显示在提示条 |
| `electronVersion` | 是 | Electron 主.次号（如 `31.3`）。与客户端运行时**主.次号不同**时触发完整安装包 |
| `asar.url` / `asar.mirror` | 是 | 增量包 app.asar 的主源 / 备源下载地址 |
| `installer.url` / `installer.mirror` | 是 | 完整安装包主源 / 备源 |
| `mandatory` | 否 | `true` 时强制更新并弹模态框 |

---

## 更新源配置（主 / 副线路）

客户端默认按以下顺序查找 `version.json`：

1. 设置页填写的 **"更新源 URL"**（主源）。
2. 设置页填写的 **"镜像地址"**（逗号分隔，依次尝试，副源）。
3. 内置默认源（GitHub raw → Gitee raw 兜底）。

> 发布前请把所有 `你的用户名` 占位符替换为你的真实 GitHub / Gitee 用户名。

---

## 发布新版本流程

### 1. 更新版本号

```bash
node scripts/publish.js 1.1.8
```

自动完成：更新 `package.json`、`installer.nsi` / `portable.nsi` 的版本号，并按新 schema 生成 `version.json`（含 asar / installer 双链接 + 自动提取 Electron 主.次号）。

### 2. 打包

- **完整安装包 / 便携版**：用 `makensis.exe` 分别编译 `installer.nsi` 和 `portable.nsi`。
- **增量包 app.asar**（关键）：用官方 `@electron/asar` 把 `dist/NewsCenter` 的内容（package.json / main.js / preload.js / index.html / assets）打成 `app.asar`：

```bash
node node_modules/asar/bin/asar.js pack dist/NewsCenter dist/app.asar
```

> 切勿手写 asar 头——必须用官方 `@electron/asar`，否则 Electron 启动即崩。

### 3. 上传到 Release

把以下三个产物上传到 GitHub / Gitee Release Assets（同一 tag `v1.1.8`）：

- `app.asar`（增量包，日常更新用）
- `实时新闻中心-Setup-1.1.8.exe`（完整安装包，大版本 / 新用户用）
- `实时新闻中心.exe`（便携版）

并把 `version.json` 提交到仓库根目录（或上传到你的 CDN）。

### 4. 客户端自动发现

已安装的旧版本下次启动 / 手动检查时，会拉取 `version.json`，按需走"增量热交换"或"下载安装包"。

---

## 覆盖层机制（Program Files 免 UAC 的关键）

- 增量更新优先写 `resources/app.asar`；若该目录不可写（`EACCES` / `EPERM`，典型如 `C:\Program Files`），则写 `%LOCALAPPDATA%/PrivateNewsCenter/app.asar`。
- 主程序每次启动头部会检查该覆盖层：若存在且魔法字节合法（`!ARS`），且当前**不是**已用 `--app` 加载它，则以 `--app=<覆盖层>` 重启加载新代码，安装目录保持只读。
- 覆盖层损坏会被自动删除并回退正常启动，避免"开不了机"。

---

## 跨设备数据同步

自动更新只更新程序本身，**不会同步收藏和设置**（`data/` 在 app.asar 之外）。多设备同步推荐：

1. 设置页"导出/导入 JSON"（可自行扩展）。
2. 把 `data/` 放进 WebDAV / 坚果云等同步盘。
3. 加密后存 GitHub Gist 自动同步。
4. 自建后端 API。

---

## 安全提示

- 首次运行安装包时 Windows 可能提示 SmartScreen（缺代码签名），点"更多信息 → 仍要运行"即可。
- `version.json` 与下载服务器必须可靠，避免被篡改引导下载恶意程序。
- 增量包 `app.asar` 同样应从可信 Release 下载；客户端已做 `!ARS` 魔法字节校验，损坏包会被拒绝。
