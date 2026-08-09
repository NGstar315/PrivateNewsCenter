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
  function defaultSettings() {
    return {
      dataDir: '',                 // 空 = 默认（exe 同级 data）
      imageCaching: 'all',         // all | favorites | off
      animations: true,            // 新闻增量刷新动画（Apple/Google 风格位移+淡入），可关以省性能
      calendarWave: true,          // 日历水位波浪动态效果（GPU 加速），可关以省性能
      smartClean: true,            // 智能正文清理：移除菜单/图标/广告等噪声，仅保留标题/正文/图片
      backgroundRefresh: true,     // 关闭窗口后保留进程后台自动刷新新闻（可在设置页关闭）
      fetchMode: 'balanced',       // 新闻获取模式：min(串行最省) / balanced(推荐) / max(高并发最快)
      refreshIntervalMinutes: 30,
      autoRefresh: true,
      autoRefreshOnStart: true,
      sources: {},                 // { sourceId: true/false } 启停，默认 true
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
      const files = await global.electronAPI.storage.list('cache');
      const map = new Map();
      for (const f of files) {
        if (!f.startsWith(CACHE_PREFIX) || !f.endsWith(CACHE_SUFFIX)) continue;
        const raw = await global.electronAPI.storage.read('cache/' + f);
        if (!raw) continue;
        let arr = [];
        try { arr = JSON.parse(raw); } catch (_) { continue; }
        for (const it of arr) {
          const k = dedupeKey(it);
          if (!map.has(k)) map.set(k, it);
        }
      }
      return Array.from(map.values());
    } catch (_) { return []; }
  }

  // 把本次刷新结果与现有缓存合并去重；新增的写入今日缓存文件
  async function mergeAndPersist(newItems) {
    const existing = await loadCachedNews();
    const map = new Map();
    for (const it of existing) map.set(dedupeKey(it), it);
    let added = 0;
    for (const it of newItems) {
      const k = dedupeKey(it);
      if (!map.has(k)) {
        it.cachedDate = todayStr();
        map.set(k, it);
        added++;
      } else {
        // 已存在：用本次更新的 content/cover 覆盖（若更新了）
        const old = map.get(k);
        if (it.content && !old.content) { old.content = it.content; }
        if (it.cover && !old.cover) { old.cover = it.cover; }
      }
    }
    const merged = Array.from(map.values());

    // 写入今日缓存文件（仅今日抓取的新增项）
    try {
      const today = todayStr();
      const file = 'cache/' + CACHE_PREFIX + today + CACHE_SUFFIX;
      const oldRaw = await global.electronAPI.storage.read(file);
      let todayArr = [];
      if (oldRaw) { try { todayArr = JSON.parse(oldRaw); } catch (_) { todayArr = []; } }
      const todayMap = new Map();
      for (const it of todayArr) todayMap.set(dedupeKey(it), it);
      for (const it of newItems) {
        const k = dedupeKey(it);
        if (!todayMap.has(k)) { it.cachedDate = today; todayMap.set(k, it); }
      }
      await global.electronAPI.storage.write(file, JSON.stringify(Array.from(todayMap.values()), null, 2));
    } catch (_) { /* ignore */ }

    return merged;
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
    loadCachedNews, mergeAndPersist,
    clearCacheDate, clearAllCache,
    loadFavorites, saveFavorites,
    cacheImage,
    loadUserSources, saveUserSources,
    recordGeoCall, getGeoUsage
  };

  global.Store = Store;
})(typeof window !== 'undefined' ? window : globalThis);
