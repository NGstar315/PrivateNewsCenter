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
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { initUpdater } = require('./updater');

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
// 优先放在 exe 同级 data/（便携场景，目录可写）；若该位置不可写
// （例如安装到 C:\Program Files），则回退到用户可写的 AppData，
// 避免“安装版”因无写入权限而设置/缓存全部失效。
function defaultDataDir() {
  const exeDir = path.dirname(app.getPath('exe'));
  const candidate = path.join(exeDir, 'data');
  try {
    if (!fs.existsSync(candidate)) fs.mkdirSync(candidate, { recursive: true });
    const probe = path.join(candidate, '.writable-test');
    fs.writeFileSync(probe, '1');
    fs.unlinkSync(probe);
    return candidate;
  } catch (_) {
    try {
      return path.join(app.getPath('userData'), 'data');
    } catch (_) {
      return candidate;
    }
  }
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
  // 已缓存且文件还在 -> 直接返回
  const hit = IMAGE_MANIFEST[url];
  if (hit) {
    const fp = path.join(imagesDir(), hit.file);
    if (fs.existsSync(fp)) return { ok: true, url: 'file:///' + fp.replace(/\\/g, '/') };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                       '(KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/png,image/*,*/*;q=0.8',
        'Referer': 'https://www.google.com/'
      },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500) throw new Error('图片过小');
    const ext = extFromType(res.headers.get('content-type'), url);
    const id = crypto.randomUUID().replace(/-/g, '');
    const file = 'img_' + id + '.' + ext;
    ensureDir(imagesDir());
    fs.writeFileSync(path.join(imagesDir(), file), buf);
    IMAGE_MANIFEST[url] = { id, file, ext };
    saveManifest();
    return { ok: true, url: 'file:///' + path.join(imagesDir(), file).replace(/\\/g, '/') };
  } catch (e) {
    return { ok: false, url: '' };
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
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 关闭窗口时：若开启"后台刷新"且非主动退出，则隐藏到托盘而非销毁进程
  win.on('close', (e) => {
    if (!quitting && backgroundRefresh) {
      e.preventDefault();
      win.hide();
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

  // 后台抓取文本（原有能力）
  // 按 URL 缓存上次响应体，用于条件请求（304）时回放，避免重复下载
  const feedCache = new Map();

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
        // 无缓存（如重启后首次）：去掉条件头重新抓取
        const h2 = Object.assign({}, headers);
        delete h2['If-None-Match'];
        delete h2['If-Modified-Since'];
        res = await fetch(url, { headers: h2, signal: controller.signal });
      }
      if (!res.ok) throw new Error('HTTP ' + res.status + ' @ ' + url);
      const body = await res.text();
      const etag = res.headers.get('etag');
      const lastModified = res.headers.get('last-modified');
      feedCache.set(url, { body, etag, lastModified });
      return { ok: true, status: res.status, notModified: false, body, etag, lastModified };
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
      return await res.text();
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

  ipcMain.handle('storage-read', (event, file) => {
    try {
      const p = path.isAbsolute(file) ? file : path.join(DATA_DIR, file);
      if (!fs.existsSync(p)) return null;
      return fs.readFileSync(p, 'utf-8');
    } catch (e) { return null; }
  });

  ipcMain.handle('storage-write', (event, file, content) => {
    try {
      const p = path.isAbsolute(file) ? file : path.join(DATA_DIR, file);
      ensureDir(path.dirname(p));
      fs.writeFileSync(p, content);
      return true;
    } catch (e) { return false; }
  });

  ipcMain.handle('storage-exists', (event, file) => {
    const p = path.isAbsolute(file) ? file : path.join(DATA_DIR, file);
    return fs.existsSync(p);
  });

  ipcMain.handle('storage-list', (event, dir) => {
    try {
      const d = path.isAbsolute(dir) ? dir : path.join(DATA_DIR, dir || '');
      if (!fs.existsSync(d)) return [];
      return fs.readdirSync(d).filter(f => {
        try { return fs.statSync(path.join(d, f)).isFile(); } catch (_) { return false; }
      });
    } catch (e) { return []; }
  });

  ipcMain.handle('storage-delete-file', (event, file) => {
    try {
      const p = path.isAbsolute(file) ? file : path.join(DATA_DIR, file);
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return true;
    } catch (e) { return false; }
  });

  ipcMain.handle('storage-delete-dir', (event, dir, recursive) => {
    try {
      const d = path.isAbsolute(dir) ? dir : path.join(DATA_DIR, dir || '');
      if (!fs.existsSync(d)) return true;
      fs.rmSync(d, { recursive: !!recursive, force: true });
      return true;
    } catch (e) { return false; }
  });

  // 目录占用统计（字节数 + 文件数），用于设置页缓存大小展示
  ipcMain.handle('storage-dir-info', (event, dir) => {
    try {
      const d = path.isAbsolute(dir) ? dir : path.join(DATA_DIR, dir || '');
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
