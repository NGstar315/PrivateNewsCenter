/*
 * datalayer.js —— 数据层（抓取编排 + 进度回调）
 * ---------------------------------------------------------------
 * - 在 Electron 下，抓取由"主进程"完成，renderer 通过 IPC 调用 fetchUrl，不受跨域限制。
 * - 支持按信源启停（enabledIds）过滤要抓取的源。
 * - 热榜源支持 fallbacks：主 url 失败时依次尝试备用地址。
 * 本地缓存与去重逻辑在 store.js（Store.mergeAndPersist）中完成。
 * ---------------------------------------------------------------
 */
(function (global) {
  'use strict';

  // 有界并发池：固定数量 worker 消费任务队列
  async function mapPool(items, limit, fn) {
    const ret = new Array(items.length);
    let i = 0;
    const n = Math.max(1, Math.min(limit || 1, items.length));
    const workers = [];
    for (let w = 0; w < n; w++) {
      workers.push((async () => {
        while (i < items.length) {
          const idx = i++;
          ret[idx] = await fn(items[idx], idx);
        }
      })());
    }
    await Promise.all(workers);
    return ret;
  }

  // 获取模式 → 抓取策略（并发数 + 是否使用 HTTP 条件请求）
  const MODES = {
    min:      { concurrency: 1,  conditional: false },
    balanced: { concurrency: 8,  conditional: true },
    max:      { concurrency: 16, conditional: true },
  };
  let policy = MODES.balanced;
  // 按源缓存 ETag / Last-Modified，用于条件请求（跳过未变动源）
  const feedHeaders = new Map();

  const DataLayer = {
    MODES,
    configure(p) {
      if (p && typeof p.concurrency === 'number') {
        policy = Object.assign({}, policy, p);
      }
    },

    async fetchText(url, opts) {
      // Electron 直连优先；失败后回退到公开 CORS 代理
      if (global.electronAPI && global.electronAPI.fetchUrl) {
        try {
          const r = await global.electronAPI.fetchUrl(url, opts || {});
          if (typeof r === 'string') return { body: r };
          if (r && typeof r === 'object') return r;
          return { body: String(r) };
        } catch (e) {
          console.warn('[fetchText electron failed, try proxy]', url, e && e.message);
        }
      }
      const proxied = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      try {
        const r = await fetch(proxied, { signal: ctrl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return { body: await r.text() };
      } finally {
        clearTimeout(timer);
      }
    },

    async fetchHotHtml(url, extraHeaders) {
      if (global.electronAPI && global.electronAPI.fetchHotHtml) {
        return await global.electronAPI.fetchHotHtml(url, extraHeaders);
      }
      // 非 Electron 环境直接请求（CORS 可能失败）
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      try {
        const r = await fetch(url, { headers: extraHeaders || {}, signal: ctrl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.text();
      } finally {
        clearTimeout(timer);
      }
    },

    async fetchWithFallbacks(urls, opts) {
      let lastErr = new Error('无可用地址');
      for (const url of urls) {
        try {
          return await this.fetchText(url, opts);
        } catch (e) {
          lastErr = e;
          console.warn('[fetch fallback failed]', url, e && e.message);
        }
      }
      throw lastErr;
    },

    // enabledIds: 启用的新闻源 id 集合（Set）；enabledHotIds: 启用的热榜源 id 集合（Set）；为 null 表示全部启用
    // mode: 'all' | 'news' | 'hot'（拆分刷新：只抓新闻或只抓榜单）
    // onSourceDone(src, items): 每完成一个新闻源时回调，便于界面即时增量渲染
    async refreshAll(onProgress, onSourceDone, enabledIds, enabledHotIds, mode) {
      const wantNews = !mode || mode === 'all' || mode === 'news';
      const wantHot = !mode || mode === 'all' || mode === 'hot';
      const newsSources = wantNews
        ? (enabledIds ? SOURCES.NEWS_SOURCES.filter(s => enabledIds.has(s.id)) : SOURCES.NEWS_SOURCES)
        : [];
      const hotSources = wantHot
        ? (enabledHotIds ? SOURCES.HOT_SOURCES.filter(s => enabledHotIds.has(s.id)) : SOURCES.HOT_SOURCES)
        : [];
      const total = newsSources.length + hotSources.length;
      let done = 0;
      const news = [];

      if (wantNews) {
        await mapPool(newsSources, policy.concurrency, async (src) => {
          const label = '新闻 · ' + src.name;
          let items = [];
          try {
            const urls = [src.url].concat(src.fallbacks || []);
            const prev = policy.conditional ? (feedHeaders.get(src.url) || {}) : {};
            const res = await this.fetchWithFallbacks(urls, policy.conditional ? { etag: prev.etag, lastModified: prev.lastModified } : {});
            if (!(res && res.notModified) && res && res.body) {
              items = FeedParser.parseFeed(res.body, src);
              if (policy.conditional && res) {
                feedHeaders.set(src.url, { etag: res.etag, lastModified: res.lastModified });
              }
            }
          } catch (e) {
            console.warn('[新闻源失败]', src.name, e && e.message);
          }
          if (items.length) {
            for (const it of items) news.push(it);
            if (onSourceDone) onSourceDone(src, items);
          }
          done++;
          if (onProgress) onProgress(done, total, label);
        });
      }

      const hot = {};
      if (wantHot) {
        await mapPool(hotSources, policy.concurrency, async (src) => {
          const r = await this.fetchHotSource(src);
          hot[src.id] = { name: src.name, grade: src.grade, region: src.region, items: r.items || [], error: r.error };
          done++;
          if (onProgress) onProgress(done, total, '热搜 · ' + src.name);
        });
      }

      news.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      if (onProgress) onProgress(total, total, '完成');
      return { news, hot };
    },

    // 单个热榜源抓取：API → 网页兜底 → 代理兜底 → 再网页兜底
    async fetchHotSource(src) {
      let items = [];
      let error = null;
      try {
        let text = null;
        const apiErr = await (async () => {
          const urls = [src.url].concat(src.fallbacks || []);
          let lastErr = new Error('无可用 API');
          for (const u of urls) {
            try { const r = await this.fetchText(u); text = r && r.body; return null; }
            catch (e) { lastErr = e; }
          }
          return lastErr;
        })();

        const tryHtml = async (url) => {
          const htmlText = await this.fetchHotHtml(url, (src.html && src.html.headers) || {});
          const doc = (typeof DOMParser !== 'undefined')
            ? new DOMParser().parseFromString(htmlText, 'text/html')
            : null;
          return (typeof src.parseHtml === 'function') ? src.parseHtml(doc, htmlText) : [];
        };

        if (apiErr && src.html && src.html.url) {
          try {
            items = await tryHtml(src.html.url);
            if (items && items.length) error = null;
            else throw new Error('网页抓取未解析到条目');
          } catch (he) {
            // 直接网页失败时，尝试通过 CORS 代理抓取网页
            try {
              items = await tryHtml('https://api.allorigins.win/raw?url=' + encodeURIComponent(src.html.url));
              if (items && items.length) error = null;
              else throw new Error('代理网页未解析到条目');
            } catch (pe) {
              error = 'API：' + (apiErr && apiErr.message) + '；网页：' + (he && he.message);
            }
          }
        } else if (apiErr) {
          error = apiErr.message;
        }

        if (!error && text && !items.length) {
          let data = text;
          try { data = JSON.parse(text); } catch (_) { /* 可能是 XML/HTML */ }
          items = (typeof src.parse === 'function') ? src.parse(data) : [];
        }

        if (!error && (!items || !items.length) && src.html && src.html.url) {
          try {
            items = await tryHtml(src.html.url);
          } catch (he) {
            try {
              items = await tryHtml('https://api.allorigins.win/raw?url=' + encodeURIComponent(src.html.url));
            } catch (pe) {
              error = (error ? error + '；' : '') + '网页：' + (he && he.message);
            }
          }
        }
      } catch (e) {
        error = (e && e.message) || String(e);
      }
      if ((!items || !items.length) && !error) error = '所有可用地址均未返回有效数据';
      return { items, error };
    }
  };

  global.DataLayer = DataLayer;
})(typeof window !== 'undefined' ? window : globalThis);
