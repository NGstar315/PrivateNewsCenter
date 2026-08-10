/*
 * store.js —— 本地持久化层（渲染进程侧）
 * ---------------------------------------------------------------
 * 职责：
 *   - 设置：data/settings.json（可改数据目录、刷新间隔、图片缓存策略、信源启停、地图 API）
 *   - 新闻缓存：data/cache/news_cache_YYYY-MM-DD.json（文件名含 news/cache/日期）
 *       刷新时按 标题+链接+时间+发布者 去重，一致则跳过；启动时自动加载
 *   - 收藏：data/favorites.json
 *   - 图片缓存：通过主进程下载到 data/images/img_<uuid>.<ext>，永不重复
 *   - 地图 API 调用计数：data/geo_usage.json（按日）
 * 兼容非 Electron 环境（直接浏览器打开）时降级为内存模式。
 * ---------------------------------------------------------------
 */
(function (global) {
  'use strict';

  const isElectron = !!(global.electronAPI && global.electronAPI.storage);
  const CACHE_PREFIX = 'news_cache_'; // 文件名规则：news_cache_YYYY-MM-DD.json
  const CACHE_SUFFIX = '.json';

  // ---------- 工具 ----------
  function todayStr(d) {
    const x = d || new Date();
    const y = x.getFullYear();
    const m = String(x.getMonth() + 1).padStart(2, '0');
    const day = String(x.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }
  // 由时间戳（毫秒）或 Date 得到 YYYY-MM-DD
  function dateStr(t) {
    const x = (t instanceof Date) ? t : new Date(t);
    const y = x.getFullYear();
    const m = String(x.getMonth() + 1).padStart(2, '0');
    const day = String(x.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }
  function defaultSettings() {
    return {
      dataDir: '',                 // 空 = 默认（exe 同级 data）
      imageCaching: 'all',         // all | favorites | off
      animations: true,            // 新闻增量刷新动画（Apple/Google 风格位移+淡入），可关以省性能
      calendarWave: true,          // 日历水位波浪动态效果（GPU 加速），可关以省性能
      smartClean: true,            // 智能正文清理：移除菜单/图标/广告等噪声，仅保留标题/正文/图片
      backgroundRefresh: true,     // 关闭窗口后保留进程后台自动刷新新闻（可在设置页关闭）
      fetchMode: 'balanced',       // 新闻获取模式：min(串行最省) / balanced(推荐) / max(高并发最快)
      fetchMonth: false,           // 新闻保留窗口：false=近 7 天；true=近 30 天（近七天无新内容时也可自动扩展）
      refreshIntervalMinutes: 30,
      autoRefresh: true,
      autoRefreshOnStart: true,
      sources: {},                 // { sourceId: true/false } 启停，默认 true
      updateLine: 'github',        // 'github'(首选) | 'gitee'(备用)：更新检查线路，写死在 updater.js
      hot: {                       // 热搜榜单开关与显示条数
        weibo: true,
        baidu: true,
        zhihu: true,
        intl: true,
        maxItems: 30
      },
      geo: {
        provider: 'tencent',       // tencent（应用内代理）/ 用户自有 key 时填 below
        apiKey: '',
        mapStyleId: '',            // 可选：腾讯/高德控制台个性化样式 ID
        dailyCount: 0,
        date: ''
      }
    };
  }

  function dedupeKey(it) {
    return [it.title || '', it.link || '', it.timestamp || 0, it.source || ''].join('||');
  }

  // ---------- 新闻时间窗口（近 7 天 / 近 30 天） ----------
  // 设计目标（用户需求）：
  //   1) 只保留当前日期近一周内的新闻，按发布日期优先（今天 > 昨天 > … > 6 天前）；
  //   2) 近七天若连续多次刷新都无新内容，视为"已抓完"，可自动扩展到近一个月；
  //   3) 是否获取近一个月新闻由设置页开关控制（常开则直接 30 天）。
  // 实现：每条新闻按其"发布日期"分文件落盘（news_cache_<发布日期>.json），
  //       加载/合并时只保留窗口内的项；无发布时间的项按抓取日保留。
  const WINDOW_WEEK_DAYS = 7;
  const WINDOW_MONTH_DAYS = 30;
  let _settings = defaultSettings();
  function setSettings(s) { if (s) _settings = Object.assign(defaultSettings(), s); }
  function nowMs() { return Date.now(); }
  function isUndated(it) { return !it.timestamp || it.timestamp <= 0; }
  function publishDateStr(it) {
    if (isUndated(it)) return todayStr();
    return dateStr(it.timestamp);
  }
  function withinWindow(it, days) {
    if (isUndated(it)) return true; // 无发布时间的新闻按抓取日保留，不丢弃
    const start = nowMs() - days * 86400000;
    return it.timestamp >= start;
  }
  function effectiveDays(ws) {
    ws = ws || {};
    return (_settings.fetchMonth || ws.sevenDaySaturated) ? WINDOW_MONTH_DAYS : WINDOW_WEEK_DAYS;
  }
  async function currentWindowDays() { return effectiveDays(await loadWindowState()); }

  // 窗口状态：记录近 7 天连续无新内容的刷新次数，用于自动扩展到近 30 天
  const WINDOW_STATE_FILE = 'news_window_state.json';
  async function loadWindowState() {
    try { const raw = await global.electronAPI.storage.read(WINDOW_STATE_FILE); return raw ? JSON.parse(raw) : {}; }
    catch (_) { return {}; }
  }
  async function saveWindowState(s) {
    try { await global.electronAPI.storage.write(WINDOW_STATE_FILE, JSON.stringify(s)); } catch (_) {}
  }
  // added7 = 本次刷新在近 7 天窗口内"新增"的条数；返回当前生效的窗口天数
  async function recordWindowSaturation(added7) {
    const ws = await loadWindowState();
    ws.staleCount = (added7 > 0) ? 0 : (ws.staleCount || 0) + 1;
    if (ws.staleCount >= 3) ws.sevenDaySaturated = true;
    await saveWindowState(ws);
    return effectiveDays(ws);
  }

  // ---------- 设置 ----------
  async function loadSettings() {
    if (!isElectron) return defaultSettings();
    try {
      const raw = await global.electronAPI.storage.read('settings.json');
      if (!raw) return defaultSettings();
      const parsed = JSON.parse(raw);
      const defs = defaultSettings();
      return Object.assign(defs, parsed, {
        sources: Object.assign(defs.sources, parsed.sources || {}),
        hot: Object.assign(defs.hot, parsed.hot || {}),
        geo: Object.assign(defs.geo, parsed.geo || {})
      });
    } catch (_) { return defaultSettings(); }
  }
  async function saveSettings(s) {
    if (!isElectron) return;
    try {
      await global.electronAPI.storage.write('settings.json', JSON.stringify(s, null, 2));
    } catch (_) { /* ignore */ }
  }

  // ---------- 新闻缓存 ----------
  async function loadCachedNews() {
    if (!isElectron) return [];
    try {
      const days = await currentWindowDays();
      const files = await global.electronAPI.storage.list('cache');
      const map = new Map();
      for (const f of files) {
        if (!f.startsWith(CACHE_PREFIX) || !f.endsWith(CACHE_SUFFIX)) continue;
        const raw = await global.electronAPI.storage.read('cache/' + f);
        if (!raw) continue;
        let arr = [];
        try { arr = JSON.parse(raw); } catch (_) { continue; }
        for (const it of arr) {
          if (!withinWindow(it, days)) continue; // 仅保留窗口内的新闻
          const k = dedupeKey(it);
          if (!map.has(k)) map.set(k, it);
        }
      }
      return Array.from(map.values());
    } catch (_) { return []; }
  }

  // 把本次刷新结果与现有缓存合并去重；按"发布日期"分文件落盘；返回 { merged, added, added7 }
  async function mergeAndPersist(newItems) {
    const days = await currentWindowDays();
    const existing = await loadCachedNews();
    const map = new Map();
    for (const it of existing) map.set(dedupeKey(it), it);
    let added = 0, added7 = 0;
    for (const it of newItems) {
      if (!withinWindow(it, days)) continue; // 超出窗口的新闻不写入（保持列表新鲜）
      const k = dedupeKey(it);
      if (!map.has(k)) {
        it.cachedDate = publishDateStr(it); // 标记其发布日期，便于"获取某一天"
        map.set(k, it);
        added++;
        if (withinWindow(it, WINDOW_WEEK_DAYS)) added7++; // 统计近 7 天内的新增
      } else {
        // 已存在：用本次更新的 content/cover 覆盖（若更新了）
        const old = map.get(k);
        if (it.content && !old.content) { old.content = it.content; }
        if (it.cover && !old.cover) { old.cover = it.cover; }
      }
    }
    const merged = Array.from(map.values());

    // 按发布日期分文件落盘（news_cache_<发布日期>.json）
    const byDate = new Map();
    for (const it of merged) {
      const ds = publishDateStr(it);
      if (!byDate.has(ds)) byDate.set(ds, []);
      byDate.get(ds).push(it);
    }
    for (const [ds, arr] of byDate) {
      try {
        await global.electronAPI.storage.write('cache/' + CACHE_PREFIX + ds + CACHE_SUFFIX, JSON.stringify(arr, null, 2));
      } catch (_) { /* ignore */ }
    }

    // 清理超过 30 天的旧缓存文件，避免无限增长（窗口再次扩大时这些文件已无价值）
    try {
      const files = await global.electronAPI.storage.list('cache');
      const cutoff = todayStr(new Date(Date.now() - (WINDOW_MONTH_DAYS + 1) * 86400000));
      for (const f of files) {
        if (!f.startsWith(CACHE_PREFIX) || !f.endsWith(CACHE_SUFFIX)) continue;
        const ds = f.slice(CACHE_PREFIX.length, -CACHE_SUFFIX.length);
        if (ds < cutoff) { try { await global.electronAPI.storage.deleteFile('cache/' + f); } catch (_) {} }
      }
    } catch (_) { /* ignore */ }

    return { merged, added, added7 };
  }

  // 清理某个日期或全部缓存
  async function clearCacheDate(dateStr) {
    if (!isElectron) return;
    const file = 'cache/' + CACHE_PREFIX + dateStr + CACHE_SUFFIX;
    await global.electronAPI.storage.deleteFile(file);
  }
  async function clearAllCache() {
    if (!isElectron) return;
    await global.electronAPI.storage.deleteDir('cache', true);
  }

  // ---------- 收藏 ----------
  async function loadFavorites() {
    if (!isElectron) return [];
    try {
      const raw = await global.electronAPI.storage.read('favorites.json');
      if (!raw) return [];
      return JSON.parse(raw) || [];
    } catch (_) { return []; }
  }
  async function saveFavorites(list) {
    if (!isElectron) return;
    try {
      await global.electronAPI.storage.write('favorites.json', JSON.stringify(list, null, 2));
    } catch (_) { /* ignore */ }
  }

  // ---------- 用户自定义信源 ----------
  const USER_SOURCES_FILE = 'user_sources.json';
  async function loadUserSources() {
    if (!isElectron) return [];
    try {
      const raw = await global.electronAPI.storage.read(USER_SOURCES_FILE);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }
  async function saveUserSources(list) {
    if (!isElectron) return;
    try {
      await global.electronAPI.storage.write(USER_SOURCES_FILE, JSON.stringify(list || [], null, 2));
    } catch (_) { /* ignore */ }
  }

  // ---------- 图片缓存 ----------
  // 返回本地 file:// 路径（成功）或 '' （不缓存/失败）
  async function cacheImage(url, opts) {
    opts = opts || {};
    if (!isElectron || !url) return '';
    // 策略判断
    const s = await loadSettings();
    if (s.imageCaching === 'off') return '';
    if (s.imageCaching === 'favorites' && !opts.favorite) return '';
    try {
      const res = await global.electronAPI.imageCache(url);
      return (res && res.ok) ? res.url : '';
    } catch (_) { return ''; }
  }

  // ---------- 地图 API 调用计数 ----------
  async function recordGeoCall(n) {
    if (!isElectron) return;
    try {
      const today = todayStr();
      const raw = await global.electronAPI.storage.read('geo_usage.json');
      let usage = raw ? JSON.parse(raw) : { date: '', dailyCount: 0 };
      if (usage.date !== today) { usage.date = today; usage.dailyCount = 0; }
      usage.dailyCount += (n || 1);
      await global.electronAPI.storage.write('geo_usage.json', JSON.stringify(usage));
    } catch (_) { /* ignore */ }
  }
  async function getGeoUsage() {
    if (!isElectron) return { date: '', dailyCount: 0 };
    try {
      const raw = await global.electronAPI.storage.read('geo_usage.json');
      if (!raw) return { date: '', dailyCount: 0 };
      return JSON.parse(raw);
    } catch (_) { return { date: '', dailyCount: 0 }; }
  }

  const Store = {
    isElectron,
    todayStr,
    CACHE_PREFIX, CACHE_SUFFIX,
    dedupeKey,
    defaultSettings,
    loadSettings, saveSettings,
    setSettings,
    loadCachedNews, mergeAndPersist,
    currentWindowDays, recordWindowSaturation,
    clearCacheDate, clearAllCache,
    loadFavorites, saveFavorites,
    cacheImage,
    loadUserSources, saveUserSources,
    recordGeoCall, getGeoUsage
  };

  global.Store = Store;
})(typeof window !== 'undefined' ? window : globalThis);
