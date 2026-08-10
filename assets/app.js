/*
 * app.js —— 界面交互逻辑（Apple 风格统一交互）
 * 负责：页面切换 / 搜索 / 筛选 / 时间分割线 / 日历 / 收藏 /
 *       热榜点击 / 发布者跳转 / 设置 / 可视化 / 文章详情。
 * 注意：地图模块已拆出到 dev/map-module.js，当前编译版本不包含地图代码。
 */
(function () {
  'use strict';

  const CATEGORY_NAMES = SOURCES.CATEGORY_NAMES;
  const REGION_NAMES = SOURCES.REGION_NAMES;
  const POLITICAL_LEAN_NAMES = SOURCES.POLITICAL_LEAN_NAMES;

  const HOT_TABS = [
    { key: 'weibo', label: '微博', ids: ['weibo'] },
    { key: 'baidu', label: '百度', ids: ['baidu'] },
    { key: 'zhihu', label: '知乎', ids: ['zhihu'] },
    { key: 'intl',  label: '国际', ids: ['hackernews', 'reddit-world', 'reddit-tech'] }
  ];

  // 地点识别已迁移到 sources.js 的 detectLocation，使用 LOCATION_TABLE 城市/国家坐标表

  const state = {
    news: [],
    hot: {},
    filters: { region: 'all', category: 'all', grade: 'all', search: '', dateFrom: '', dateTo: '', sources: new Set() },
    srcFilters: { region: 'all', grade: 'all', lean: 'all', search: '' },
    hotTab: 'weibo',
    favorites: new Map(),   // favKey -> item
    settings: null,
    calendarDate: null,
    vizRange: 'all',
    page: 'news',
    renderLimit: 60
  };

  let settings = Store.defaultSettings();
  let userSources = [];  // 用户自定义信源（来自 data/user_sources.json）
  let userSourceIds = new Set();  // 用户自定义信源 id 集合（用于判断可否删除）
  let pendingNewKeys = new Set();  // 本次渲染需要"入场动画"的新闻 dedupeKey 集合（每次渲染后清空）

  // 封面图延迟加载观察器：卡片进入视口附近再真正加载图片，避免一次性发起海量请求拖慢主线程
  let coverObserver = null;
  function ensureCoverObserver() {
    if (coverObserver) return coverObserver;
    coverObserver = new IntersectionObserver((entries) => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        const wrap = en.target;
        coverObserver.unobserve(wrap);
        const url = wrap.dataset.src || '';
        const fallback = wrap.dataset.fallback || '';
        loadCoverImage(wrap, url || fallback, fallback);
      });
    }, { root: null, rootMargin: '180px 0px' });
    return coverObserver;
  }
  function loadCoverImage(wrap, url, fallbackUrl) {
    if (!url) { showCoverPlaceholder(wrap); return; }
    const img = document.createElement('img');
    img.alt = ''; img.className = 'img-hidden';
    let timer = null;
    const done = (ok) => {
      if (timer) { clearTimeout(timer); timer = null; }
      const loader = wrap.querySelector('.img-loader');
      const err = wrap.querySelector('.img-error');
      const ph = wrap.querySelector('.ph');
      if (ok) {
        if (loader) loader.classList.add('hidden');
        if (err) err.classList.add('hidden');
        if (ph) ph.classList.add('hidden');
        img.classList.remove('img-hidden');
      } else if (url !== fallbackUrl && fallbackUrl) {
        // 主图失败时尝试 fallback（通常为信源 logo）
        img.remove();
        loadCoverImage(wrap, fallbackUrl, fallbackUrl);
        return;
      } else {
        if (loader) loader.classList.add('hidden');
        if (err) err.classList.remove('hidden');
        if (ph) ph.classList.remove('hidden');
      }
    };
    img.onload = () => done(true);
    img.onerror = () => done(false);
    timer = setTimeout(() => done(false), 9000);
    wrap.appendChild(img);
    img.src = url;
    // 本地缓存替换（在远程加载之后再触发，避免阻塞）
    if (settings.imageCaching !== 'off') {
      Store.cacheImage(url, { favorite: false }).then(local => {
        if (local && img.isConnected) img.src = local;
      });
    }
  }
  function showCoverPlaceholder(wrap) {
    const loader = wrap.querySelector('.img-loader');
    const err = wrap.querySelector('.img-error');
    const ph = wrap.querySelector('.ph');
    if (loader) loader.classList.add('hidden');
    if (err) err.classList.add('hidden');
    if (ph) ph.classList.remove('hidden');
  }

  // 并发抓取时多个源几乎同时完成，用防抖把多次整页渲染合并为一次，避免卡顿
  let renderScheduled = false;
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    setTimeout(() => {
      renderScheduled = false;
      renderNews({ animate: true }); renderCalendar(); renderVizIfVisible();
    }, 140);
  }

  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeHtml(s) { return esc(s); }
  function formatTime(ts) {
    if (!ts) return '未知';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '未知';
    return d.toLocaleString('zh-CN', { hour12: false });
  }
  function favKey(it) { return (it.sourceId || '') + '|' + (it.link || '') + '|' + (it.title || ''); }
  function isFav(it) { return state.favorites.has(favKey(it)); }
  function sourceWebsite(src) {
    if (!src) return '';
    const logo = src.profile && src.profile.logo;
    if (logo) { try { return new URL(logo).origin; } catch (_) {} }
    return 'https://www.google.com/search?q=' + encodeURIComponent(src.name || '');
  }
  function enabledSourceIds() {
    const set = new Set();
    for (const s of SOURCES.NEWS_SOURCES) {
      if (settings.sources[s.id] !== false) set.add(s.id);
    }
    return set;
  }

  // ---------- 页面切换 ----------
  function switchPage(page) {
    state.page = page;
    document.querySelectorAll('#top-nav .nav-pill').forEach(b => b.classList.toggle('active', b.dataset.page === page));
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
    if (page === 'sources') renderSources();
    if (page === 'viz') renderViz();
    if (page === 'settings') renderSettings();
  }

  // ---------- 封面图容器 ----------
  function createCover(url, title, fallbackUrl) {
    const wrap = document.createElement('div');
    wrap.className = 'cover';
    const loader = document.createElement('div');
    loader.className = 'img-loader';
    loader.innerHTML = '<div class="img-loader-track"><div class="img-loader-bar"></div></div><span class="img-loader-text">图片加载中…</span>';
    const err = document.createElement('div');
    err.className = 'img-error hidden';
    err.innerHTML = '<span class="img-error-icon">📷</span><p>图片加载失败</p><small>网络或源地址问题</small>';
    const ph = document.createElement('span');
    ph.className = 'ph hidden';
    ph.textContent = title ? title.charAt(0) : '📰';
    wrap.appendChild(loader); wrap.appendChild(err); wrap.appendChild(ph);

    const finalUrl = url || fallbackUrl;
    if (!finalUrl) { showCoverPlaceholder(wrap); return wrap; }

    // 利用 IntersectionObserver 延迟加载：不在视口内时不创建 <img>，显著降低初始渲染压力
    wrap.dataset.src = url || '';
    wrap.dataset.fallback = fallbackUrl || '';
    ensureCoverObserver().observe(wrap);
    return wrap;
  }

  function sanitizeHtml(html) {
    if (!html) return '';
    return String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
      .replace(/\s(on\w+\s*=)/gi, ' data-disabled-$1')
      .replace(/javascript:/gi, 'disabled-js:');
  }

  // ---------- 新闻渲染（含时间分割线） ----------
  function dateStr(ts) {
    const d = new Date(ts); const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  function matchFilters(it) {
    const f = state.filters;
    if (f.region === 'cn' && it.region !== 'cn') return false;
    if (f.region === 'foreign' && it.region === 'cn') return false;
    if (f.category !== 'all' && !(it.categories || []).includes(f.category)) return false;
    if (f.grade !== 'all' && it.grade !== f.grade) return false;
    const kw = (f.search || '').trim().toLowerCase();
    if (kw && !(it.title || '').toLowerCase().includes(kw) &&
        !(it.source || '').toLowerCase().includes(kw)) return false;
    if (f.sources.size > 0 && !f.sources.has(it.sourceId)) return false;
    if (f.dateFrom || f.dateTo) {
      const t = it.timestamp || 0;
      if (f.dateFrom && t < new Date(f.dateFrom + 'T00:00:00').getTime()) return false;
      if (f.dateTo && t > new Date(f.dateTo + 'T23:59:59').getTime()) return false;
    }
    return true;
  }

  // 单张卡片 DOM 构造（抽出复用，便于分片渲染）
  function buildCard(it, animate) {
    const key = Store.dedupeKey(it);
    const card = document.createElement('article');
    card.className = 'card' + (isFav(it) ? ' fav-mark' : '');
    card.dataset.key = key;
    if (animate && pendingNewKeys.has(key)) card.classList.add('entering');
    const cats = (it.categories || []).map(c => CATEGORY_NAMES[c] || c).join(' · ');
    const regionText = REGION_NAMES[it.region] || it.region;
    const srcObj = SOURCES.NEWS_SOURCES.find(s => s.id === it.sourceId);
    const fallbackLogo = (srcObj && srcObj.profile && srcObj.profile.logo) || '';
    card.innerHTML =
      '<div class="body">' +
        '<div class="badges">' +
          '<span class="badge ' + it.grade + '">' + it.grade + '</span>' +
          (cats ? '<span class="cat-tag">' + cats + '</span>' : '') +
          (isFav(it) ? '<span class="cat-tag" style="color:var(--warn)">★ 收藏</span>' : '') +
        '</div>' +
        '<h3 class="title">' + esc(it.title) + '</h3>' +
        (it.summary ? '<p class="summary">' + esc(it.summary) + '</p>' : '') +
        '<div class="meta">' +
          '<span class="src">' + esc(it.source) + '</span>' +
          '<span>' + regionText + (it.lang ? ' · ' + it.lang : '') + '</span>' +
          '<span>' + (it.dateText || '时间未知') + '</span>' +
        '</div>' +
      '</div>';
    const coverWrap = createCover(it.cover, it.title, fallbackLogo);
    card.insertBefore(coverWrap, card.firstChild);
    card.addEventListener('click', () => openArticleModal(it));
    return card;
  }

  // 将列表按日期分组并渲染前 N 条；超过部分通过「加载更多」分批追加，避免一次性插入海量 DOM 导致掉帧
  function renderNews(opts) {
    opts = opts || {};
    const animate = !!opts.animate && settings.animations !== false && !reducedMotion();
    const grid = el('news-grid');

    const firstRects = new Map();
    if (animate) {
      grid.querySelectorAll('.card[data-key]').forEach(c => {
        firstRects.set(c.dataset.key, c.getBoundingClientRect());
      });
    }

    const list = state.news.filter(matchFilters);
    el('news-count').textContent = list.length + ' 条';

    if (list.length === 0) {
      grid.innerHTML = '<div class="placeholder">没有符合条件的新闻，试试调整筛选或点「立即刷新」。</div>';
      pendingNewKeys.clear();
      return;
    }

    const limit = Math.max(30, state.renderLimit || 60);
    const visible = list.slice(0, limit);
    const frag = document.createDocumentFragment();
    let lastMonth = '', lastDay = '';
    for (const it of visible) {
      const ds = dateStr(it.timestamp || Date.now());
      const d = new Date(it.timestamp || Date.now());
      const month = ds.slice(0, 7);
      const dow = '星期' + WEEK[d.getDay()];
      if (month !== lastMonth) {
        const div = document.createElement('div');
        div.className = 'divider month';
        div.innerHTML = '<span class="divider-label">' + month + ' 月</span>';
        frag.appendChild(div);
        lastMonth = month; lastDay = '';
      } else if (ds !== lastDay) {
        const div = document.createElement('div');
        div.className = 'divider';
        div.innerHTML = '<span class="divider-label">' + ds + ' ' + dow + '</span>';
        frag.appendChild(div);
      }
      lastDay = ds;
      frag.appendChild(buildCard(it, animate));
    }

    grid.innerHTML = '';
    grid.appendChild(frag);

    if (list.length > limit) {
      const more = document.createElement('button');
      more.className = 'btn-ghost load-more';
      more.innerHTML = '加载更多 <span class="load-more-count">(' + (list.length - limit) + ' 条未显示)</span>';
      more.addEventListener('click', () => {
        state.renderLimit = limit + 40;
        renderNews({ animate: false });
      });
      grid.appendChild(more);
      ensureNewsScrollLoader();
    } else {
      state.newsScrollLoaderAttached = false;
    }

    // FLIP：仅对当前渲染出的卡片做平滑位移，数量大时自动跳过以保性能
    if (animate) {
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      const cards = grid.querySelectorAll('.card[data-key]');
      // 卡片过多时直接放弃 FLIP，避免主线程被位置计算拖住
      if (cards.length <= 120) {
        cards.forEach(c => {
          const key = c.dataset.key;
          if (c.classList.contains('entering')) return;
          const first = firstRects.get(key);
          if (!first) return;
          const last = c.getBoundingClientRect();
          const dx = first.left - last.left;
          const dy = first.top - last.top;
          if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
          if (last.bottom < -60 || last.top > vh + 60) return;
          c.style.transition = 'none';
          c.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
          void c.offsetWidth;
          requestAnimationFrame(() => {
            c.style.transition = 'transform 0.42s cubic-bezier(0.16, 1, 0.3, 1)';
            c.style.transform = '';
            const onEnd = (e) => {
              if (e.propertyName !== 'transform') return;
              c.style.transition = '';
              c.style.transform = '';
              c.removeEventListener('transitionend', onEnd);
            };
            c.addEventListener('transitionend', onEnd);
          });
        });
      }
      pendingNewKeys.clear();
    }
  }

  // 筛选条件变化时回到首页渲染数量，避免从旧 limit 开始显示空列表
  function resetAndRenderNews(opts) {
    state.renderLimit = 60;
    renderNews(opts);
  }

  // 页面滚动到底时自动加载更多新闻（节流）
  function ensureNewsScrollLoader() {
    if (state.newsScrollLoaderAttached) return;
    state.newsScrollLoaderAttached = true;
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const more = el('news-grid') && el('news-grid').querySelector('.load-more');
        if (!more) return;
        const threshold = 300;
        const nearBottom = (document.documentElement.scrollHeight - window.innerHeight - window.scrollY) < threshold;
        if (nearBottom) more.click();
      });
    }, { passive: true });
  }

  // ---------- 热搜 ----------
  function enabledHotTabs() {
    return HOT_TABS.filter(t => settings.hot && settings.hot[t.key] !== false);
  }

  function renderHotTabs() {
    const wrap = el('hot-tabs');
    wrap.innerHTML = '';
    const tabs = enabledHotTabs();
    if (tabs.length === 0) {
      wrap.innerHTML = '<span class="hot-empty" style="padding:0">请在「设置 → 热搜榜单」中至少开启一个榜单。</span>';
      return;
    }
    // 当前选中项若被禁用，切到第一个可用
    if (!tabs.some(t => t.key === state.hotTab)) state.hotTab = tabs[0].key;
    tabs.forEach(t => {
      const b = document.createElement('button');
      b.className = 'hot-tab' + (t.key === state.hotTab ? ' active' : '');
      b.textContent = t.label;
      b.addEventListener('click', () => { state.hotTab = t.key; renderHotTabs(); renderHot(); });
      wrap.appendChild(b);
    });
  }

  function renderHot() {
    const box = el('hot-list');
    const tabs = enabledHotTabs();
    if (tabs.length === 0) {
      box.innerHTML = '<div class="hot-empty">未启用任何热搜榜单，请到「设置」中开启。</div>';
      return;
    }
    const tab = tabs.find(t => t.key === state.hotTab) || tabs[0];
    let items = [], errors = [];
    tab.ids.forEach(id => {
      const src = state.hot[id];
      if (src && src.items) items = items.concat(src.items);
      if (src && src.error) errors.push(src.name + '：' + src.error);
    });
    items.sort((a, b) => (b.hot || 0) - (a.hot || 0));
    const maxItems = (settings.hot && settings.hot.maxItems) || 30;
    items = items.slice(0, maxItems);
    box.innerHTML = '';
    if (items.length === 0) {
      box.innerHTML = '<div class="hot-empty">该榜单暂未获取到数据（可能源临时不可用或网络受限）。</div>';
      if (errors.length) {
        const err = document.createElement('div');
        err.className = 'hot-error';
        err.textContent = errors.slice(0, 3).join('｜');
        box.appendChild(err);
      }
      return;
    }
    const ol = document.createElement('ol');
    items.forEach((it, i) => {
      const li = document.createElement('li');
      li.className = 'hot-item';
      const heat = formatHeat(it.hot);
      li.innerHTML = '<span class="rank">' + (i + 1) + '</span>' +
                     '<span class="hot-title">' + esc(it.title) + '</span>' +
                     (heat ? '<span class="heat">' + heat + '</span>' : '');
      li.addEventListener('click', () => openHotModal(it));
      ol.appendChild(li);
    });
    box.appendChild(ol);
  }

  function openHotModal(it) {
    el('hot-title').textContent = it.title || '热搜';
    el('hot-meta').textContent = it.hot ? ('热度：' + formatHeat(it.hot)) : '热搜条目';
    const openBtn = el('hot-open');
    openBtn.onclick = () => { if (it.url) openLink(it.url); };
    openBtn.disabled = !it.url;
    const contentEl = el('hot-content');
    contentEl.innerHTML = '';
    el('hot-modal').classList.remove('hidden');

    if (!it.url) return;
    const loader = document.createElement('p'); loader.className = 'no-content'; loader.textContent = '正在获取条目详情…';
    contentEl.appendChild(loader);
    DataLayer.fetchText(it.url).then(res => {
      const html = (res && res.body != null) ? res.body : res;
      if (!html || !html.trim()) throw new Error('empty');
      const full = FeedParser.extractArticle(html, it.url, { clean: settings.smartClean !== false });
      const text = FeedParser.stripHtml(full || '').trim();
      if (text.length < 80) throw new Error('no content');
      contentEl.innerHTML = sanitizeHtml(full);
      contentEl.querySelectorAll('a').forEach(a => {
        a.target = '_blank'; a.rel = 'noopener';
        a.addEventListener('click', (e) => { const href = a.getAttribute('href'); if (href) { e.preventDefault(); openLink(href); } });
      });
    }).catch(() => {
      contentEl.innerHTML = '<p class="no-content">无法在当前网络下获取该条目详情，可点击「用浏览器打开」阅读。</p>';
    });
  }
  function closeHotModal() { el('hot-modal').classList.add('hidden'); }

  // ---------- 更新状态提示弹窗（替代原生 dialog） ----------
  function showUpdateStatusModal(data) {
    data = data || {};
    const modal = el('update-status-modal');
    const iconWrap = el('update-status-icon');
    const isWarning = data.type === 'warning';
    iconWrap.className = 'update-status-icon' + (isWarning ? ' warning' : ' info');
    iconWrap.innerHTML = isWarning
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';
    el('update-status-title').textContent = data.title || '提示';
    el('update-status-message').textContent = data.message || '';
    const detail = el('update-status-detail');
    if (data.detail) { detail.textContent = data.detail; detail.classList.remove('hidden'); }
    else { detail.classList.add('hidden'); }
    modal.classList.remove('hidden');
  }
  function hideUpdateStatusModal() { el('update-status-modal').classList.add('hidden'); }

  // ---------- 设置页检查更新状态标签与进度条 ----------
  function setUpdateStatus(text, mood) {
    const s = el('update-status');
    if (!s) return;
    s.textContent = text || '';
    s.className = 'update-status' + (mood ? ' ' + mood : '');
  }
  function showUpdateBar() {
    const wrap = el('update-bar-wrap');
    if (wrap) wrap.classList.remove('hidden');
  }
  function hideUpdateBar() {
    const wrap = el('update-bar-wrap');
    const fill = el('update-bar-fill');
    const pct = el('update-bar-pct');
    if (wrap) wrap.classList.add('hidden');
    if (fill) { fill.style.width = '0%'; fill.classList.remove('done'); }
    if (pct) pct.textContent = '0%';
  }
  function setUpdateBar(pct) {
    const fill = el('update-bar-fill');
    const pctEl = el('update-bar-pct');
    if (fill) fill.style.width = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';
  }
  function markUpdateBarDone() {
    const fill = el('update-bar-fill');
    const pctEl = el('update-bar-pct');
    if (fill) { fill.style.width = '100%'; fill.classList.add('done'); }
    if (pctEl) pctEl.textContent = '100%';
  }

  function formatHeat(n) {
    if (n == null) return '';
    if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
    if (n >= 10000) return (n / 10000).toFixed(1) + '万';
    return String(n);
  }

  // ---------- 发布者 ----------
  function getUniqueSources() {
    const map = new Map();
    for (const s of SOURCES.NEWS_SOURCES) if (!map.has(s.id)) map.set(s.id, s);
    return Array.from(map.values());
  }
  function renderSources() {
    const grid = el('sources-grid');
    const f = state.srcFilters;
    const kw = (f.search || '').trim().toLowerCase();
    const list = getUniqueSources().filter(it => {
      if (f.region !== 'all' && it.region !== f.region) return false;
      if (f.grade !== 'all' && it.grade !== f.grade) return false;
      const lean = (it.profile && it.profile.politicalLean) || '';
      if (f.lean !== 'all' && lean !== f.lean) return false;
      if (kw) {
        const hay = [it.name, it.profile && it.profile.fullName, it.profile && it.profile.country, it.profile && it.profile.background].join(' ').toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
    el('sources-count').textContent = list.length + ' 个';
    if (list.length === 0) { grid.innerHTML = '<div class="placeholder">没有符合条件的发布者。</div>'; return; }
    const frag = document.createDocumentFragment();
    for (const it of list) {
      const p = it.profile || {};
      const leanText = POLITICAL_LEAN_NAMES[p.politicalLean] || p.politicalLean || '未知';
      const regionText = REGION_NAMES[it.region] || it.region || '未知';
      const logoUrl = p.logo || '';
      const card = document.createElement('div');
      card.className = 'source-card';
      card.innerHTML =
        '<div class="source-logo">' +
          (logoUrl ? '<img src="' + encodeURI(logoUrl) + '" alt="" onerror="this.style.display=\'none\'; this.nextElementSibling.style.display=\'flex\'">' +
                     '<span class="logo-ph" style="display:none">' + (it.name.charAt(0) || '📰') + '</span>'
                   : '<span class="logo-ph">' + (it.name.charAt(0) || '📰') + '</span>') +
        '</div>' +
        '<div class="source-body">' +
          '<h3 class="source-name">' + esc(it.name) + '</h3>' +
          '<div class="source-tags">' +
            '<span class="badge ' + it.grade + '">' + it.grade + '</span>' +
            '<span class="source-tag">' + regionText + '</span>' +
            '<span class="source-tag lean">' + leanText + '</span>' +
            (it.lang ? '<span class="source-tag">' + esc(it.lang) + '</span>' : '') +
          '</div>' +
          '<p class="source-bg">' + esc(p.background || '暂无背景介绍。') + '</p>' +
        '</div>';
      card.addEventListener('click', () => openLink(sourceWebsite(it)));
      frag.appendChild(card);
    }
    grid.innerHTML = ''; grid.appendChild(frag);
  }

  // ---------- 添加自定义信源 ----------
  function openAddSourceModal() {
    el('as-name').value = '';
    el('as-url').value = '';
    el('as-lang').value = '中文';
    el('as-country').value = '';
    el('as-background').value = '';
    el('as-region').value = 'cn';
    el('as-grade').value = 'P1';
    el('as-categories').querySelectorAll('input').forEach(cb => { cb.checked = false; });
    el('as-error').textContent = '';
    el('add-source-modal').classList.remove('hidden');
  }
  function closeAddSourceModal() {
    el('add-source-modal').classList.add('hidden');
  }
  async function saveUserSource() {
    const name = (el('as-name').value || '').trim();
    const url = (el('as-url').value || '').trim();
    const region = el('as-region').value;
    const grade = el('as-grade').value;
    const lang = (el('as-lang').value || '').trim() || '中文';
    const country = (el('as-country').value || '').trim();
    const background = (el('as-background').value || '').trim();
    const categories = Array.from(el('as-categories').querySelectorAll('input:checked')).map(cb => cb.value);
    const err = el('as-error');
    if (!name) { err.textContent = '请填写信源名称'; return; }
    if (!/^https?:\/\//i.test(url)) { err.textContent = '请填写有效的 RSS / Atom 地址（以 http:// 或 https:// 开头）'; return; }
    if (categories.length === 0) { err.textContent = '请至少选择一个分类'; return; }
    const id = 'user-' + Date.now().toString(36);
    const src = {
      id, name, grade, region, categories, lang, url,
      profile: { fullName: name, country: country || '未知', background: background || '用户添加的信源。' }
    };
    userSources.push(src);
    userSourceIds.add(id);
    await Store.saveUserSources(userSources);
    SOURCES.NEWS_SOURCES = SOURCES.NEWS_SOURCES.concat([src]);
    err.textContent = '';
    closeAddSourceModal();
    renderSources();
    renderSourceFilterChips();
    el('as-save').textContent = '已添加 ✓';
    setTimeout(() => { el('as-save').textContent = '保存信源'; }, 1500);
  }

  // ---------- 信源管理（发布者页弹窗） ----------
  let pendingDelete = null;
  function isUserSource(id) { return userSourceIds.has(id); }

  function openSourceManageModal() {
    if (!state.smSelected) state.smSelected = new Set();
    renderSourceManageList();
    el('source-manage-modal').classList.remove('hidden');
  }
  function closeSourceManageModal() { hideSmConfirm(); el('source-manage-modal').classList.add('hidden'); }

  function updateSmCount() {
    const n = (state.smSelected || new Set()).size;
    const c = el('sm-count'); if (c) c.textContent = '已选 ' + n;
    const all = el('sm-select-all');
    if (all) all.checked = n === SOURCES.NEWS_SOURCES.length && n > 0;
  }

  function renderSourceManageList() {
    const box = el('source-manage-list');
    if (!box) return;
    box.innerHTML = '';
    const selected = state.smSelected || (state.smSelected = new Set());
    const frag = document.createDocumentFragment();
    for (const s of SOURCES.NEWS_SOURCES) {
      const user = isUserSource(s.id);
      const enabled = settings.sources[s.id] !== false;
      const row = document.createElement('div');
      row.className = 'sm-row' + (selected.has(s.id) ? ' selected' : '');
      const cats = (s.categories || []).map(c => CATEGORY_NAMES[c] || c).join('·');
      row.innerHTML =
        '<input type="checkbox" class="sm-check" ' + (selected.has(s.id) ? 'checked' : '') + ' />' +
        '<span class="sm-name">' + esc(s.name) + '</span>' +
        '<span class="sm-tags"><span class="sm-tag">' + (REGION_NAMES[s.region] || s.region) + '</span>' +
          '<span class="sm-tag">' + s.grade + '</span>' +
          (cats ? '<span class="sm-tag">' + esc(cats) + '</span>' : '') + '</span>' +
        '<label class="sm-toggle"><input type="checkbox" class="sm-enable" ' + (enabled ? 'checked' : '') + ' />' +
          '<span class="sm-enable-text">' + (enabled ? '启用' : '禁用') + '</span></label>' +
        '<button class="sm-del" ' + (user ? '' : 'disabled') + '>' + (user ? '删除' : '内置') + '</button>';
      row.querySelector('.sm-check').addEventListener('change', (e) => {
        if (e.target.checked) selected.add(s.id); else selected.delete(s.id);
        row.classList.toggle('selected', e.target.checked);
        updateSmCount();
      });
      row.querySelector('.sm-enable').addEventListener('change', (e) => {
        settings.sources[s.id] = e.target.checked;
        row.querySelector('.sm-enable-text').textContent = e.target.checked ? '启用' : '禁用';
        Store.saveSettings(settings);
        renderSources(); renderSourceFilterChips();
      });
      row.querySelector('.sm-del').addEventListener('click', () => {
        if (!user) return;
        pendingDelete = [s.id];
        showSmConfirm('确定删除发布者「' + s.name + '」？此操作不可撤销。');
      });
      frag.appendChild(row);
    }
    box.appendChild(frag);
    updateSmCount();
  }

  function smBatchEnable(val) {
    const selected = state.smSelected || new Set();
    if (selected.size === 0) { el('sm-count').textContent = '请先勾选信源'; return; }
    selected.forEach(id => { settings.sources[id] = val; });
    Store.saveSettings(settings);
    renderSourceManageList(); renderSources(); renderSourceFilterChips();
  }
  function smBatchDelete() {
    const selected = state.smSelected || new Set();
    const ids = Array.from(selected).filter(id => isUserSource(id));
    if (ids.length === 0) { el('sm-count').textContent = '选中的没有可删除的用户信源'; return; }
    pendingDelete = ids;
    showSmConfirm('确定删除选中的 ' + ids.length + ' 个用户发布者？此操作不可撤销。');
  }
  function showSmConfirm(text) { el('sm-confirm-text').textContent = text; el('sm-confirm').classList.remove('hidden'); }
  function hideSmConfirm() { el('sm-confirm').classList.add('hidden'); pendingDelete = null; }
  async function doSmDelete() {
    if (!pendingDelete) return;
    const ids = pendingDelete;
    userSources = userSources.filter(s => !ids.includes(s.id));
    userSourceIds = new Set(userSources.map(s => s.id));
    SOURCES.NEWS_SOURCES = SOURCES.NEWS_SOURCES.filter(s => !ids.includes(s.id));
    await Store.saveUserSources(userSources);
    ids.forEach(id => { delete settings.sources[id]; });
    await Store.saveSettings(settings);
    (state.smSelected || (state.smSelected = new Set())).clear();
    hideSmConfirm();
    renderSourceManageList(); renderSources(); renderSourceFilterChips();
  }

  // ---------- 缓存统计与清理（设置页） ----------
  function formatBytes(n) {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  async function refreshCacheStats() {
    const api = window.electronAPI && window.electronAPI.storage;
    if (!api || !api.dirInfo) return;
    const btn = el('refresh-stats');
    const origText = btn ? btn.textContent : '刷新统计';
    try {
      if (btn) { btn.classList.add('loading'); btn.textContent = '刷新中…'; btn.disabled = true; }
      const img = await api.dirInfo('images');
      const cache = await api.dirInfo('cache');
      el('stat-image-size').textContent = formatBytes(img && img.bytes);
      el('stat-news-size').textContent = formatBytes(cache && cache.bytes);
      el('stat-image-files').textContent = (img && img.files != null ? img.files : '—') + ' 个文件';
      showToast('缓存统计已刷新');
    } catch (e) {
      el('stat-image-size').textContent = '—';
      el('stat-news-size').textContent = '—';
      el('stat-image-files').textContent = '—';
      showToast('刷新统计失败');
    } finally {
      if (btn) { btn.classList.remove('loading'); btn.textContent = origText; btn.disabled = false; }
    }
  }

  // ---------- 文章详情弹窗 ----------
  let currentModalItem = null;
  let heroScrolled = false;
  function openArticleModal(item) {
    currentModalItem = item;
    el('modal-title').textContent = item.title || '无标题';
    const cats = (item.categories || []).map(c => CATEGORY_NAMES[c] || c).join(' · ');
    const regionText = REGION_NAMES[item.region] || item.region || '';
    el('modal-badges').innerHTML = '<span class="badge ' + item.grade + '">' + item.grade + '</span>' + (cats ? '<span class="cat-tag">' + cats + '</span>' : '');
    el('modal-meta').innerHTML = '<span class="src">' + esc(item.source || '') + '</span><span>' + regionText + (item.lang ? ' · ' + item.lang : '') + '</span><span>' + (item.dateText || '时间未知') + '</span>';

    const coverWrap = el('modal-cover'); coverWrap.innerHTML = '';
    const heroCover = createCover(item.cover, item.title);
    coverWrap.appendChild(heroCover);

    el('modal-hero').classList.remove('scrolled');
    heroScrolled = false;
    el('modal-body').scrollTop = 0;

    renderModalContent(item.content || item.summary, !item.content && item.summary);
    if (shouldFetchFullArticle(item)) loadFullArticle(item);

    const favBtn = el('modal-favorite');
    favBtn.textContent = isFav(item) ? '★ 已收藏' : '☆ 收藏';
    favBtn.classList.toggle('favorited', isFav(item));
    favBtn.onclick = () => toggleFavorite(item);

    const openBtn = el('modal-open-external');
    openBtn.onclick = () => { if (item.link) openLink(item.link); };
    openBtn.disabled = !item.link;

    el('article-modal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
  function closeArticleModal() {
    currentModalItem = null;
    el('article-modal').classList.add('hidden');
    document.body.style.overflow = '';
  }

  function shouldFetchFullArticle(item) {
    if (!item || !item.link) return false;
    return FeedParser.stripHtml(item.content || '').trim().length < 1200;
  }

  function removeDuplicateTitle(root, title) {
    if (!title || !root) return;
    const firstH = root.querySelector('h1, h2, h3');
    if (!firstH) return;
    const hText = (firstH.innerText || '').trim();
    if (!hText) return;
    const t = title.trim().toLowerCase(), h = hText.toLowerCase();
    if (t.includes(h) || h.includes(t) || similarity(t, h) > 0.65) firstH.remove();
  }
  function similarity(a, b) {
    if (!a || !b) return 0;
    const bigrams = s => { const set = new Set(); for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2)); return set; };
    const A = bigrams(a), B = bigrams(b);
    const inter = new Set([...A].filter(x => B.has(x)));
    return inter.size / Math.max(A.size, B.size);
  }

  function renderModalContent(html, isSummaryOnly, statusNote) {
    const contentEl = el('modal-content');
    if (html && html.trim()) {
      if (settings.smartClean !== false) {
        html = FeedParser.cleanArticleHtml(html, currentModalItem && currentModalItem.link, { aggressive: false });
      }
      contentEl.innerHTML = sanitizeHtml(html);
      removeDuplicateTitle(contentEl, el('modal-title').textContent);
      if (isSummaryOnly) contentEl.innerHTML += '<p class="no-content">该信源仅提供摘要，正在尝试获取完整正文…</p>';
    } else {
      contentEl.innerHTML = '<p class="no-content">该信源未提供正文内容。</p>';
    }
    if (statusNote) {
      const note = document.createElement('p'); note.className = 'no-content'; note.textContent = statusNote;
      contentEl.appendChild(note);
    }
    // 内容图片：按需加载 + 失败占位 + 本地化缓存
    contentEl.querySelectorAll('img').forEach(img => {
      img.loading = 'lazy';
      const orig = img.getAttribute('src') || '';
      if (orig && settings.imageCaching !== 'off') {
        Store.cacheImage(orig, { favorite: isFav(currentModalItem) }).then(local => { if (local && img.isConnected) img.src = local; });
      }
      img.onerror = function () {
        const note = document.createElement('div'); note.className = 'inline-img-error';
        note.textContent = '[图片加载失败：网络或源问题]';
        if (img.parentNode) img.parentNode.replaceChild(note, img);
      };
    });
    contentEl.querySelectorAll('a').forEach(a => {
      a.target = '_blank'; a.rel = 'noopener';
      a.addEventListener('click', (e) => { const href = a.getAttribute('href'); if (href) { e.preventDefault(); openLink(href); } });
    });
  }

  async function loadFullArticle(item) {
    const contentEl = el('modal-content');
    const loader = document.createElement('div'); loader.className = 'inline-loader'; loader.textContent = '正在获取完整正文…';
    contentEl.appendChild(loader);

    async function doExtract(htmlText, note) {
      if (!htmlText || !htmlText.trim()) throw new Error(note || '返回内容为空');
      const full = FeedParser.extractArticle(htmlText, item.link, { clean: settings.smartClean !== false });
      const fullText = FeedParser.stripHtml(full || '').trim();
      if (fullText.length < 80) throw new Error('未能从页面解析出正文');
      const oldText = FeedParser.stripHtml(item.content || '').trim();
      const oldImages = (item.content || '').split('<img').length - 1;
      const newImages = (full || '').split('<img').length - 1;
      if (fullText.length > Math.max(80, oldText.length * 1.05) || newImages > oldImages || oldText.length < 200) {
        item.content = full;
        if (currentModalItem === item) renderModalContent(full, false);
      } else if (currentModalItem === item) {
        renderModalContent(item.content || item.summary, false);
      }
    }

    try {
      const res = await DataLayer.fetchText(item.link);
      const html = (res && res.body != null) ? res.body : res;
      await doExtract(html);
    } catch (e) {
      console.warn('[loadFullArticle] 直接抓取失败，尝试代理回退', item.link, e && e.message);
      try {
        const proxyRes = await DataLayer.fetchText('https://api.allorigins.win/raw?url=' + encodeURIComponent(item.link));
        const proxyHtml = (proxyRes && proxyRes.body != null) ? proxyRes.body : proxyRes;
        await doExtract(proxyHtml, '代理返回内容为空');
      } catch (pe) {
        if (currentModalItem === item) {
          const base = item.content || item.summary;
          const note = base ? '' : '该信源仅提供标题/摘要，无法获取完整正文，可点击「用浏览器打开原文」阅读。';
          renderModalContent(base, false, note);
        }
      }
    } finally {
      if (currentModalItem === item) { const old = contentEl.querySelector('.inline-loader'); if (old) old.remove(); }
    }
  }

  // ---------- 收藏 ----------
  async function toggleFavorite(item) {
    const k = favKey(item);
    if (state.favorites.has(k)) state.favorites.delete(k);
    else state.favorites.set(k, JSON.parse(JSON.stringify(item)));
    await Store.saveFavorites(Array.from(state.favorites.values()));
    const favBtn = el('modal-favorite');
    favBtn.textContent = isFav(item) ? '★ 已收藏' : '☆ 收藏';
    favBtn.classList.toggle('favorited', isFav(item));
    renderNews();
  }

  // ---------- 日历（含每日新闻量标签 + 水位波浪 + 清除筛选） ----------
  let calYear, calMonth;
  function renderCalendar() {
    const box = el('calendar');
    const now = new Date();
    if (calYear == null) { calYear = now.getFullYear(); calMonth = now.getMonth(); }
    const newsDays = new Set();
    const counts = {};
    for (const it of state.news) {
      const ds = dateStr(it.timestamp || Date.now());
      newsDays.add(ds);
      counts[ds] = (counts[ds] || 0) + 1;
    }
    // 当月每日计数与当月最大值（用于水位高度）
    const prefix = calYear + '-' + String(calMonth + 1).padStart(2, '0') + '-';
    let monthMax = 0;
    for (const ds in counts) { if (ds.indexOf(prefix) === 0) monthMax = Math.max(monthMax, counts[ds]); }

    const first = new Date(calYear, calMonth, 1);
    const startDow = first.getDay();
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    const todayStr2 = dateStr(now.getTime());

    let html = '<div class="cal-head"><button id="cal-prev">‹</button><span>' + calYear + ' 年 ' + (calMonth + 1) + ' 月</span><button id="cal-next">›</button>';
    if (state.calendarDate) html += '<button id="cal-clear" class="cal-clear">清除筛选</button>';
    html += '</div>';
    html += '<div class="cal-grid">';
    ['日', '一', '二', '三', '四', '五', '六'].forEach(d => { html += '<div class="cal-dow">' + d + '</div>'; });
    for (let i = 0; i < startDow; i++) html += '<div class="cal-day other"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = calYear + '-' + String(calMonth + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      const cls = ['cal-day'];
      const cnt = counts[ds] || 0;
      if (cnt > 0) cls.push('has-news');
      if (ds === todayStr2) cls.push('today');
      if (state.calendarDate === ds) cls.push('selected');
      let fill = '';
      if (cnt > 0 && monthMax > 0) {
        const pct = Math.round((cnt / monthMax) * 100);
        const tier = pct < 34 ? 'tier-low' : (pct < 67 ? 'tier-mid' : 'tier-high');
        const waveOn = settings.calendarWave !== false;
        fill = '<div class="cal-fill ' + tier + (waveOn ? ' wave-anim' : '') + '" style="height:' + pct + '%">' +
               (waveOn ? '<span class="cal-wave"></span>' : '') +
               '</div>';
      }
      html += '<div class="' + cls.join(' ') + '" data-date="' + ds + '">' + fill +
              '<span class="cal-inner"><span class="cal-num">' + d + '</span>' +
              (cnt > 0 ? '<span class="cal-count">' + cnt + '</span>' : '') + '</span></div>';
    }
    html += '</div>';
    box.innerHTML = html;
    el('cal-prev').onclick = () => { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar(); };
    el('cal-next').onclick = () => { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar(); };
    const clearBtn = el('cal-clear'); if (clearBtn) clearBtn.onclick = clearCalendarFilter;
    box.querySelectorAll('.cal-day[data-date]').forEach(day => {
      day.onclick = () => {
        const ds = day.dataset.date;
        state.calendarDate = ds;
        el('date-from').value = ds; el('date-to').value = ds;
        state.filters.dateFrom = ds; state.filters.dateTo = ds;
        renderCalendar(); renderNews();
      };
    });
  }

  function clearCalendarFilter() {
    state.calendarDate = null;
    el('date-from').value = ''; el('date-to').value = '';
    state.filters.dateFrom = ''; state.filters.dateTo = '';
    renderCalendar(); renderNews();
  }

  // 日期快捷范围：获取某一天 / 某一个时段的新闻
  function applyRangeChip(n) {
    const now = new Date();
    const today = dateStr(now.getTime());
    let from;
    if (n === 'today') from = today;
    else { const d = new Date(now.getTime() - (parseInt(n, 10) - 1) * 86400000); from = dateStr(d.getTime()); }
    el('date-from').value = from;
    el('date-to').value = today;
    state.filters.dateFrom = from;
    state.filters.dateTo = today;
    state.calendarDate = null; // 用范围筛选时清除单日日历筛选，避免冲突
    renderCalendar(); resetAndRenderNews();
  }
  function refreshCurrentRange() {
    // 触发一次新闻刷新，确保当前筛选时段内的新闻被抓取并展示
    refresh('news');
  }

  // ---------- 发布者筛选 chips ----------
  function renderSourceFilterChips() {
    const box = el('source-filter-chips');
    box.innerHTML = '';
    for (const s of SOURCES.NEWS_SOURCES) {
      const chip = document.createElement('button');
      chip.className = 'chip' + (state.filters.sources.has(s.id) ? ' selected' : '');
      chip.textContent = s.name;
      chip.addEventListener('click', () => {
        if (state.filters.sources.has(s.id)) state.filters.sources.delete(s.id);
        else state.filters.sources.add(s.id);
        chip.classList.toggle('selected');
        el('src-all').classList.remove('active');
        resetAndRenderNews();
      });
      box.appendChild(chip);
    }
  }

  // ---------- 热搜圆环进度（独立刷新管道的可视化） ----------
  const RING_CIRC = 2 * Math.PI * 52; // r=52 的圆周长
  function showHotRing() {
    const ring = el('hot-progress-ring');
    if (!ring) return;
    ring.classList.remove('hidden');
    updateHotRing(0, '准备中…');
  }
  function updateHotRing(pct, label) {
    const ring = el('hot-progress-ring');
    if (!ring) return;
    pct = Math.max(0, Math.min(100, pct || 0));
    const fg = ring.querySelector('.ring-fg');
    if (fg) fg.style.strokeDashoffset = String(RING_CIRC * (1 - pct / 100));
    const pctEl = el('hot-ring-pct');
    if (pctEl) pctEl.textContent = pct + '%';
    const lbl = ring.querySelector('.ring-label');
    if (lbl && label) lbl.textContent = label;
  }
  function hideHotRing() {
    const ring = el('hot-progress-ring');
    if (!ring) return;
    updateHotRing(100);
    setTimeout(() => ring.classList.add('hidden'), 500);
  }

  function buildEnabledHotIds() {
    const ids = new Set();
    for (const s of SOURCES.HOT_SOURCES) {
      const tab = HOT_TABS.find(t => t.ids.includes(s.id));
      if (!tab || (settings.hot && settings.hot[tab.key] !== false)) ids.add(s.id);
    }
    return ids;
  }

  // 新闻刷新：保持原有机制，按发布日期分窗口落盘 + 更新 7 天饱和状态
  async function runNews(enabled, bar, pText) {
    const result = await DataLayer.refreshAll(
      (done, total, label) => {
        const pct = total ? Math.round((done / total) * 100) : 0;
        bar.style.width = pct + '%'; pText.textContent = label + '  (' + done + '/' + total + ')';
      },
      (src, items) => {
        if (!items || !items.length) return;
        for (const it of items) pendingNewKeys.add(Store.dedupeKey(it));
        state.news = state.news.concat(items);
        const seen = new Set();
        state.news = state.news.filter(it => {
          const k = Store.dedupeKey(it);
          if (seen.has(k)) return false;
          seen.add(k); return true;
        });
        state.news.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        scheduleRender();
      },
      enabled, null, 'news'
    );
    const res = await Store.mergeAndPersist(result.news);
    await Store.recordWindowSaturation(res.added7); // 更新近 7 天饱和状态（决定是否自动扩展到 30 天）
    state.news = res.merged;
    renderNews({ animate: true }); renderCalendar(); renderVizIfVisible();
  }

  // 热搜刷新：独立管道，进度走圆环，互不阻塞新闻
  async function runHot(enabledHotIds) {
    const result = await DataLayer.refreshAll(
      (done, total, label) => {
        const pct = total ? Math.round((done / total) * 100) : 0;
        updateHotRing(pct, '榜单 ' + label);
      },
      null, null, enabledHotIds, 'hot'
    );
    state.hot = result.hot;
    renderHot();
  }

  // 并发刷新：新闻与热搜同时获取（热搜独立管道 + 圆环进度，互不等待）
  async function refresh(mode) {
    mode = mode || 'all';
    const btns = ['refresh-news-btn', 'refresh-hot-btn', 'refresh-all-btn'].map(el);
    const pWrap = el('progress-wrap'), bar = el('progress-bar'), pText = el('progress-text');
    if (btns.some(b => b && b.disabled)) return;
    btns.forEach(b => { if (b) b.disabled = true; });
    const showNews = mode !== 'hot';
    const showHot = mode !== 'news';
    if (showNews) {
      pWrap.classList.remove('hidden'); bar.style.width = '0%';
      pText.textContent = '正在获取新闻…';
    }
    if (showHot) showHotRing();
    try {
      const enabled = enabledSourceIds();
      pendingNewKeys.clear();
      const tasks = [];
      if (showNews) tasks.push(runNews(enabled, bar, pText));
      if (showHot) tasks.push(runHot(buildEnabledHotIds()));
      // 同时跑新闻与热搜，互不等待 → 不再因等榜单而卡住新闻
      await Promise.allSettled(tasks);
      el('last-updated').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
    } catch (e) {
      if (pText) pText.textContent = '刷新出错：' + (e && e.message || e);
    } finally {
      if (showNews) setTimeout(() => pWrap.classList.add('hidden'), 600);
      if (showHot) hideHotRing();
      btns.forEach(b => { if (b) b.disabled = false; });
    }
  }

  function setupAutoRefresh() {
    if (state.autoTimer) { clearInterval(state.autoTimer); state.autoTimer = null; }
    // 同步首页开关到 settings 与设置页控件
    settings.autoRefresh = el('auto-refresh').checked;
    const setCb = el('set-auto-refresh');
    if (setCb) setCb.checked = settings.autoRefresh;
    if (settings.autoRefresh) {
      state.autoTimer = setInterval(refresh, Math.max(1, settings.refreshIntervalMinutes) * 60 * 1000);
    }
  }

  // 从设置页保存后，把新的自动刷新状态同步回首页开关与定时器
  function syncAutoRefreshFromSettings() {
    const homeCb = el('auto-refresh');
    if (homeCb) homeCb.checked = settings.autoRefresh;
    setupAutoRefresh();
  }

  // ---------- 可视化 ----------
  let charts = {};
  function renderVizIfVisible() { if (state.page === 'viz') renderViz(); }
  function renderViz() {
    if (typeof Chart === 'undefined') return;
    const range = state.vizRange;
    let items = state.news;
    if (range !== 'all') {
      const cutoff = Date.now() - parseInt(range) * 24 * 3600 * 1000;
      items = items.filter(it => (it.timestamp || 0) >= cutoff);
    }
    const catCount = {}, regionCount = {}, sourceCount = {}, countryCount = {}, trend = {};
    for (const it of items) {
      (it.categories || []).forEach(c => { catCount[CATEGORY_NAMES[c] || c] = (catCount[CATEGORY_NAMES[c] || c] || 0) + 1; });
      regionCount[REGION_NAMES[it.region] || it.region || '未知'] = (regionCount[REGION_NAMES[it.region] || it.region || '未知'] || 0) + 1;
      sourceCount[it.source || '未知'] = (sourceCount[it.source || '未知'] || 0) + 1;
      const src = SOURCES.NEWS_SOURCES.find(s => s.id === it.sourceId);
      const country = (src && src.profile && src.profile.country) || '未知';
      countryCount[country] = (countryCount[country] || 0) + 1;
      const ds = dateStr(it.timestamp || Date.now());
      trend[ds] = (trend[ds] || 0) + 1;
    }
    const palette = ['#0a84ff', '#30d158', '#ff9f0a', '#ff453a', '#bf5af2', '#64d2ff', '#ffd60a'];
    function draw(id, type, labels, data, label) {
      const cv = el(id); if (!cv) return;
      if (charts[id]) charts[id].destroy();
      charts[id] = new Chart(cv.getContext('2d'), {
        type,
        data: { labels, datasets: [{ label, data, backgroundColor: palette, borderColor: palette, borderWidth: 1 }] },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: type !== 'bar', labels: { color: '#a1a1a6' } } },
          scales: type === 'line' ? {
            x: { ticks: { color: '#a1a1a6', maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.06)' } },
            y: { ticks: { color: '#a1a1a6' }, grid: { color: 'rgba(255,255,255,0.06)' }, beginAtZero: true }
          } : {
            x: { ticks: { color: '#a1a1a6' }, grid: { color: 'rgba(255,255,255,0.06)' } },
            y: { ticks: { color: '#a1a1a6' }, grid: { color: 'rgba(255,255,255,0.06)' }, beginAtZero: true }
          }
        }
      });
    }
    draw('chart-category', 'doughnut', Object.keys(catCount), Object.values(catCount), '领域');
    draw('chart-region', 'doughnut', Object.keys(regionCount), Object.values(regionCount), '地区');
    const topSources = Object.entries(sourceCount).sort((a, b) => b[1] - a[1]).slice(0, 10);
    draw('chart-source', 'bar', topSources.map(x => x[0]), topSources.map(x => x[1]), '发布者');
    draw('chart-country', 'doughnut', Object.keys(countryCount), Object.values(countryCount), '国家');
    const trendKeys = Object.keys(trend).sort();
    draw('chart-trend', 'line', trendKeys, trendKeys.map(k => trend[k]), '每日数量');
  }

  // ---------- 设置 ----------
  function renderSettings() {
    el('set-auto-refresh').checked = !!settings.autoRefresh;
    el('set-auto-start').checked = !!settings.autoRefreshOnStart;
    el('set-refresh-interval').value = settings.refreshIntervalMinutes;
    el('set-image-caching').value = settings.imageCaching || 'all';
    el('set-animations').checked = settings.animations !== false;
    el('set-calendar-wave').checked = settings.calendarWave !== false;
    el('set-smart-clean').checked = settings.smartClean !== false;
    el('set-background-refresh').checked = settings.backgroundRefresh !== false;
    el('set-fetch-mode').value = settings.fetchMode || 'balanced';
    el('set-fetch-month').checked = !!settings.fetchMonth;
    el('set-hot-maxitems').value = settings.hot && settings.hot.maxItems != null ? settings.hot.maxItems : 30;
    el('settings-hot').querySelectorAll('input[type="checkbox"]').forEach(cb => {
      const key = cb.dataset.hot;
      cb.checked = settings.hot && settings.hot[key] !== false;
    });
    el('set-geo-provider').value = settings.geo.provider || 'tencent';
    el('set-geo-key').value = settings.geo.apiKey || '';
    el('set-geo-style').value = settings.geo.mapStyleId || '';
    el('set-datadir').value = settings.dataDir || '';
    const lt = el('update-line-toggle');
    if (lt) lt.classList.toggle('is-secondary', settings.updateLine === 'gitee');
    if (window.electronAPI && window.electronAPI.appPaths) {
      window.electronAPI.appPaths().then(p => { el('set-current-datadir').textContent = p.dataDir; });
    }
    // 显示当前版本号
    const verEl = el('set-current-version');
    if (verEl && window.electronAPI && window.electronAPI.currentVersion) {
      window.electronAPI.currentVersion().then(v => verEl.textContent = v || '—');
    }

    // 信源管理列表（新 UI：logo + 名称 + 标签 + 开关）
    renderSourceSettings();
    refreshCacheStats();
  }

  // 生成单个信源设置行（logo + 名称 + 标签 + iOS 风格开关）
  function buildSourceSettingRow(s) {
    const enabled = settings.sources[s.id] !== false;
    const row = document.createElement('div');
    row.className = 'set-src-row';
    row.dataset.id = s.id;

    // logo（优先信源 logo，加载失败回退首字占位）
    const logo = document.createElement('div');
    logo.className = 'set-src-logo';
    const logoUrl = s.profile && s.profile.logo;
    if (logoUrl) {
      const img = document.createElement('img');
      img.src = logoUrl; img.alt = s.name; img.loading = 'lazy';
      img.onerror = () => {
        img.remove();
        const ph = document.createElement('span');
        ph.className = 'logo-ph';
        ph.textContent = (s.name || '?').trim().charAt(0);
        logo.appendChild(ph);
      };
      logo.appendChild(img);
    } else {
      const ph = document.createElement('span');
      ph.className = 'logo-ph';
      ph.textContent = (s.name || '?').trim().charAt(0);
      logo.appendChild(ph);
    }
    row.appendChild(logo);

    // 名称 + 标签
    const info = document.createElement('div');
    info.className = 'set-src-info';
    const nm = document.createElement('div');
    nm.className = 'set-src-name';
    nm.textContent = s.name;
    nm.title = s.name;
    info.appendChild(nm);

    const tags = document.createElement('div');
    tags.className = 'set-src-tags';
    const grade = document.createElement('span');
    grade.className = 'badge ' + (s.grade || 'P2');
    grade.textContent = s.grade || 'P2';
    tags.appendChild(grade);
    if (SOURCES.REGION_NAMES[s.region]) {
      const r = document.createElement('span');
      r.className = 'set-src-tag';
      r.textContent = SOURCES.REGION_NAMES[s.region];
      tags.appendChild(r);
    }
    if (Array.isArray(s.categories)) {
      for (const c of s.categories.slice(0, 3)) {
        if (SOURCES.CATEGORY_NAMES[c]) {
          const ct = document.createElement('span');
          ct.className = 'set-src-tag';
          ct.textContent = SOURCES.CATEGORY_NAMES[c];
          tags.appendChild(ct);
        }
      }
    }
    if (s.profile && s.profile.politicalLean && SOURCES.POLITICAL_LEAN_NAMES[s.profile.politicalLean]) {
      const l = document.createElement('span');
      l.className = 'set-src-tag';
      l.textContent = SOURCES.POLITICAL_LEAN_NAMES[s.profile.politicalLean];
      tags.appendChild(l);
    }
    info.appendChild(tags);
    row.appendChild(info);

    // iOS 风格开关（保留 data-id 以便 collectSettings / 事件委托读取）
    const toggle = document.createElement('label');
    toggle.className = 'set-src-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = enabled;
    cb.dataset.id = s.id;
    const track = document.createElement('span');
    track.className = 'toggle-track';
    toggle.appendChild(cb);
    toggle.appendChild(track);
    row.appendChild(toggle);

    return row;
  }

  function renderSourceSettings() {
    const box = el('settings-sources');
    if (!box) return;
    box.innerHTML = '';
    for (const s of SOURCES.NEWS_SOURCES) {
      box.appendChild(buildSourceSettingRow(s));
    }
    const search = el('set-sources-search');
    if (search) { search.value = state.sourceSettingsSearch || ''; applySourceSettingsSearch(); }
    updateSourceSettingsCount();
  }

  function applySourceSettingsSearch() {
    const q = (state.sourceSettingsSearch || '').trim().toLowerCase();
    const box = el('settings-sources');
    if (!box) return;
    box.querySelectorAll('.set-src-row').forEach(row => {
      const name = (row.querySelector('.set-src-name')?.textContent || '').toLowerCase();
      const tagsText = (row.querySelector('.set-src-tags')?.textContent || '').toLowerCase();
      const hit = !q || name.includes(q) || tagsText.includes(q);
      row.classList.toggle('hidden-by-search', !hit);
    });
    updateSourceSettingsCount();
  }

  function updateSourceSettingsCount() {
    const box = el('settings-sources');
    if (!box) return;
    const rows = box.querySelectorAll('.set-src-row');
    let visible = 0, enabled = 0;
    rows.forEach(row => {
      if (row.classList.contains('hidden-by-search')) return;
      visible++;
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb && cb.checked) enabled++;
    });
    const badge = el('settings-sources-count');
    if (badge) badge.textContent = `启用 ${enabled} / 共 ${rows.length}`;
  }

  // 读取设置页所有控件 → settings（不落盘）
  function collectSettings() {
    settings.autoRefresh = el('set-auto-refresh').checked;
    settings.autoRefreshOnStart = el('set-auto-start').checked;
    settings.refreshIntervalMinutes = parseInt(el('set-refresh-interval').value) || 15;
    settings.imageCaching = el('set-image-caching').value;
    settings.animations = el('set-animations').checked;
    settings.calendarWave = el('set-calendar-wave').checked;
    settings.smartClean = el('set-smart-clean').checked;
    settings.backgroundRefresh = el('set-background-refresh').checked;
    settings.fetchMode = el('set-fetch-mode').value;
    settings.fetchMonth = el('set-fetch-month').checked;
    settings.hot = settings.hot || {};
    settings.hot.maxItems = parseInt(el('set-hot-maxitems').value) || 30;
    el('settings-hot').querySelectorAll('input[type="checkbox"]').forEach(cb => {
      settings.hot[cb.dataset.hot] = cb.checked;
    });
    settings.geo.provider = el('set-geo-provider').value;
    settings.geo.apiKey = el('set-geo-key').value.trim();
    settings.geo.mapStyleId = el('set-geo-style').value.trim();
    settings.dataDir = el('set-datadir').value.trim();
    settings.updateLine = (el('update-line-toggle') && el('update-line-toggle').classList.contains('is-secondary')) ? 'gitee' : 'github';
    settings.sources = {};
    el('settings-sources').querySelectorAll('input[type="checkbox"]').forEach(cb => {
      settings.sources[cb.dataset.id] = cb.checked;
    });
  }

  // 轻量提示（自动保存反馈）
  let toastTimer = null;
  function showToast(msg) {
    const t = el('toast');
    if (!t) return;
    t.textContent = '✓ ' + msg;
    t.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  // 每次改动即时落盘 + 必要副作用 + 提示
  async function persistSettings(note) {
    collectSettings();
    await Store.saveSettings(settings);
    Store.setSettings(settings); // 同步窗口配置给数据层
    if (window.electronAPI && window.electronAPI.setBackgroundRefresh) {
      window.electronAPI.setBackgroundRefresh(settings.backgroundRefresh !== false);
    }
    syncAutoRefreshFromSettings();
    if (window.DataLayer && DataLayer.MODES) {
      DataLayer.configure(DataLayer.MODES[settings.fetchMode] || DataLayer.MODES.balanced);
    }
    showToast(note || '已保存');
  }

  // ---------- 绑定 ----------
  function bindUI() {
    el('top-nav').addEventListener('click', (e) => { if (e.target.dataset.page) switchPage(e.target.dataset.page); });

    el('region-tabs').addEventListener('click', (e) => { if (!e.target.dataset.region) return; setActive('region-tabs', e.target); state.filters.region = e.target.dataset.region; resetAndRenderNews(); });
    el('category-tabs').addEventListener('click', (e) => { if (!e.target.dataset.category) return; setActive('category-tabs', e.target); state.filters.category = e.target.dataset.category; resetAndRenderNews(); });
    el('grade-tabs').addEventListener('click', (e) => { if (!e.target.dataset.grade) return; setActive('grade-tabs', e.target); state.filters.grade = e.target.dataset.grade; resetAndRenderNews(); });
    el('search-input').addEventListener('input', (e) => { state.filters.search = e.target.value; resetAndRenderNews(); });
    el('date-from').addEventListener('change', (e) => { state.filters.dateFrom = e.target.value; state.calendarDate = null; renderCalendar(); resetAndRenderNews(); });
    el('date-to').addEventListener('change', (e) => { state.filters.dateTo = e.target.value; state.calendarDate = null; renderCalendar(); resetAndRenderNews(); });
    el('time-clear').addEventListener('click', () => {
      el('date-from').value = ''; el('date-to').value = ''; state.filters.dateFrom = ''; state.filters.dateTo = ''; state.calendarDate = null;
      renderCalendar(); resetAndRenderNews();
    });
    // 日期快捷范围（获取某一天 / 某时段）
    const rangeQuick = el('range-quick');
    if (rangeQuick) rangeQuick.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-range]');
      if (chip) applyRangeChip(chip.dataset.range);
    });
    const refreshRangeBtn = el('refresh-range-btn');
    if (refreshRangeBtn) refreshRangeBtn.addEventListener('click', refreshCurrentRange);
    el('src-all').addEventListener('click', () => {
      state.filters.sources.clear(); setActive('src-all', el('src-all'));
      el('source-filter-chips').querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
      resetAndRenderNews();
    });
    el('src-toggle').addEventListener('click', () => { el('source-filter-chips').classList.toggle('hidden'); });

    el('src-region-tabs').addEventListener('click', (e) => { if (!e.target.dataset.region) return; setActive('src-region-tabs', e.target); state.srcFilters.region = e.target.dataset.region; renderSources(); });
    el('src-grade-tabs').addEventListener('click', (e) => { if (!e.target.dataset.grade) return; setActive('src-grade-tabs', e.target); state.srcFilters.grade = e.target.dataset.grade; renderSources(); });
    el('src-lean-tabs').addEventListener('click', (e) => { if (!e.target.dataset.lean) return; setActive('src-lean-tabs', e.target); state.srcFilters.lean = e.target.dataset.lean; renderSources(); });
    el('src-search-input').addEventListener('input', (e) => { state.srcFilters.search = e.target.value; renderSources(); });

    el('auto-refresh').addEventListener('change', setupAutoRefresh);
    el('refresh-news-btn').addEventListener('click', () => refresh('news'));
    el('refresh-hot-btn').addEventListener('click', () => refresh('hot'));
    el('refresh-all-btn').addEventListener('click', () => refresh('all'));

    // 弹窗
    el('modal-close').addEventListener('click', closeArticleModal);
    el('modal-close-btn').addEventListener('click', closeArticleModal);
    el('modal-backdrop').addEventListener('click', closeArticleModal);
    el('modal-body').addEventListener('scroll', () => {
      const body = el('modal-body');
      const h = el('modal-hero');
      const top = body.scrollTop;
      if (!heroScrolled && top > 120) {
        heroScrolled = true;
        h.classList.add('scrolled');
        // 英雄区折叠会改变上方高度、把 scrollTop 拖回阈值以下造成反复抽搐；
        // 补偿 scrollTop 锁定视口内容，彻底消除抖动
        body.scrollTop = top + (320 - 68);
      } else if (heroScrolled && top < 8) {
        heroScrolled = false;
        h.classList.remove('scrolled');
      }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeArticleModal(); closeHotModal(); } });

    // 热搜弹窗
    el('hot-close').addEventListener('click', closeHotModal);
    el('hot-close-btn').addEventListener('click', closeHotModal);
    el('hot-backdrop').addEventListener('click', closeHotModal);

    // 更新状态提示弹窗
    el('update-status-ok').addEventListener('click', hideUpdateStatusModal);
    el('update-status-backdrop').addEventListener('click', hideUpdateStatusModal);

    // 添加自定义信源
    el('add-source-btn').addEventListener('click', openAddSourceModal);
    el('add-source-close').addEventListener('click', closeAddSourceModal);
    el('add-source-backdrop').addEventListener('click', closeAddSourceModal);
    el('as-cancel').addEventListener('click', closeAddSourceModal);
    el('as-save').addEventListener('click', saveUserSource);

    // 信源管理（发布者页）
    el('delete-source-btn').addEventListener('click', openSourceManageModal);
    el('source-manage-close').addEventListener('click', closeSourceManageModal);
    el('source-manage-backdrop').addEventListener('click', closeSourceManageModal);
    el('sm-select-all').addEventListener('change', (e) => {
      const selected = state.smSelected || (state.smSelected = new Set());
      SOURCES.NEWS_SOURCES.forEach(s => { if (e.target.checked) selected.add(s.id); else selected.delete(s.id); });
      renderSourceManageList();
    });
    el('sm-enable').addEventListener('click', () => smBatchEnable(true));
    el('sm-disable').addEventListener('click', () => smBatchEnable(false));
    el('sm-delete').addEventListener('click', smBatchDelete);
    el('sm-confirm-cancel').addEventListener('click', hideSmConfirm);
    el('sm-confirm-ok').addEventListener('click', doSmDelete);

    // 可视化范围
    el('viz-range').addEventListener('click', (e) => { if (!e.target.dataset.range) return; setActive('viz-range', e.target); state.vizRange = e.target.dataset.range; renderViz(); });

    // 设置：每次改动即时保存（去掉独立保存按钮）
    const bindAutoSave = (sel, note) => {
      const node = (typeof sel === 'string') ? el(sel) : sel;
      if (node) node.addEventListener('change', () => persistSettings(note));
    };
    bindAutoSave('set-auto-refresh', '自动刷新已保存');
    bindAutoSave('set-auto-start', '启动刷新已保存');
    bindAutoSave('set-refresh-interval', '刷新间隔已保存');
    bindAutoSave('set-image-caching', '图片缓存策略已保存');
    bindAutoSave('set-animations', '动画设置已保存');
    el('set-calendar-wave').addEventListener('change', () => {
      settings.calendarWave = el('set-calendar-wave').checked;
      renderCalendar();
      persistSettings('日历水波效果已保存');
    });
    bindAutoSave('set-smart-clean', '正文清理已保存');
    bindAutoSave('set-background-refresh', '后台刷新已保存');
    bindAutoSave('set-fetch-mode', '获取模式已保存');
    bindAutoSave('set-fetch-month', '月窗口已保存');
    bindAutoSave('set-hot-maxitems', '热搜条数已保存');
    bindAutoSave('set-geo-provider', '地图服务商已保存');
    bindAutoSave('set-geo-key', '地图 Key 已保存');
    bindAutoSave('set-geo-style', '地图样式已保存');
    bindAutoSave('set-datadir', '数据目录已保存');
    // 更新线路：首选(GitHub) / 备用(Gitee) 分段开关
    const lineToggle = el('update-line-toggle');
    if (lineToggle) {
      const toggleLine = () => {
        const secondary = !lineToggle.classList.contains('is-secondary');
        lineToggle.classList.toggle('is-secondary', secondary);
        lineToggle.setAttribute('aria-checked', String(!secondary));
        persistSettings(secondary ? '已切换至备用线路（Gitee）' : '已切换至首选线路（GitHub）');
      };
      lineToggle.addEventListener('click', toggleLine);
      lineToggle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleLine(); }
      });
    }
    // 立即检查更新按钮
    const checkUpdateBtn = el('check-update-btn');
    if (checkUpdateBtn) {
      checkUpdateBtn.addEventListener('click', () => {
        if (window.electronAPI && window.electronAPI.checkForUpdates) {
          checkUpdateBtn.disabled = true;
          setUpdateStatus('');
          hideUpdateBar();
          window.electronAPI.checkForUpdates().finally(() => {
            checkUpdateBtn.disabled = false;
          });
        }
      });
    }
    // 热搜开关（事件委托）
    el('settings-hot').addEventListener('change', (e) => {
      if (e.target.matches('input[type="checkbox"]')) persistSettings('热搜设置已保存');
    });
    // 信源开关（事件委托）
    el('settings-sources').addEventListener('change', (e) => {
      if (e.target.matches('input[type="checkbox"]')) {
        updateSourceSettingsCount();
        persistSettings('信源设置已保存');
      }
    });
    // 信源管理：搜索过滤 + 批量启用/禁用
    const srcSearch = el('set-sources-search');
    if (srcSearch) srcSearch.addEventListener('input', (e) => {
      state.sourceSettingsSearch = e.target.value;
      applySourceSettingsSearch();
    });
    el('set-sources-enable').addEventListener('click', () => {
      el('settings-sources').querySelectorAll('.set-src-row input[type="checkbox"]').forEach(cb => { cb.checked = true; });
      updateSourceSettingsCount();
      persistSettings('已批量启用信源');
    });
    el('set-sources-disable').addEventListener('click', () => {
      el('settings-sources').querySelectorAll('.set-src-row input[type="checkbox"]').forEach(cb => { cb.checked = false; });
      updateSourceSettingsCount();
      persistSettings('已批量禁用信源');
    });
    // 缓存统计与清理
    el('clear-images').addEventListener('click', async () => {
      await window.electronAPI.storage.clearImageCache();
      el('cache-clear-result').textContent = '已清理图片缓存 ✓';
      await refreshCacheStats();
    });
    el('clear-news').addEventListener('click', async () => {
      await window.electronAPI.storage.clearAllCaches();
      el('cache-clear-result').textContent = '已清理全部缓存（含图片）✓';
      state.news = await Store.loadCachedNews(); resetAndRenderNews(); renderCalendar();
      await refreshCacheStats();
    });
    el('refresh-stats').addEventListener('click', refreshCacheStats);
    el('clear-by-date').addEventListener('click', async () => {
      const d = el('clear-date').value; if (!d) { el('clear-result').textContent = '请选择日期'; return; }
      await Store.clearCacheDate(d);
      el('clear-result').textContent = '已清理 ' + d + ' 的缓存 ✓';
      state.news = await Store.loadCachedNews(); resetAndRenderNews(); renderCalendar();
    });
    el('clear-all').addEventListener('click', async () => {
      await Store.clearAllCache();
      el('clear-result').textContent = '已清空全部缓存 ✓';
      state.news = [];
    });
  }

  function setActive(groupId, target) {
    document.querySelectorAll('#' + groupId + ' .chip').forEach(c => c.classList.remove('active'));
    target.classList.add('active');
  }

  function openLink(url) {
    if (!url) return;
    if (window.electronAPI && window.electronAPI.openExternal) window.electronAPI.openExternal(url);
    else window.open(url, '_blank', 'noopener');
  }

  // 更新提示条
  let pendingUpdateInfo = null;
  function showUpdateBanner(info) {
    const banner = el('update-banner');
    const text = el('update-text');
    const dl = el('update-download');
    const prog = el('update-progress');
    const instBtn = el('update-installer');
    const dismiss = el('update-dismiss');
    if (!banner || !text || !dl) return;
    pendingUpdateInfo = info;
    text.textContent = `发现新版本 v${info.latestVersion}（当前 v${info.currentVersion}）${info.releaseNotes ? ' · ' + info.releaseNotes : ''}`;
    banner.classList.remove('hidden');
    if (prog) { prog.classList.add('hidden'); prog.textContent = ''; }

    // 大版本（Electron 运行时变化）→ 只能走完整安装包
    if (info.electronMismatch) {
      dl.classList.add('hidden');
      instBtn.classList.remove('hidden');
      instBtn.onclick = () => {
        const url = info.installer && (info.installer.mirror || info.installer.url);
        if (window.electronAPI && window.electronAPI.openUpdateDownload && url) {
          window.electronAPI.openUpdateDownload(url);
        } else if (url) {
          openLink(url);
        }
        banner.classList.add('hidden');
      };
    } else {
      dl.classList.remove('hidden');
      instBtn.classList.add('hidden');
      dl.disabled = false;
      dl.textContent = '更新并重启';
      dl.onclick = () => startInAppUpdate(info);
    }

    dismiss.onclick = () => {
      banner.classList.add('hidden');
      if (window.electronAPI && window.electronAPI.dismissUpdate) {
        window.electronAPI.dismissUpdate(info.latestVersion);
      }
    };
  }

  async function startInAppUpdate(info) {
    const dl = el('update-download');
    const prog = el('update-progress');
    if (!window.electronAPI || !window.electronAPI.downloadUpdate) {
      const url = info.installer && (info.installer.mirror || info.installer.url);
      if (url) openLink(url);
      return;
    }
    dl.disabled = true;
    dl.textContent = '准备中…';
    if (prog) { prog.classList.remove('hidden'); prog.textContent = '开始下载…'; }
    // 进度由 init() 中全局 onUpdateProgress 统一处理，此处不再重复注册

    let res = null;
    try { res = await window.electronAPI.downloadUpdate(info); }
    catch (e) { res = { ok: false, reason: e.message }; }

    if (res && res.restart) {
      dl.textContent = '即将重启…';
      if (prog) prog.textContent = '更新完成，正在重启';
      return; // 主进程会自行 relaunch
    }
    if (res && res.needsInstaller) {
      dl.disabled = false;
      dl.textContent = '更新并重启';
      if (prog) prog.classList.add('hidden');
      const url = info.installer && (info.installer.mirror || info.installer.url);
      if (url) openLink(url);
      bannerHint('需下载完整安装包（大版本更新），已打开下载页');
      return;
    }
    dl.disabled = false;
    dl.textContent = '重试';
    if (prog) prog.textContent = '更新失败：' + ((res && res.reason) || '未知错误');
  }

  function bannerHint(msg) {
    const prog = el('update-progress');
    if (prog) { prog.classList.remove('hidden'); prog.textContent = msg; }
  }

  // ---------- 启动 ----------
  async function init() {
    settings = await Store.loadSettings();
    Store.setSettings(settings); // 同步窗口配置给数据层
    // 应用新闻获取模式（并发数 + 条件请求）到数据层
    if (window.DataLayer && DataLayer.MODES) {
      DataLayer.configure(DataLayer.MODES[settings.fetchMode] || DataLayer.MODES.balanced);
    }
    const favs = await Store.loadFavorites();
    // 同步后台刷新开关到主进程（关闭窗口是否保留进程），并监听托盘"刷新"指令
    if (window.electronAPI && window.electronAPI.setBackgroundRefresh) {
      window.electronAPI.setBackgroundRefresh(settings.backgroundRefresh !== false);
    }
    if (window.electronAPI && window.electronAPI.onTrayRefresh) {
      window.electronAPI.onTrayRefresh(() => refresh('all'));
    }
    // 监听主进程推送的更新通知
    if (window.electronAPI && window.electronAPI.onUpdateAvailable) {
      window.electronAPI.onUpdateAvailable(info => showUpdateBanner(info));
    }
    if (window.electronAPI && window.electronAPI.onUpdateStatusMessage) {
      window.electronAPI.onUpdateStatusMessage(data => {
        // 非静默消息才弹窗；过程中的状态只更新设置页标签
        if (!data.silent) showUpdateStatusModal(data);
        // 同步更新设置页状态标签
        if (data.type === 'checking') setUpdateStatus(data.title || '正在检查…', 'checking');
        else if (data.type === 'checking-source') setUpdateStatus('连接失败，正在替换备用源', 'switching');
        else if (data.type === 'connected') { setUpdateStatus('连接成功，正在获取更新', 'connected'); showUpdateBar(); }
        else if (data.type === 'success') { setUpdateStatus('下载完成，正在安装…', 'success'); markUpdateBarDone(); }
        else if (data.type === 'warning') setUpdateStatus(data.title || '无法连接，请检查网络', 'fail');
        else if (data.type === 'info') setUpdateStatus(data.title || '已是最新版本', '');
      });
    }
    if (window.electronAPI && window.electronAPI.onUpdateProgress) {
      window.electronAPI.onUpdateProgress((pct) => {
        // 统一更新设置页条形进度条与顶部 banner 文本
        setUpdateBar(pct);
        const prog = el('update-progress');
        if (prog) prog.textContent = '下载中 ' + pct + '%';
      });
    }
    favs.forEach(it => state.favorites.set(favKey(it), it));
    userSources = await Store.loadUserSources();
    userSourceIds = new Set(userSources.map(s => s.id));
    if (userSources.length) SOURCES.NEWS_SOURCES = SOURCES.NEWS_SOURCES.concat(userSources);
    const cached = await Store.loadCachedNews();
    if (cached.length) { state.news = cached; }
    el('auto-refresh').checked = !!settings.autoRefresh;

    bindUI();
    renderSourceFilterChips();
    renderHotTabs();
    renderHot();
    renderNews();
    renderSources();
    renderCalendar();
    setupAutoRefresh();

    if (settings.autoRefreshOnStart) refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
