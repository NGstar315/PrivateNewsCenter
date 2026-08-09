/*
 * updater.js —— 增量热更新（asar 热交换）+ 完整安装包兜底
 * ---------------------------------------------------------------
 * 设计目标（贴合本项目"单目录 + 最大通用性"诉求）：
 *   1. 日常更新只替换 resources/app.asar（网页+后端），体积约 0.5MB，秒级、重启即用。
 *   2. 双源容灾：主源 GitHub，超时/失败自动切 Gitee/mirror（version.json 内自带 mirror）。
 *   3. 通用写入：优先写入安装目录 resources/app.asar（无 UAC）；若该位置不可写
 *      （如朋友装到 C:\Program Files），则暂存到 %LOCALAPPDATA%/app.asar 覆盖层，
 *      下次启动由 main.js 以 --app 加载，安装目录一个字节都不必写。
 *   4. 大版本保护：若 version.json 标记的 electronVersion 与当前运行时不一致，
 *      无法热交换（exe 不变），则引导下载完整安装包覆盖。
 *   5. 数据零风险：app.asar 在 data/ 之外，替换天然不碰收藏/设置。
 *
 * version.json 推荐结构：
 * {
 *   "version": "1.1.8",
 *   "minVersion": "1.0.0",
 *   "releaseNotes": "修复…",
 *   "electronVersion": "31.0.0",
 *   "asar":    { "url": ".../app.asar", "mirror": ".../app.asar" },
 *   "installer":{ "url": ".../实时新闻中心-Setup-1.1.8.exe", "mirror": "..." },
 *   "mandatory": false
 * }
 */

const { ipcMain, shell, dialog, app } = require('electron');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const CHECK_DELAY_MS = 5000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 启动后每 4 小时再检查一次
const FETCH_TIMEOUT_MS = 15000;
const ASAR_DOWNLOAD_TIMEOUT_MS = 60000;

let currentVersion = '0.0.0';
let mainWindow = null;
let checkTimer = null;
let lastNotifiedVersion = null;

// ---------- 版本号比较 ----------
function parseVersion(v) {
  if (!v || typeof v !== 'string') return [0, 0, 0];
  const parts = v.replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}
function compareVersion(a, b) {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (av[i] > bv[i]) return 1;
    if (av[i] < bv[i]) return -1;
  }
  return 0;
}

// ---------- HTTP GET JSON（支持重定向 + 超时） ----------
function fetchJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'PrivateNewsCenter/' + currentVersion,
        'Accept': 'application/json,text/plain,*/*',
        'Cache-Control': 'no-cache'
      },
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJson(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error('HTTP ' + res.statusCode + ' @ ' + url));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse failed: ' + e.message)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout @ ' + url)); });
    req.on('error', reject);
  });
}

// 顺序尝试多个源，任一成功即返回
async function tryFetchInfo(urls) {
  let lastErr;
  for (const url of urls) {
    try { return await fetchJson(url); }
    catch (e) { lastErr = e; console.log('[updater] fetch failed:', url, e.message); }
  }
  throw lastErr || new Error('all update sources failed');
}

// 读取用户自定义 version.json 源（设置页：主源 + 镜像），否则用内置默认
function readVersionUrls() {
  let urls = [];
  try {
    const exeDir = path.dirname(app.getPath('exe'));
    const candidate = path.join(exeDir, 'data');
    let dataDir;
    try {
      if (!fs.existsSync(candidate)) fs.mkdirSync(candidate, { recursive: true });
      const probe = path.join(candidate, '.writable-test');
      fs.writeFileSync(probe, '1');
      fs.unlinkSync(probe);
      dataDir = candidate;
    } catch (_) {
      dataDir = path.join(app.getPath('userData'), 'data');
    }
    const settingsPath = path.join(dataDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8') || '{}');
      if (s.updateUrl) urls.push(s.updateUrl);
      if (Array.isArray(s.updateMirrors)) urls.push(...s.updateMirrors);
    }
  } catch (_) { /* ignore */ }

  if (urls.length === 0) {
    urls = [
      'https://raw.githubusercontent.com/NGstar315/PrivateNewsCenter/main/version.json',
      'https://gitee.com/你的用户名/PrivateNewsCenter/raw/main/version.json'
    ];
  }
  return urls;
}

// 把 version.json 里的 asar/installer 字段统一成 {url, mirror}
function pickAsset(field) {
  if (!field) return null;
  if (typeof field === 'string') return { url: field, mirror: null };
  return { url: field.url || null, mirror: field.mirror || null };
}

// 仅比较 Electron 主.次号：补丁号变化（31.3.0→31.3.1）不触发完整重装
function electronMajorMinor(v) {
  const p = parseVersion(v);
  return p[0] * 100 + p[1];
}

// 组装推送给前端的 info
function buildInfo(info) {
  const curMM = electronMajorMinor(process.versions.electron);
  const newMM = info.electronVersion ? electronMajorMinor(info.electronVersion) : curMM;
  const electronMismatch = newMM !== curMM;
  return {
    currentVersion,
    latestVersion: info.version,
    releaseNotes: info.releaseNotes || '',
    mandatory: !!info.mandatory,
    electronVersion: info.electronVersion || null,
    electronMismatch,
    asar: pickAsset(info.asar),
    installer: pickAsset(info.installer)
  };
}

// 检查更新：返回 info（有更新）或 null（已最新/失败）。有更新时同时推送事件供自动提示。
async function checkForUpdates(showNoUpdateDialog = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const urls = readVersionUrls();
  try {
    const info = await tryFetchInfo(urls);
    if (!info || !info.version) throw new Error('invalid version.json');

    if (compareVersion(info.version, currentVersion) <= 0) {
      if (showNoUpdateDialog) {
        dialog.showMessageBox(mainWindow, {
          type: 'info', title: '已是最新版本',
          message: `当前版本 v${currentVersion}，已是最新。`, buttons: ['确定']
        });
      }
      return null;
    }

    const built = buildInfo(info);
    if (lastNotifiedVersion !== info.version) {
      lastNotifiedVersion = info.version;
      mainWindow.webContents.send('update-available', built);
    }
    return built;
  } catch (e) {
    console.log('[updater] check failed:', e.message);
    if (showNoUpdateDialog) {
      dialog.showMessageBox(mainWindow, {
        type: 'warning', title: '检查更新失败',
        message: '无法连接到更新服务器，请检查网络或稍后再试。',
        detail: e.message, buttons: ['确定']
      });
    }
    return null;
  }
}

// ---------- 下载二进制（带回传进度） ----------
function downloadBuffer(url, timeoutMs, onProgress) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'PrivateNewsCenter/' + currentVersion, 'Accept': '*/*' },
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location, timeoutMs, onProgress).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      const chunks = [];
      let received = 0;
      res.on('data', (c) => {
        received += c.length; chunks.push(c);
        if (total && onProgress) onProgress(Math.min(99, Math.floor(received / total * 100)));
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function tryDownload(urls, onProgress) {
  let lastErr;
  for (const u of urls) {
    if (!u) continue;
    try { return await downloadBuffer(u, ASAR_DOWNLOAD_TIMEOUT_MS, onProgress); }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no download url');
}

// ---------- 写入并重启 ----------
function relaunch(viaOverride) {
  const overrideAsar = path.join(app.getPath('userData'), 'app.asar');
  if (viaOverride) {
    app.relaunch({ args: ['--app=' + overrideAsar], exe: app.getPath('exe') });
  } else {
    app.relaunch();
  }
  setTimeout(() => app.exit(0), 300);
}

// 优先写安装目录（保持单目录、无 UAC）；失败则落到 userData 覆盖层
function applyAsar(buffer) {
  const exeDir = path.dirname(app.getPath('exe'));
  const resourcesAsar = path.join(exeDir, 'resources', 'app.asar');
  const overrideAsar = path.join(app.getPath('userData'), 'app.asar');

  try {
    fs.writeFileSync(resourcesAsar, buffer);
    try { if (fs.existsSync(overrideAsar)) fs.unlinkSync(overrideAsar); } catch (_) {}
    relaunch(false);
    return { ok: true, restart: true };
  } catch (_) {
    // 安装目录不可写（Program Files 等）→ 覆盖层
    try {
      fs.writeFileSync(overrideAsar, buffer);
      relaunch(true);
      return { ok: true, restart: true };
    } catch (e2) {
      return { ok: false, reason: 'write-failed: ' + e2.message };
    }
  }
}

// 前端调用：执行下载 + 替换 + 重启
async function downloadUpdate(info) {
  if (!info) return { ok: false, reason: 'no-info' };

  // 大版本：Electron 运行时变化，无法热交换 → 引导完整安装包
  if (info.electronMismatch) {
    const inst = info.installer;
    if (inst && inst.url) {
      try { await shell.openExternal(inst.mirror || inst.url); } catch (_) {}
      return { ok: false, needsInstaller: true, url: inst.mirror || inst.url };
    }
    return { ok: false, needsInstaller: true };
  }

  const asar = info.asar;
  if (!asar || !asar.url) return { ok: false, reason: 'no-asar-url' };

  const urls = [asar.url, asar.mirror].filter(Boolean);
  const notify = (pct) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-progress', pct);
  };

  let buffer;
  try { buffer = await tryDownload(urls, notify); }
  catch (e) { return { ok: false, reason: 'download-failed: ' + e.message }; }

  // 轻量校验：asar 以 "!ARS" 魔法字节开头
  if (!buffer || buffer.length < 1000 ||
      !(buffer[0] === 0x21 && buffer[1] === 0x41 && buffer[2] === 0x52 && buffer[3] === 0x53)) {
    return { ok: false, reason: 'invalid-asar' };
  }

  return applyAsar(buffer);
}

// ---------- 初始化 ----------
function initUpdater(window, appVersion) {
  mainWindow = window;
  currentVersion = appVersion || require('./package.json').version;

  setTimeout(() => checkForUpdates(false), CHECK_DELAY_MS);
  if (checkTimer) clearInterval(checkTimer);
  checkTimer = setInterval(() => checkForUpdates(false), CHECK_INTERVAL_MS);

  ipcMain.handle('check-for-updates', () => checkForUpdates(true));
  ipcMain.handle('download-update', (event, info) => downloadUpdate(info));
  ipcMain.handle('open-update-download', (event, url) => { if (url) shell.openExternal(url); });
  ipcMain.handle('dismiss-update', (event, version) => { lastNotifiedVersion = version || lastNotifiedVersion; });
}

module.exports = { initUpdater };
