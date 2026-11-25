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
      fontSize: 'm',               // 正文字号：s(小) / m(中) / l(大)
      modalFooter: 'docked',       // 文章弹窗底部工具栏：docked(常驻) / collapsed(收起为悬浮按钮)
      pinFavorites: true,          // 新闻页置顶收藏新闻
      pinWatched: true,            // 新闻页置顶「重点关注信源」的资讯
      watchedSources: [],          // 重点关注信源 id 列表
      sourceUserTags: {},          // 信源自定义标签：sourceId -> [tag]
      sourcePaid: {},              // 信源是否付费：sourceId -> true
      proxyPrefix: '',             // 自定义 CORS 代理前缀（空=内置 allorigins）；格式如 https://your-proxy/raw?url=
      watchlist: [],               // 订阅关键词列表：命中的新新闻触发系统通知
      rules: [],                   // 自动规则列表：{ id, pattern, field, action, enabled }
      llm: {                       // 可选 LLM 接入（翻译/简报），默认关闭
        enabled: false,
        provider: 'openai',        // 'openai'(兼容) | 'ollama'(本地)
        apiKey: '',
        baseUrl: '',               // openai 默认 https://api.openai.com/v1；ollama 默认 http://localhost:11434
        model: '',                 // openai 默认 gpt-4o-mini；ollama 默认 qwen2.5
        briefAuto: false           // 启动时自动生成每日简报
      },
      tts: {                       // 朗读语音源
        provider: 'system',        // 'system'(Web Speech) | 'cloud'(LLM 服务商 TTS)
        voice: 'zh-CN'
      },
      fever: {                     // Fever API 只读接口（供第三方客户端读取）
        enabled: false,
        key: '',
        port: 0                    // 0=自动分配
      },
      rsshub: {                    // RSSHub 实例地址
        base: 'https://rsshub.app'
      },
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
        geo: Object.assign(defs.geo, parsed.geo || {}),
        llm: Object.assign(defs.llm, parsed.llm || {}),
        tts: Object.assign(defs.tts, parsed.tts || {}),
        fever: Object.assign(defs.fever, parsed.fever || {}),
        rsshub: Object.assign(defs.rsshub, parsed.rsshub || {})
      });
    } catch (_) { return defaultSettings(); }
  }
  async function saveSettings(s) {
    if (!isElectron) return false;
    try {
      const ok = await global.electronAPI.storage.write('settings.json', JSON.stringify(s, null, 2));
      if (!ok) throw new Error('storage.write 返回 false');
      return true;
    } catch (e) {
      console.warn('[store] saveSettings failed:', e && e.message);
      return false;
    }
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

  // 把本次刷新结果与现有缓存合并去重；仅重写有变更的日期分片（增量写入）；返回 { merged, added, added7 }
  async function mergeAndPersist(newItems) {
    const days = await currentWindowDays();
    const existing = await loadCachedNews();
    const map = new Map();
    for (const it of existing) map.set(dedupeKey(it), it);
    const dirtyDates = new Set();
    let added = 0, added7 = 0;
    const addedKeys = [];
    for (const it of newItems) {
      if (!withinWindow(it, days)) continue; // 超出窗口的新闻不写入（保持列表新鲜）
      const k = dedupeKey(it);
      if (!map.has(k)) {
        it.cachedDate = publishDateStr(it); // 标记其发布日期，便于"获取某一天"
        map.set(k, it);
        added++;
        addedKeys.push(k);
        if (withinWindow(it, WINDOW_WEEK_DAYS)) added7++; // 统计近 7 天内的新增
        dirtyDates.add(publishDateStr(it));
      } else {
        // 已存在：用本次更新的 content/cover 覆盖（若更新了），并标记该日期分片为脏
        const old = map.get(k);
        let changed = false;
        if (it.content && !old.content) { old.content = it.content; changed = true; }
        if (it.cover && !old.cover) { old.cover = it.cover; changed = true; }
        if (changed) dirtyDates.add(publishDateStr(old));
      }
    }
    const merged = Array.from(map.values());

    // 按发布日期分文件落盘，但仅重写 dirty 日期分片（未变更的日期文件跳过，避免全量写放大）
    const byDate = new Map();
    for (const it of merged) {
      const ds = publishDateStr(it);
      if (!dirtyDates.has(ds)) continue;
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

    return { merged, added, added7, addedKeys };
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
    // 连带清理已下载的在线文档（PDF 等），避免清理缓存后仍占用磁盘
    try { await global.electronAPI.clearDownloads(); } catch (_) { /* ignore */ }
  }
  async function clearDownloads() {
    if (!isElectron) return { ok: true, count: 0 };
    try { return await global.electronAPI.clearDownloads(); } catch (_) { return { ok: false }; }
  }
  async function downloadsInfo() {
    if (!isElectron) return { count: 0, bytes: 0 };
    try { return await global.electronAPI.downloadsInfo(); } catch (_) { return { count: 0, bytes: 0 }; }
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
    if (!isElectron) return false;
    try {
      const ok = await global.electronAPI.storage.write('favorites.json', JSON.stringify(list, null, 2));
      if (!ok) throw new Error('storage.write 返回 false');
      return true;
    } catch (e) {
      console.warn('[store] saveFavorites failed:', e && e.message);
      return false;
    }
  }

  // ---------- 已读状态（dedupeKey -> 已读时间戳） ----------
  const READ_STATE_FILE = 'read_state.json';
  async function loadReadState() {
    if (!isElectron) return new Map();
    try {
      const raw = await global.electronAPI.storage.read(READ_STATE_FILE);
      if (!raw) return new Map();
      const obj = JSON.parse(raw);
      const m = new Map();
      for (const k of Object.keys(obj || {})) m.set(k, obj[k]);
      return m;
    } catch (_) { return new Map(); }
  }
  async function saveReadState(map) {
    if (!isElectron) return;
    try {
      // 仅保留最近 5000 条，避免无限增长
      const obj = {};
      const entries = Array.from(map.entries());
      if (entries.length > 5000) {
        entries.sort((a, b) => (b[1] || 0) - (a[1] || 0));
        for (const [k, t] of entries.slice(0, 5000)) obj[k] = t;
      } else {
        for (const [k, t] of entries) obj[k] = t;
      }
      await global.electronAPI.storage.write(READ_STATE_FILE, JSON.stringify(obj));
    } catch (_) { /* ignore */ }
  }

  // ---------- 信源健康度（sourceId -> { ok, error, consecutiveFails, lastTry, lastOk }） ----------
  const HEALTH_FILE = 'source_health.json';
  async function loadSourceHealth() {
    if (!isElectron) return {};
    try {
      const raw = await global.electronAPI.storage.read(HEALTH_FILE);
      return raw ? JSON.parse(raw) : {};
    } catch (_) { return {}; }
  }
  async function saveSourceHealth(h) {
    if (!isElectron) return;
    try { await global.electronAPI.storage.write(HEALTH_FILE, JSON.stringify(h || {})); } catch (_) { /* ignore */ }
  }
  async function recordSourceHealth(srcId, ok, error) {
    if (!isElectron || !srcId) return;
    try {
      const h = await loadSourceHealth();
      const now = Date.now();
      const prev = h[srcId] || { consecutiveFails: 0, lastOk: 0 };
      const consecutiveFails = ok ? 0 : (prev.consecutiveFails || 0) + 1;
      h[srcId] = {
        ok: !!ok,
        error: error || '',
        consecutiveFails,
        lastTry: now,
        lastOk: ok ? now : (prev.lastOk || 0)
      };
      await saveSourceHealth(h);
    } catch (_) { /* ignore */ }
  }

  // ---------- 标签（dedupeKey -> string[]） ----------
  const TAGS_FILE = 'tags.json';
  async function loadTags() {
    if (!isElectron) return new Map();
    try {
      const raw = await global.electronAPI.storage.read(TAGS_FILE);
      if (!raw) return new Map();
      const obj = JSON.parse(raw);
      const m = new Map();
      for (const k of Object.keys(obj || {})) m.set(k, Array.isArray(obj[k]) ? obj[k] : []);
      return m;
    } catch (_) { return new Map(); }
  }
  async function saveTags(map) {
    if (!isElectron) return;
    try {
      const obj = {};
      for (const [k, v] of map.entries()) if (v && v.length) obj[k] = v;
      await global.electronAPI.storage.write(TAGS_FILE, JSON.stringify(obj));
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
    loadReadState, saveReadState,
    loadSourceHealth, recordSourceHealth,
    loadTags, saveTags,
    clearDownloads, downloadsInfo,
    recordGeoCall, getGeoUsage
  };

  global.Store = Store;
})(typeof window !== 'undefined' ? window : globalThis);
