/*
 * main.js —— Electron 主进程（独立系统进程）
 * ---------------------------------------------------------------
 * 专业说明：
 *   - 创建桌面窗口并加载 index.html；
 *   - 通过 ipcMain.handle('fetch-url') 在"主进程"里做网络请求，避开浏览器跨域限制；
 *   - 通过 ipcMain.handle('storage-*') / 'image-cache' 提供本地持久化能力：
 *       设置文件、按天缓存、图片本地化（UUID 命名，绝不重复）；
 *   - 外部链接用系统默认浏览器打开（shell.openExternal）。
 *
 * 通俗说明：
 *   这个文件就是"把网页变成 Windows 程序"的壳。它另起一个后台进程去
 *   网上抓新闻、把图片下载到本地、把设置与缓存写到程序目录下的 data 文件夹，
 *   再把内容交给界面显示。
 * ---------------------------------------------------------------
 */
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, Notification, dialog, protocol, net } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { initUpdater } = require('./updater');

// 自定义协议 app-file://：把 data/downloads 里的本地文档以内嵌方式交给正文框渲染
// （绕过 file:// 的安全限制，同时只暴露下载目录，避免任意本地文件读取）
protocol.registerSchemesAsPrivileged([
  { scheme: 'app-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }
]);

// ---------- 覆盖层引导（无 UAC 热更新的关键） ----------
// 若 %LOCALAPPDATA%/app.asar 存在（上次因安装目录不可写而暂存于此的更新），
// 且当前并非已通过 --app 加载该覆盖层，则以 --app 重启加载它；损坏则删除回退。
(function applyOverrideIfNeeded() {
  try {
    const override = path.join(app.getPath('userData'), 'app.asar');
    if (!fs.existsSync(override)) return;
    if (process.argv.some(a => a.startsWith('--app='))) return; // 已在覆盖层运行
    const fd = fs.openSync(override, 'r');
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    if (!(head[0] === 0x21 && head[1] === 0x41 && head[2] === 0x52 && head[3] === 0x53)) {
      fs.unlinkSync(override); // 损坏的覆盖层直接丢弃，避免开不了机
      return;
    }
    app.relaunch({ args: ['--app=' + override], exe: app.getPath('exe') });
    app.exit(0);
  } catch (e) {
    console.error('[override] failed:', e);
  }
})();

// 单实例：避免重复启动产生多个托盘图标 / 多个后台进程
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on('second-instance', () => { showWindow(); });

// ---------- 数据目录 ----------
// 用户数据（收藏 / 关注 / 标签 / 设置）与程序目录解耦：
// 默认放系统用户数据目录，升级或更换解压目录都不会丢；
// 若该位置不可写，再回退到 exe 同级 data/（便携场景）。
function defaultDataDir() {
  try {
    const p = path.join(app.getPath('userData'), 'data');
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    const probe = path.join(p, '.writable-test');
    fs.writeFileSync(probe, '1');
    fs.unlinkSync(probe);
    return p;
  } catch (_) {
    const exeDir = path.dirname(app.getPath('exe'));
    const candidate = path.join(exeDir, 'data');
    try { if (!fs.existsSync(candidate)) fs.mkdirSync(candidate, { recursive: true }); } catch (_) { /* ignore */ }
    return candidate;
  }
}

// 一次性迁移：旧版把数据放在 exe/data，新版默认在 userData/data。
// 只迁移「用户长持久化数据」，不迁移 cache/images 等可重建内容。
function migrateLegacyUserData() {
  try {
    const legacy = path.join(path.dirname(app.getPath('exe')), 'data');
    const current = path.join(app.getPath('userData'), 'data');
    if (path.resolve(legacy) === path.resolve(current)) return;
    if (!fs.existsSync(legacy)) return;
    if (fs.existsSync(path.join(current, 'settings.json'))) return; // 已有新数据，绝不覆盖
    const USER_FILES = ['settings.json', 'favorites.json', 'read_state.json', 'tags.json',
      'user_sources.json', 'source_health.json', 'window_state.json'];
    fs.mkdirSync(current, { recursive: true });
    for (const f of USER_FILES) {
      const src = path.join(legacy, f);
      if (fs.existsSync(src)) {
        try { fs.copyFileSync(src, path.join(current, f)); } catch (_) { /* ignore */ }
      }
    }
    // 旧 settings 若把 dataDir 指到旧目录，清空该字段，避免继续写回旧路径
    try {
      const sp = path.join(current, 'settings.json');
      if (fs.existsSync(sp)) {
        const s = JSON.parse(fs.readFileSync(sp, 'utf-8') || '{}');
        if (s && s.dataDir && path.resolve(s.dataDir) === path.resolve(legacy)) {
          delete s.dataDir;
          fs.writeFileSync(sp, JSON.stringify(s, null, 2));
        }
      }
    } catch (_) { /* ignore */ }
  } catch (_) { /* ignore */ }
}

// 启动时先读默认位置 settings.json 看是否自定义了 dataDir
function resolveDataDir() {
  const base = defaultDataDir();
  try {
    const p = path.join(base, 'settings.json');
    if (fs.existsSync(p)) {
      const s = JSON.parse(fs.readFileSync(p, 'utf-8') || '{}');
      if (s && s.dataDir && typeof s.dataDir === 'string' && fs.existsSync(s.dataDir)) {
        return s.dataDir;
      }
    }
  } catch (_) { /* ignore */ }
  return base;
}

// 先迁移旧版用户数据，再解析最终数据目录
migrateLegacyUserData();
let DATA_DIR = resolveDataDir();

// ---------- 托盘 / 后台刷新全局状态 ----------
let win = null;                 // 主窗口
let tray = null;                // 系统托盘
let quitting = false;          // 是否主动退出（区分"关闭到后台"与"真正退出"）
let backgroundRefresh = true;   // 关闭窗口后保留进程后台刷新（可在设置页关闭）

// 从已落盘的设置读取后台刷新开关（保持与主进程/渲染进程一致）
function loadBackgroundRefresh() {
  try {
    const p = path.join(DATA_DIR, 'settings.json');
    if (fs.existsSync(p)) {
      const s = JSON.parse(fs.readFileSync(p, 'utf-8') || '{}');
      if (typeof s.backgroundRefresh === 'boolean') return s.backgroundRefresh;
    }
  } catch (_) { /* ignore */ }
  return true;
}
backgroundRefresh = loadBackgroundRefresh();

// 唤出窗口（点击托盘图标 / "唤出窗口"菜单）
function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// 真正退出程序（托盘"结束程序"）
function quitApp() {
  quitting = true;
  if (win) { try { win.destroy(); } catch (_) { /* ignore */ } }
  app.quit();
}

// 构建托盘右键菜单
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '唤出窗口', click: () => showWindow() },
    { label: '刷新新闻 + 热搜', click: () => { if (win && win.webContents) win.webContents.send('tray-trigger-refresh'); } },
    { type: 'separator' },
    { label: '结束程序', click: () => quitApp() }
  ]);
}

// 创建系统托盘（含图标与右键菜单）
function createTray() {
  try {
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    let img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) {
      // 兜底：内置一个极简蓝色图标，避免图标缺失导致托盘创建失败
      const fallbackB64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAOElEQVR4nO3BMQEAAADCoPVPbQ0PoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKgB9pgAAaOb0wQAAAAASUVORK5CYII=';
      img = nativeImage.createFromBuffer(Buffer.from(fallbackB64, 'base64'));
    }
    tray = new Tray(img);
    tray.setToolTip('实时新闻中心');
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', () => showWindow());
  } catch (e) {
    console.error('[tray] create failed:', e);
  }
}

function imagesDir() { return path.join(DATA_DIR, 'images'); }
function cacheDir() { return path.join(DATA_DIR, 'cache'); }
function manifestPath() { return path.join(DATA_DIR, 'image_manifest.json'); }

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ---------- 安全路径归一化 + 日志 ----------
// 所有 storage-* 文件操作都强制落在 DATA_DIR 内；传入绝对路径或 .. 越界的一律拒绝，
// 避免渲染进程（含被注入的内容）读写/删除 data 目录之外的任意本地文件。
function safeDataPath(p) {
  if (p == null) return null;
  const root = path.resolve(DATA_DIR);
  let resolved;
  try { resolved = path.resolve(root, String(p)); } catch (_) { return null; }
  // 允许 DATA_DIR 本身；其余必须在其内部
  if (resolved === root) return resolved;
  if (resolved.startsWith(root + path.sep)) return resolved;
  return null;
}

// 滚动日志：写入 data/logs/app.log，超过 2MB 截断保留后半，避免无限增长
function writeLog(level, msg) {
  try {
    const d = path.join(DATA_DIR, 'logs');
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, 'app.log');
    const line = '[' + new Date().toISOString() + '] [' + level + '] ' + msg + '\n';
    if (fs.existsSync(f) && fs.statSync(f).size > 2 * 1024 * 1024) {
      const old = fs.readFileSync(f, 'utf-8');
      fs.writeFileSync(f, old.slice(-1024 * 1024) + line);
    } else {
      fs.appendFileSync(f, line);
    }
  } catch (_) { /* 日志失败不应影响主流程 */ }
}

// 内存中的图片映射表（url -> { id, file, ext }），启动时从盘恢复
let IMAGE_MANIFEST = {};
function loadManifest() {
  try {
    const p = manifestPath();
    if (fs.existsSync(p)) {
      IMAGE_MANIFEST = JSON.parse(fs.readFileSync(p, 'utf-8') || '{}');
    }
  } catch (_) { IMAGE_MANIFEST = {}; }
}
function saveManifest() {
  try {
    ensureDir(DATA_DIR);
    fs.writeFileSync(manifestPath(), JSON.stringify(IMAGE_MANIFEST, null, 2));
  } catch (_) { /* ignore */ }
}
loadManifest();

// manifest 防抖写盘：一次刷新会下载大量图片，合并为 500ms 后一次写入，避免高频同步 IO
let manifestSaveTimer = null;
function saveManifestDebounced() {
  if (manifestSaveTimer) return;
  manifestSaveTimer = setTimeout(() => { manifestSaveTimer = null; saveManifest(); }, 500);
}

// 图片下载并发池：限制同时下载的图片数，避免滚动/刷新时无节制并发拉垮主进程
const IMAGE_MAX_CONCURRENT = 6;
let imageInflight = 0;
const imageWaiters = [];
function acquireImageSlot() {
  return new Promise(resolve => {
    if (imageInflight < IMAGE_MAX_CONCURRENT) { imageInflight++; resolve(); }
    else imageWaiters.push(resolve);
  });
}
function releaseImageSlot() {
  imageInflight--;
  const next = imageWaiters.shift();
  if (next) { imageInflight++; next(); }
}

function extFromType(type, url) {
  const map = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
    'image/svg+xml': 'svg', 'image/bmp': 'bmp'
  };
  if (type && map[type.toLowerCase()]) return map[type.toLowerCase()];
  const m = (url || '').match(/\.(jpg|jpeg|png|webp|gif|avif|svg|bmp)(?:[?#]|$)/i);
  return m ? m[1].toLowerCase() : 'jpg';
}

// 下载图片到本地 images/，文件名用 UUID（永不重复），返回 file:// 绝对路径
async function cacheImage(url) {
  if (!url) return { ok: false, url: '' };
  // 已缓存且文件还在 -> 直接返回（不占并发槽，命中即秒开）
  const hit = IMAGE_MANIFEST[url];
  if (hit) {
    const fp = path.join(imagesDir(), hit.file);
    if (fs.existsSync(fp)) return { ok: true, url: 'file:///' + fp.replace(/\\/g, '/') };
  }
  await acquireImageSlot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                       '(KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/png,image/*,*/*;q=0.8',
        'Referer': 'https://www.google.com/'
      },
      signal: controller.signal
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500) throw new Error('图片过小');
    const ext = extFromType(res.headers.get('content-type'), url);
    const id = crypto.randomUUID().replace(/-/g, '');
    const file = 'img_' + id + '.' + ext;
    ensureDir(imagesDir());
    fs.writeFileSync(path.join(imagesDir(), file), buf);
    IMAGE_MANIFEST[url] = { id, file, ext };
    saveManifestDebounced();
    return { ok: true, url: 'file:///' + path.join(imagesDir(), file).replace(/\\/g, '/') };
  } catch (e) {
    return { ok: false, url: '' };
  } finally {
    clearTimeout(timer);
    releaseImageSlot();
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 850,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1419',
    show: false, // 先隐藏，ready-to-show 再显示，避免白屏闪烁
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      plugins: true // 启用内置 PDF 查看器，正文框可直接内嵌在线 PDF
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 关闭窗口时：若开启"后台刷新"且非主动退出，则隐藏到托盘而非销毁进程
  let notifiedMinimize = false;
  win.on('close', (e) => {
    if (!quitting && backgroundRefresh) {
      e.preventDefault();
      win.hide();
      // 首次缩到托盘时提示一次，避免用户以为程序已退出
      if (!notifiedMinimize) {
        notifiedMinimize = true;
        try {
          if (Notification.isSupported()) {
            new Notification({
              title: '实时新闻中心',
              body: '程序已最小化到系统托盘，仍在后台刷新新闻。可点击托盘图标唤出，右键「结束程序」完全退出。'
            }).show();
          }
        } catch (_) { /* ignore */ }
      }
    }
  });

  win.once('ready-to-show', () => { if (win && !win.isDestroyed()) win.show(); });
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  // 初始化轻量更新检查
  try {
    initUpdater(win, app.getVersion());
  } catch (e) {
    console.error('[updater] init failed:', e);
  }

  // 初始化 Fever API 只读服务（设置开启时）
  try {
    startFeverServer();
  } catch (e) {
    console.error('[fever] init failed:', e);
  }

  // 后台抓取文本（原有能力）
  // 按 URL 缓存上次响应体，用于条件请求（304）时回放，避免重复下载
  const feedCache = new Map();

  // 编码归一化：把常见中文编码别名映射到 TextDecoder 支持的名称
  function normalizeEncoding(enc) {
    if (!enc) return 'utf-8';
    const e = enc.toLowerCase().trim();
    if (e === 'utf8') return 'utf-8';
    if (e === 'gb2312' || e === 'gb18030') return 'gbk';
    return e;
  }

  // 根据响应头或 HTML <meta charset> 自动检测编码并解码，避免 GBK 页面被当 UTF-8 读成乱码
  function decodeBuffer(buf, contentType) {
    let enc = null;
    if (contentType) {
      const m = contentType.match(/charset=([^\s;"]+)/i);
      if (m) enc = normalizeEncoding(m[1].replace(/["']/g, ''));
    }
    if (!enc) {
      const probe = buf.toString('latin1').slice(0, 4096);
      const meta = probe.match(/<meta[^>]*charset=["']?([^"'>;\s]+)/i) ||
                   probe.match(/<meta[^>]*http-equiv=["']?content-type["']?[^>]*content=["']?[^"'>]*charset=([^"'>;\s]+)/i);
      if (meta) enc = normalizeEncoding(meta[1]);
    }
    enc = enc || 'utf-8';
    try {
      return new TextDecoder(enc, { fatal: false }).decode(buf);
    } catch (e) {
      return buf.toString('utf-8');
    }
  }

  ipcMain.handle('fetch-url', async (event, url, opts) => {
    opts = opts || {};
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                     '(KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/rss+xml,' +
                'application/atom+xml,text/xml;q=0.8,image/webp,*/*;q=0.5',
      'Accept-Language': 'zh-CN,zh;q=0.9,en-US,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': 'https://www.google.com/',
      'sec-ch-ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1'
    };
    if (opts.etag) headers['If-None-Match'] = opts.etag;
    if (opts.lastModified) headers['If-Modified-Since'] = opts.lastModified;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      let res = await fetch(url, { headers, signal: controller.signal });
      if (res.status === 304) {
        const cached = feedCache.get(url);
        if (cached && cached.body) {
          return { ok: true, status: 304, notModified: true, body: cached.body, etag: cached.etag, lastModified: cached.lastModified };
        }
        // 无缓存（如重启后首次）：去掉条件头，用独立超时重新抓取
        const h2 = Object.assign({}, headers);
        delete h2['If-None-Match'];
        delete h2['If-Modified-Since'];
        const c2 = new AbortController();
        const t2 = setTimeout(() => c2.abort(), 15000);
        try {
          res = await fetch(url, { headers: h2, signal: c2.signal });
        } finally {
          clearTimeout(t2);
        }
      }
      if (!res.ok) throw new Error('HTTP ' + res.status + ' @ ' + url);
      const buf = Buffer.from(await res.arrayBuffer());
      const body = decodeBuffer(buf, res.headers.get('content-type'));
      const etag = res.headers.get('etag');
      const lastModified = res.headers.get('last-modified');
      feedCache.set(url, { body, etag, lastModified });
      return { ok: true, status: res.status, notModified: false, body, etag, lastModified };
    } catch (e) {
      writeLog('warn', 'fetch-url failed: ' + url + ' ' + (e && e.message));
      throw e;
    } finally {
      clearTimeout(timer);
    }
  });

  // 图片本地化缓存（UUID 命名，绝不重复）
  ipcMain.handle('image-cache', async (event, url) => {
    return await cacheImage(url);
  });

  // 外部链接用系统浏览器打开
  ipcMain.handle('open-external', async (event, url) => {
    if (url) shell.openExternal(url);
  });

  // 热搜网页兜底抓取：主进程带完整浏览器头请求，避开 CORS
  ipcMain.handle('fetch-hot-html', async (event, url, extraHeaders) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                         '(KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'sec-ch-ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-site': 'none',
          'sec-fetch-user': '?1',
          'upgrade-insecure-requests': '1',
          ...(extraHeaders || {})
        },
        signal: controller.signal
      });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' @ ' + url);
      const buf = Buffer.from(await res.arrayBuffer());
      return decodeBuffer(buf, res.headers.get('content-type'));
    } finally {
      clearTimeout(timer);
    }
  });

  // ---------- 持久化：设置 / 缓存 / 清理 ----------
  ipcMain.handle('app-paths', () => ({
    dataDir: DATA_DIR,
    imagesDir: imagesDir(),
    cacheDir: cacheDir()
  }));

  // 用户长持久化文件：需要 .bak 备份 + 原子写，避免崩溃/断电导致收藏与设置丢失
  const USER_DATA_FILES = /^(settings|favorites|read_state|tags|user_sources|source_health|window_state|user_watch)\.json$/;

  ipcMain.handle('storage-read', (event, file) => {
    try {
      const p = safeDataPath(file);
      if (!p) return null;
      const readSafe = (fp) => { try { return fs.readFileSync(fp, 'utf-8'); } catch (_) { return null; } };
      const isUserData = USER_DATA_FILES.test(path.basename(p));
      const raw = readSafe(p);
      if (raw != null) {
        if (isUserData) {
          try { JSON.parse(raw); } catch (_) {
            const bak = readSafe(p + '.bak');
            if (bak != null) {
              writeLog('warn', 'storage-read: 主文件损坏，已回落 .bak -> ' + file);
              return bak;
            }
          }
        }
        return raw;
      }
      // 主文件不存在时，用户数据尝试 .bak
      if (isUserData) return readSafe(p + '.bak');
      return null;
    } catch (e) { writeLog('error', 'storage-read failed: ' + (e && e.message)); return null; }
  });

  ipcMain.handle('storage-write', (event, file, content) => {
    try {
      const p = safeDataPath(file);
      if (!p) { writeLog('warn', 'storage-write rejected path: ' + file); return false; }
      ensureDir(path.dirname(p));
      const isUserData = USER_DATA_FILES.test(path.basename(p));
      if (isUserData && fs.existsSync(p)) {
        try { fs.copyFileSync(p, p + '.bak'); } catch (_) { /* ignore */ }
      }
      // 临时文件 + 原子重命名：写一半时崩溃也不会破坏原文件
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, p);
      return true;
    } catch (e) { writeLog('error', 'storage-write failed: ' + (e && e.message)); return false; }
  });

  ipcMain.handle('storage-exists', (event, file) => {
    const p = safeDataPath(file);
    return !!p && fs.existsSync(p);
  });

  ipcMain.handle('storage-list', (event, dir) => {
    try {
      const d = safeDataPath(dir || '');
      if (!d || !fs.existsSync(d)) return [];
      return fs.readdirSync(d).filter(f => {
        try { return fs.statSync(path.join(d, f)).isFile(); } catch (_) { return false; }
      });
    } catch (e) { writeLog('error', 'storage-list failed: ' + (e && e.message)); return []; }
  });

  ipcMain.handle('storage-delete-file', (event, file) => {
    try {
      const p = safeDataPath(file);
      if (!p) { writeLog('warn', 'storage-delete-file rejected path: ' + file); return false; }
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return true;
    } catch (e) { writeLog('error', 'storage-delete-file failed: ' + (e && e.message)); return false; }
  });

  ipcMain.handle('storage-delete-dir', (event, dir, recursive) => {
    try {
      const d = safeDataPath(dir || '');
      if (!d) { writeLog('warn', 'storage-delete-dir rejected path: ' + dir); return false; }
      if (!fs.existsSync(d)) return true;
      fs.rmSync(d, { recursive: !!recursive, force: true });
      return true;
    } catch (e) { writeLog('error', 'storage-delete-dir failed: ' + (e && e.message)); return false; }
  });

  // 目录占用统计（字节数 + 文件数），用于设置页缓存大小展示
  ipcMain.handle('storage-dir-info', (event, dir) => {
    try {
      const d = safeDataPath(dir || '');
      if (!d) return { bytes: 0, files: 0 };
      let bytes = 0, files = 0;
      const walk = (p) => {
        if (!fs.existsSync(p)) return;
        let entries = [];
        try { entries = fs.readdirSync(p); } catch (_) { return; }
        for (const f of entries) {
          const fp = path.join(p, f);
          try {
            const st = fs.statSync(fp);
            if (st.isDirectory()) walk(fp);
            else { bytes += st.size; files++; }
          } catch (_) { /* ignore */ }
        }
      };
      walk(d);
      return { bytes, files };
    } catch (e) { return { bytes: 0, files: 0 }; }
  });

  // 仅清理图片缓存（images 目录 + 映射表），新闻缓存保留
  ipcMain.handle('storage-clear-image-cache', () => {
    try {
      const d = imagesDir();
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
      IMAGE_MANIFEST = {};
      saveManifest();
      return true;
    } catch (e) { return false; }
  });

  // 清理全部缓存（cache + images + 映射表）
  ipcMain.handle('storage-clear-all-caches', () => {
    try {
      const cd = cacheDir();
      const id = imagesDir();
      if (fs.existsSync(cd)) fs.rmSync(cd, { recursive: true, force: true });
      if (fs.existsSync(id)) fs.rmSync(id, { recursive: true, force: true });
      IMAGE_MANIFEST = {};
      saveManifest();
      return true;
    } catch (e) { return false; }
  });

  // 后台刷新开关（设置页控制，默认开启）
  ipcMain.handle('get-background-refresh', () => backgroundRefresh);
  ipcMain.handle('set-background-refresh', (event, val) => {
    backgroundRefresh = !!val;
    return true;
  });

  // 当前应用版本号
  ipcMain.handle('current-version', () => app.getVersion());

  // 系统通知（订阅提醒等渲染层主动通知）
  ipcMain.handle('notify', (event, title, body) => {
    try {
      if (!Notification.isSupported()) return false;
      new Notification({ title: String(title || '实时新闻中心'), body: String(body || '') }).show();
      return true;
    } catch (e) {
      writeLog('error', 'notify failed: ' + (e && e.message));
      return false;
    }
  });

  // ---------- 备份 / 恢复（整包 data/ 复制到 backups/） ----------
  function backupsDir() { return path.join(path.dirname(DATA_DIR), 'backups'); }
  ipcMain.handle('backup-data', () => {
    try {
      const bd = backupsDir();
      ensureDir(bd);
      const ts = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const name = 'data_' + ts.getFullYear() + p(ts.getMonth() + 1) + p(ts.getDate()) + '_' + p(ts.getHours()) + p(ts.getMinutes()) + p(ts.getSeconds());
      const dest = path.join(bd, name);
      fs.cpSync(DATA_DIR, dest, { recursive: true });
      return { ok: true, path: dest, name };
    } catch (e) { writeLog('error', 'backup failed: ' + (e && e.message)); return { ok: false, reason: e && e.message }; }
  });
  ipcMain.handle('list-backups', () => {
    try {
      const bd = backupsDir();
      if (!fs.existsSync(bd)) return [];
      return fs.readdirSync(bd, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort().reverse();
    } catch (e) { return []; }
  });
  ipcMain.handle('restore-data', (event, name) => {
    try {
      if (!name || String(name).includes('..') || String(name).includes('/') || String(name).includes('\\')) {
        return { ok: false, reason: '非法备份名' };
      }
      const src = path.join(backupsDir(), name);
      if (!fs.existsSync(src)) return { ok: false, reason: '备份不存在' };
      // 覆盖式恢复（不清空现有 data，避免触发删除保护；备份内同名文件覆盖）
      fs.cpSync(src, DATA_DIR, { recursive: true, force: true });
      return { ok: true };
    } catch (e) { writeLog('error', 'restore failed: ' + (e && e.message)); return { ok: false, reason: e && e.message }; }
  });

  // ---------- OPML 导入：选择 .opml 文件并读取内容 ----------
  ipcMain.handle('pick-opml', async () => {
    try {
      const r = await dialog.showOpenDialog(win, {
        title: '选择 OPML 文件',
        filters: [{ name: 'OPML', extensions: ['opml', 'xml'] }],
        properties: ['openFile']
      });
      if (r.canceled || !r.filePaths || !r.filePaths.length) return null;
      const content = fs.readFileSync(r.filePaths[0], 'utf-8');
      return { path: r.filePaths[0], content };
    } catch (e) { writeLog('error', 'pick-opml failed: ' + (e && e.message)); return null; }
  });

  // ---------- LLM 对话（OpenAI 兼容 / Ollama） ----------
  ipcMain.handle('llm-chat', async (event, opts) => {
    opts = opts || {};
    try {
      const provider = opts.provider === 'ollama' ? 'ollama' : 'openai';
      let url, body;
      const headers = { 'Content-Type': 'application/json' };
      if (provider === 'ollama') {
        url = (opts.baseUrl || 'http://localhost:11434').replace(/\/+$/, '') + '/api/chat';
        body = { model: opts.model || 'qwen2.5', messages: opts.messages || [], stream: false };
      } else {
        url = (opts.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions';
        body = { model: opts.model || 'gpt-4o-mini', messages: opts.messages || [] };
        if (opts.apiKey) headers['Authorization'] = 'Bearer ' + opts.apiKey;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status + ' @ ' + url);
      const data = await res.json();
      let text = '';
      if (provider === 'ollama') text = (data.message && data.message.content) || '';
      else text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
      return { ok: true, text };
    } catch (e) {
      writeLog('warn', 'llm-chat failed: ' + (e && e.message));
      return { ok: false, reason: e && e.message };
    }
  });

  // ---------- 云端 TTS（OpenAI 兼容 audio/speech） ----------
  ipcMain.handle('tts-cloud', async (event, opts) => {
    opts = opts || {};
    try {
      const url = (opts.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/audio/speech';
      const headers = { 'Content-Type': 'application/json' };
      if (opts.apiKey) headers['Authorization'] = 'Bearer ' + opts.apiKey;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(url, {
        method: 'POST', headers,
        body: JSON.stringify({ model: opts.model || 'tts-1', voice: opts.voice || 'alloy', input: opts.text || '' }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status + ' @ ' + url);
      const buf = Buffer.from(await res.arrayBuffer());
      return { ok: true, audio: buf.toString('base64') };
    } catch (e) {
      writeLog('warn', 'tts-cloud failed: ' + (e && e.message));
      return { ok: false, reason: e && e.message };
    }
  });

  // ---------- 下载文件（PDF 等）到本地并用系统默认程序打开 ----------
  ipcMain.handle('download-file', async (event, url) => {
    if (!url) return { ok: false, reason: 'empty url' };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          'Accept': '*/*'
        },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('空文件');
      const dir = path.join(DATA_DIR, 'downloads');
      ensureDir(dir);
      let ext = 'pdf';
      const m = String(url).match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
      if (m) ext = m[1].toLowerCase();
      const fp = path.join(dir, 'file_' + crypto.randomUUID().replace(/-/g, '') + '.' + ext);
      fs.writeFileSync(fp, buf);
      try { await shell.openPath(fp); } catch (_) { /* ignore */ }
      return { ok: true, path: fp };
    } catch (e) {
      writeLog('warn', 'download-file failed: ' + (e && e.message));
      return { ok: false, reason: e && e.message };
    }
  });

  // 本地文档协议：app-file:///<name> → data/downloads/<name>
  protocol.handle('app-file', async (request) => {
    try {
      // 自定义 standard scheme 下 new URL('app-file:///x.pdf') 会把 x.pdf 当作 host、pathname 为空，
      // 因此这里直接按字符串剥离协议头，兼容 app-file://x.pdf 与 app-file:///x.pdf 两种写法。
      let name = String(request.url || '').replace(/^app-file:\/\//i, '');
      name = name.split('?')[0].split('#')[0].replace(/^\/+/, '');
      name = decodeURIComponent(name);
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
        return new Response('forbidden', { status: 403 });
      }
      const dir = path.join(DATA_DIR, 'downloads');
      const fp = path.join(dir, name);
      if (!fp.startsWith(dir + path.sep)) return new Response('forbidden', { status: 403 });
      const data = await fs.promises.readFile(fp);
      const ext = path.extname(name).toLowerCase();
      const type = ext === '.pdf' ? 'application/pdf'
        : (ext === '.html' || ext === '.htm') ? 'text/html; charset=utf-8'
        : 'application/octet-stream';
      return new Response(new Uint8Array(data), { headers: { 'Content-Type': type } });
    } catch (e) {
      return new Response('not found', { status: 404 });
    }
  });

  // 下载在线文档到 data/downloads，返回可内嵌的 app-file:// 地址
  ipcMain.handle('download-document', async (event, url) => {
    if (!url) return { ok: false, reason: 'empty url' };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          'Accept': '*/*'
        },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('空文件');
      const dir = path.join(DATA_DIR, 'downloads');
      ensureDir(dir);
      let ext = 'pdf';
      const m = String(url).match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
      if (m) ext = m[1].toLowerCase();
      const name = 'doc_' + crypto.randomUUID().replace(/-/g, '') + '.' + ext;
      fs.writeFileSync(path.join(dir, name), buf);
      return { ok: true, name, url: 'app-file:///' + name, size: buf.length };
    } catch (e) {
      writeLog('warn', 'download-document failed: ' + (e && e.message));
      return { ok: false, reason: e && e.message };
    }
  });

  // 动态渲染抓取：用隐藏窗口加载页面，等正文出现后取 DOM
  // 适用：JS 渲染站点（NYT 等）、返回 403 的反爬站点（France24 等）
  ipcMain.handle('fetch-rendered', async (event, url, opts) => {
    opts = opts || {};
    let win = null;
    try {
      win = new BrowserWindow({
        show: false, width: 1280, height: 900,
        webPreferences: { offscreen: true, sandbox: false, images: false, javascript: true }
      });
      const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
      await win.loadURL(url, { userAgent: ua });
      const waitMs = Math.max(1200, Math.min(3500, opts.waitMs || 2000));
      const waitScript = 'new Promise(function(r){var t0=Date.now();var i=setInterval(function(){' +
        'var ok=document.querySelector(\'article, [itemprop="articleBody"], .article-body, .article__body, #article-body\');' +
        'var hasText=((document.body&&document.body.innerText)||"").length>800;' +
        'if(ok||hasText||Date.now()-t0>' + waitMs + '){clearInterval(i);r(true);}},150);})';
      await win.webContents.executeJavaScript(waitScript);
      const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
      return { ok: true, html: html || '' };
    } catch (e) {
      writeLog('warn', 'fetch-rendered failed: ' + (e && e.message));
      return { ok: false, reason: e && e.message };
    } finally {
      try { if (win) win.destroy(); } catch (_) { /* ignore */ }
    }
  });

  // 清理已下载文档（纳入设置页缓存清理范围）
  ipcMain.handle('clear-downloads', () => {
    try {
      const dir = path.join(DATA_DIR, 'downloads');
      if (!fs.existsSync(dir)) return { ok: true, count: 0 };
      let n = 0;
      for (const f of fs.readdirSync(dir)) {
        try { fs.unlinkSync(path.join(dir, f)); n++; } catch (_) { /* ignore */ }
      }
      return { ok: true, count: n };
    } catch (e) { return { ok: false, reason: e && e.message }; }
  });
  ipcMain.handle('downloads-info', () => {
    try {
      const dir = path.join(DATA_DIR, 'downloads');
      if (!fs.existsSync(dir)) return { count: 0, bytes: 0 };
      let count = 0, bytes = 0;
      for (const f of fs.readdirSync(dir)) {
        try {
          const st = fs.statSync(path.join(dir, f));
          if (st.isFile()) { count++; bytes += st.size; }
        } catch (_) { /* ignore */ }
      }
      return { count, bytes };
    } catch (_) { return { count: 0, bytes: 0 }; }
  });

  // ---------- Fever API（只读，供第三方 RSS 客户端读取） ----------
  let feverServer = null;
  const feverHash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };
  const feverFavKey = (it) => (it.sourceId || '') + '|' + (it.link || '') + '|' + (it.title || '');
  function readFeverItems() {
    const cacheDir = path.join(DATA_DIR, 'cache');
    let readKeys = {};
    try { readKeys = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'read_state.json'), 'utf-8') || '{}'); } catch (_) {}
    let favs = [];
    try { favs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'favorites.json'), 'utf-8') || '[]'); } catch (_) {}
    const favSet = new Set(favs.map(it => feverFavKey(it)));
    const feedMap = new Map();
    const items = [];
    try {
      if (fs.existsSync(cacheDir)) {
        const files = fs.readdirSync(cacheDir).filter(f => f.startsWith('news_cache_') && f.endsWith('.json'));
        for (const f of files) {
          let arr = [];
          try { arr = JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf-8')); } catch (_) { continue; }
          for (const it of arr) {
            const fk = feverFavKey(it);
            const sourceId = it.sourceId || 'unknown';
            if (!feedMap.has(sourceId)) feedMap.set(sourceId, { id: feverHash(sourceId), title: it.source || sourceId });
            items.push({
              id: feverHash(fk),
              feed_id: feedMap.get(sourceId).id,
              title: it.title || '',
              url: it.link || '',
              content: it.content || '',
              summary: it.summary || '',
              author: it.source || '',
              is_read: readKeys[fk] ? 1 : 0,
              is_saved: favSet.has(fk) ? 1 : 0,
              created_on_time: Math.floor((it.timestamp || Date.now()) / 1000)
            });
          }
        }
      }
    } catch (_) { /* ignore */ }
    const unread = items.filter(it => !it.is_read).map(it => it.id);
    const saved = items.filter(it => it.is_saved).map(it => it.id);
    return { items, feeds: Array.from(feedMap.values()), unread, saved };
  }
  function startFeverServer() {
    try {
      const sp = path.join(DATA_DIR, 'settings.json');
      let s = {};
      if (fs.existsSync(sp)) { try { s = JSON.parse(fs.readFileSync(sp, 'utf-8') || '{}'); } catch (_) {} }
      if (!s.fever || !s.fever.enabled) return;
      if (feverServer) { try { feverServer.close(); } catch (_) {} feverServer = null; }
      let key = s.fever.key;
      if (!key) { key = crypto.randomBytes(16).toString('hex'); s.fever.key = key; }
      const http = require('http');
      const server = http.createServer((req, res) => {
        try {
          const u = new URL(req.url, 'http://localhost');
          const apiKey = u.searchParams.get('api_key') || '';
          const send = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); };
          const base = { api_version: 3, auth: apiKey === key ? 1 : 0 };
          if (apiKey !== key) { send(base); return; }
          const q = u.searchParams;
          const { items, feeds, unread, saved } = readFeverItems();
          const now = Math.floor(Date.now() / 1000);
          if (q.has('items')) {
            const since = parseInt(q.get('since_id') || '0', 10) || 0;
            const filtered = since ? items.filter(it => it.id > since) : items;
            send(Object.assign({}, base, { last_refreshed_on_time: now, items: filtered }));
          } else if (q.has('feeds')) {
            send(Object.assign({}, base, { last_refreshed_on_time: now, feeds, groups: [] }));
          } else if (q.has('groups')) {
            send(Object.assign({}, base, { groups: [] }));
          } else if (q.has('unread_item_ids')) {
            send(Object.assign({}, base, { unread_item_ids: unread.join(',') }));
          } else if (q.has('saved_item_ids')) {
            send(Object.assign({}, base, { saved_item_ids: saved.join(',') }));
          } else {
            send(base);
          }
        } catch (e) { try { res.writeHead(500); res.end('error'); } catch (_) {} }
      });
      server.on('error', (e) => writeLog('error', 'fever server error: ' + (e && e.message)));
      server.listen(s.fever.port || 0, '127.0.0.1', () => {
        const addr = server.address();
        s.fever.port = addr && addr.port;
        try { fs.writeFileSync(sp, JSON.stringify(s, null, 2)); } catch (_) {}
        writeLog('info', 'fever server listening on http://127.0.0.1:' + (addr && addr.port));
      });
      feverServer = server;
    } catch (e) { writeLog('error', 'fever server failed: ' + (e && e.message)); }
  }
  // 设置里切换 Fever 开关后，重启服务
  ipcMain.handle('restart-fever', () => { startFeverServer(); return true; });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

app.on('window-all-closed', () => {
  // 开启"后台刷新"时保留进程（窗口已隐藏，不触发此事件）；
  // 未开启或主动退出时，关闭窗口即退出。
  if (!backgroundRefresh) app.quit();
});
