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
    filters: { region: 'all', category: 'all', grade: 'all', search: '', dateFrom: '', dateTo: '', sources: new Set(), tag: '' },
    srcFilters: { region: 'all', grade: 'all', lean: 'all', search: '' },
    hotTab: 'weibo',
    favorites: new Map(),   // favKey -> item
    readKeys: new Map(),    // dedupeKey -> 已读时间戳
    sessionRead: new Set(), // 本次运行期间点击浏览过的新闻（仅用于临时降透明，不持久化）
    tags: new Map(),        // dedupeKey -> [标签]
    sourceHealth: {},       // sourceId -> { ok, error, consecutiveFails, lastTry, lastOk }
    settings: null,
    calendarDate: null,
    vizRange: 'all',
    page: 'news',
    favTab: 'news',         // 收藏页子页：news（新闻收藏）/ watch（重点关注发布者）
    renderLimit: 60
  };

  let settings = Store.defaultSettings();
  let userSources = [];  // 用户自定义信源（来自 data/user_sources.json）
  let userSourceIds = new Set();  // 用户自定义信源 id 集合（用于判断可否删除）
  let pendingNewKeys = new Set();  // 本次渲染需要"入场动画"的新闻 dedupeKey 集合（每次渲染后清空）
  let clusterExpanded = new Set(); // 同题聚类中已展开的组 id（会话内，不持久化）

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
    const apply = (u) => {
      img.onload = () => done(true);
      img.onerror = () => done(false);
      img.src = u;
    };
    // 缓存优先单路：命中则直接 file:// 秒开，未命中由主进程下载一次后 file:// 显示；
    // 消除「远程直连 + 主进程下载」双下载，避免带宽翻倍与 src 替换导致的二次解码闪烁。
    const resolveSrc = (u) => {
      if (settings.imageCaching !== 'off') {
        return Store.cacheImage(u, { favorite: false }).then(res => (res || u)).catch(() => u);
      }
      return Promise.resolve(u);
    };
    timer = setTimeout(() => done(false), 14000);
    wrap.appendChild(img);
    resolveSrc(url).then(src => { if (img.isConnected) apply(src); });
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
  function isRead(it) { return state.readKeys.has(favKey(it)); }
  function isWatchedSource(it) { return (settings.watchedSources || []).indexOf(it.sourceId) >= 0; }
  function markRead(it) {
    if (!it) return;
    const dk = Store.dedupeKey(it);
    // 本轮降透明：无论历史上是否已读，本次点击都记录（仅内存，重启清空）
    state.sessionRead.add(dk);
    const k = favKey(it);
    if (!state.readKeys.has(k)) {
      state.readKeys.set(k, Date.now());
      Store.saveReadState(state.readKeys);
    }
    const card = document.querySelector('.card[data-key="' + CSS.escape(dk) + '"]');
    if (card) card.classList.add('read');
  }

  // ---------- 标签 ----------
  function getItemTags(it) { return state.tags.get(Store.dedupeKey(it)) || []; }
  function addTag(it, tag) {
    tag = (tag || '').trim();
    if (!it || !tag) return;
    const k = Store.dedupeKey(it);
    const tags = state.tags.get(k) || [];
    if (tags.includes(tag)) return;
    tags.push(tag);
    state.tags.set(k, tags);
    Store.saveTags(state.tags);
    renderTagChips();
  }
  function removeTag(it, tag) {
    if (!it) return;
    const k = Store.dedupeKey(it);
    const tags = (state.tags.get(k) || []).filter(t => t !== tag);
    if (tags.length) state.tags.set(k, tags); else state.tags.delete(k);
    Store.saveTags(state.tags);
    renderTagChips();
  }
  function allTags() {
    const set = new Set();
    for (const tags of state.tags.values()) for (const t of tags) set.add(t);
    return Array.from(set).sort();
  }

  // ---------- 自动规则 ----------
  const RULE_FIELDS = { title: '标题', source: '来源', category: '分类', region: '地区', summary: '摘要', all: '全部' };
  const RULE_ACTIONS = { read: '已读', favorite: '收藏', hide: '隐藏' };
  function ruleFieldText(it, field) {
    switch (field) {
      case 'title': return it.title || '';
      case 'source': return it.source || '';
      case 'category': return (it.categories || []).map(c => CATEGORY_NAMES[c] || c).join(' ');
      case 'region': return (REGION_NAMES[it.region] || it.region || '');
      case 'summary': return FeedParser.stripHtml(it.summary || '').trim();
      case 'all': return [it.title, it.source, (it.categories || []).join(' '), it.region, it.summary].join(' ');
      default: return it.title || '';
    }
  }
  function matchRule(it, rule) {
    if (!rule || rule.enabled === false || !rule.pattern) return false;
    try { return new RegExp(rule.pattern, 'i').test(ruleFieldText(it, rule.field || 'title')); }
    catch (_) { return false; }
  }
  function activeRules() { return (settings.rules || []).filter(r => r && r.enabled !== false); }
  function isHiddenByRule(it) { return activeRules().some(r => r.action === 'hide' && matchRule(it, r)); }
  function isHiddenEffective(it) { return isHiddenByRule(it) && !isFav(it) && getItemTags(it).length === 0; }
  function applyRulesToItems(items) {
    if (!items || !items.length) return;
    const rules = activeRules().filter(r => r.action !== 'hide');
    if (!rules.length) return;
    let readChanged = false, favChanged = false;
    for (const it of items) {
      for (const r of rules) {
        if (!matchRule(it, r)) continue;
        const k = favKey(it);
        if (r.action === 'read') { if (!state.readKeys.has(k)) { state.readKeys.set(k, Date.now()); readChanged = true; } }
        else if (r.action === 'favorite') { if (!state.favorites.has(k)) { state.favorites.set(k, JSON.parse(JSON.stringify(it))); favChanged = true; } }
      }
    }
    if (readChanged) Store.saveReadState(state.readKeys);
    if (favChanged) Store.saveFavorites(Array.from(state.favorites.values()));
  }
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
    if (page === 'favorites') renderFavorites();
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

  const SANITIZE_ALLOW_TAGS = new Set([
    'p','div','span','br','hr','h1','h2','h3','h4','h5','h6',
    'ul','ol','li','blockquote','pre','code','em','strong','b','i','u','s','del','sub','sup',
    'a','img','table','thead','tbody','tr','td','th','caption','figure','figcaption','picture','source'
  ]);
  const SANITIZE_ALLOW_ATTRS = new Set(['href','src','alt','title']);
  function cleanSanitizedTree(root) {
    const walk = (node) => {
      const children = Array.from(node.childNodes || []);
      for (const child of children) {
        if (child.nodeType === 1) {
          const tag = child.tagName.toLowerCase();
          if (!SANITIZE_ALLOW_TAGS.has(tag)) { child.remove(); continue; }
          for (const a of Array.from(child.attributes || [])) {
            const name = a.name.toLowerCase();
            if (name.startsWith('on') || !SANITIZE_ALLOW_ATTRS.has(name)) {
              child.removeAttribute(a.name);
            } else if (/^\s*(javascript|vbscript|data\s*:|file\s*:)/i.test(a.value || '')) {
              child.removeAttribute(a.name);
            }
          }
          if (tag === 'a') {
            const href = child.getAttribute('href') || '';
            if (href && !/^(https?:|mailto:|#|\/\/)/i.test(href.trim())) child.removeAttribute('href');
          }
          if (tag === 'img') {
            const src = child.getAttribute('src') || '';
            if (src && !/^(https?:|file:|data:image\/)/i.test(src.trim())) child.removeAttribute('src');
          }
          walk(child);
        } else if (child.nodeType === 8) {
          child.remove(); // 注释节点
        }
      }
    };
    walk(root);
  }

  function sanitizeHtml(html) {
    if (!html) return '';
    let out = String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
      .replace(/<object[\s\S]*?<\/object>/gi, '')
      .replace(/<embed[\s\S]*?>/gi, '')
      .replace(/<link[\s\S]*?>/gi, '')
      .replace(/<meta[\s\S]*?>/gi, '');
    if (typeof DOMParser !== 'undefined') {
      try {
        const doc = new DOMParser().parseFromString('<div id="__san__">' + out + '</div>', 'text/html');
        cleanSanitizedTree(doc.body);
        const wrap = doc.getElementById('__san__');
        out = wrap ? wrap.innerHTML : doc.body.innerHTML;
      } catch (_) { /* 解析失败则退回正则兜底 */ }
    }
    return out
      .replace(/javascript:/gi, 'disabled-js:')
      .replace(/vbscript:/gi, 'disabled-vb:')
      .replace(/data:text\/html/gi, 'disabled-data:');
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
    if (f.tag && !getItemTags(it).includes(f.tag)) return false;
    if (f.dateFrom || f.dateTo) {
      const t = it.timestamp || 0;
      if (f.dateFrom && t < new Date(f.dateFrom + 'T00:00:00').getTime()) return false;
      if (f.dateTo && t > new Date(f.dateTo + 'T23:59:59').getTime()) return false;
    }
    return true;
  }

  // 同题聚类：标题相似度 > 0.8 且来自不同信源的新闻视为同一事件，折叠成一组
  function clusterNews(list) {
    const groups = [];
    const used = new Set();
    for (let i = 0; i < list.length; i++) {
      if (used.has(i)) continue;
      const a = list[i];
      const group = { main: a, items: [a] };
      for (let j = i + 1; j < list.length; j++) {
        if (used.has(j)) continue;
        const b = list[j];
        if (b.sourceId !== a.sourceId && similarity(a.title, b.title) > 0.8) {
          group.items.push(b);
          used.add(j);
        }
      }
      used.add(i);
      groups.push(group);
    }
    return groups;
  }

  // 单张卡片 DOM 构造（抽出复用，便于分片渲染）
  function buildCard(it, animate) {
    const key = Store.dedupeKey(it);
    const fav = isFav(it);
    const watched = isWatchedSource(it);
    // 收藏新闻始终保持默认（不淡化）：每次刷新/切页都恢复；其它新闻仍按「本轮点击过」淡化
    const dimmed = fav ? false : state.sessionRead.has(key);
    const card = document.createElement('article');
    card.className = 'card' + (fav ? ' fav-mark' : '') + (watched ? ' watched-mark' : '') + (dimmed ? ' read' : '') + (isHiddenByRule(it) ? ' hidden-by-rule' : '');
    card.dataset.key = key;
    if (animate && pendingNewKeys.has(key)) card.classList.add('entering');
    const cats = (it.categories || []).map(c => CATEGORY_NAMES[c] || c).join(' · ');
    const regionText = REGION_NAMES[it.region] || it.region;
    const srcObj = SOURCES.NEWS_SOURCES.find(s => s.id === it.sourceId);
    const fallbackLogo = (srcObj && srcObj.profile && srcObj.profile.logo) || '';
    const tags = getItemTags(it);
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
        (tags.length ? '<div class="card-tags">' + tags.map(t => '<span class="tag-chip">' + esc(t) + '</span>').join('') + '</div>' : '') +
      '</div>';
    const coverWrap = createCover(it.cover, it.title, fallbackLogo);
    card.insertBefore(coverWrap, card.firstChild);
    // hover 快捷打标按钮
    const tagAdd = document.createElement('button');
    tagAdd.className = 'card-tag-add';
    tagAdd.title = '添加标签';
    tagAdd.textContent = '＋标签';
    tagAdd.addEventListener('click', (e) => {
      e.stopPropagation();
      const t = prompt('输入标签名：');
      if (t && t.trim()) { addTag(it, t.trim()); renderNews({ animate: false }); if (state.page === 'favorites') renderFavorites(); }
    });
    card.appendChild(tagAdd);
    card.addEventListener('click', () => openArticleModal(it));
    return card;
  }

  // 首次启动无缓存时的骨架屏
  function renderNewsSkeleton() {
    const grid = el('news-grid');
    if (!grid) return;
    let html = '';
    for (let i = 0; i < 6; i++) {
      html += '<div class="skeleton-card"><div class="skeleton-cover"></div><div class="skeleton-body">' +
        '<div class="skeleton-line w60"></div><div class="skeleton-line w90"></div><div class="skeleton-line w40"></div></div></div>';
    }
    grid.innerHTML = html;
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

    const list = state.news.filter(it => matchFilters(it) && !isHiddenEffective(it));
    const pinFav = settings.pinFavorites !== false;
    const pinWatch = settings.pinWatched !== false;

    // 置顶项与普通项彻底分离：置顶区单独渲染、不参与日期分组，避免「置顶后日期归属错乱」
    const pinned = (pinFav || pinWatch)
      ? list.filter(it => (pinFav && isFav(it)) || (pinWatch && isWatchedSource(it)))
      : [];
    pinned.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const pinSet = new Set(pinned);
    const rest = pinned.length ? list.filter(it => !pinSet.has(it)) : list;

    el('news-count').textContent = list.length + ' 条';

    if (list.length === 0) {
      if (state.news.length === 0) renderNewsSkeleton();
      else grid.innerHTML = '<div class="placeholder">没有符合条件的新闻，试试调整筛选或点「立即刷新」。</div>';
      pendingNewKeys.clear();
      return;
    }

    const limit = Math.max(30, state.renderLimit || 60);
    const visible = rest.slice(0, Math.max(0, limit - pinned.length));
    const groups = clusterNews(visible);
    const frag = document.createDocumentFragment();

    // 置顶区（不显示日期，只显示"置顶"分隔）
    if (pinned.length) {
      const pinDiv = document.createElement('div');
      pinDiv.className = 'divider pinned';
      pinDiv.innerHTML = '<span class="divider-label">置顶（收藏 / 重点关注）</span>';
      frag.appendChild(pinDiv);
      for (const it of pinned.slice(0, limit)) frag.appendChild(buildCard(it, animate));
    }

    // 普通区：按日期分组（从空状态开始，不受置顶影响）
    let lastMonth = '', lastDay = '';
    for (const g of groups) {
      const it = g.main;
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
      // 同题聚类折叠块：主卡下方展示同题报道，可展开
      if (g.items.length > 1) {
        const cid = Store.dedupeKey(g.main);
        const collapsed = !clusterExpanded.has(cid);
        const wrap = document.createElement('div');
        wrap.className = 'cluster';
        if (collapsed) {
          wrap.innerHTML = '<button class="cluster-toggle">另有 ' + (g.items.length - 1) + ' 家媒体同题报道 ▸</button>';
        } else {
          wrap.innerHTML = '<button class="cluster-toggle">收起同题报道（' + (g.items.length - 1) + ' 家）▾</button>';
          for (const sub of g.items.slice(1)) {
            const row = document.createElement('button');
            row.className = 'cluster-item';
            row.innerHTML = '<span class="cluster-src">' + esc(sub.source || '') + '</span><span class="cluster-title">' + esc(sub.title || '') + '</span>';
            row.addEventListener('click', () => openArticleModal(sub));
            wrap.appendChild(row);
          }
        }
        const toggle = wrap.querySelector('.cluster-toggle');
        if (toggle) toggle.addEventListener('click', () => {
          if (clusterExpanded.has(cid)) clusterExpanded.delete(cid); else clusterExpanded.add(cid);
          renderNews({ animate: false });
        });
        frag.appendChild(wrap);
      }
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
  // ---------- 重点关注信源 / 信源自定义标签 / 付费标记 ----------
  function isWatchedSourceId(id) { return (settings.watchedSources || []).indexOf(id) >= 0; }
  async function toggleWatchedSource(id) {
    settings.watchedSources = settings.watchedSources || [];
    const i = settings.watchedSources.indexOf(id);
    if (i >= 0) settings.watchedSources.splice(i, 1);
    else settings.watchedSources.push(id);
    const ok = await Store.saveSettings(settings);
    if (!ok) {
      // 写入失败：回滚，避免"界面已关注、重启后消失"
      if (i >= 0) settings.watchedSources.splice(i, 0, id);
      else settings.watchedSources = settings.watchedSources.filter(x => x !== id);
      showToast('关注保存失败，请检查数据目录是否可写');
      return;
    }
    showToast(i >= 0 ? '已取消重点关注' : '已加入重点关注');
    renderSources();
    renderNews({ animate: false });
    if (state.page === 'favorites') renderFavorites();
  }
  function getSourceUserTags(id) { return (settings.sourceUserTags || {})[id] || []; }
  function addSourceTag(id, tag) {
    tag = (tag || '').trim();
    if (!tag) return;
    settings.sourceUserTags = settings.sourceUserTags || {};
    const arr = settings.sourceUserTags[id] || [];
    if (arr.indexOf(tag) < 0) arr.push(tag);
    settings.sourceUserTags[id] = arr;
    Store.saveSettings(settings);
    renderSources();
  }
  function removeSourceTag(id, tag) {
    settings.sourceUserTags = settings.sourceUserTags || {};
    const arr = (settings.sourceUserTags[id] || []).filter(t => t !== tag);
    if (arr.length) settings.sourceUserTags[id] = arr; else delete settings.sourceUserTags[id];
    Store.saveSettings(settings);
    renderSources();
  }
  function isSourcePaid(id) { return !!(settings.sourcePaid || {})[id]; }
  function toggleSourcePaid(id) {
    settings.sourcePaid = settings.sourcePaid || {};
    if (settings.sourcePaid[id]) delete settings.sourcePaid[id];
    else settings.sourcePaid[id] = true;
    Store.saveSettings(settings);
    renderSources();
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
    // 重点关注发布者置顶（在筛选结果内排序，因此仍受筛选影响）
    list.sort((a, b) => (isWatchedSourceId(b.id) ? 1 : 0) - (isWatchedSourceId(a.id) ? 1 : 0));
    const frag = document.createDocumentFragment();
    for (const it of list) {
      const p = it.profile || {};
      const leanText = POLITICAL_LEAN_NAMES[p.politicalLean] || p.politicalLean || '未知';
      const regionText = REGION_NAMES[it.region] || it.region || '未知';
      const logoUrl = p.logo || '';
      const watched = isWatchedSourceId(it.id);
      const paid = isSourcePaid(it.id);
      const userTags = getSourceUserTags(it.id);
      const catTags = (it.categories || []).map(c => CATEGORY_NAMES[c] || c).filter(Boolean);
      const card = document.createElement('div');
      card.className = 'source-card' + (watched ? ' watched-mark' : '');
      card.innerHTML =
        '<button class="src-watch-btn' + (watched ? ' active' : '') + '" title="' + (watched ? '取消重点关注' : '加入重点关注') + '">' + (watched ? '★' : '☆') + '</button>' +
        '<div class="source-logo">' +
          (logoUrl ? '<img src="' + encodeURI(logoUrl) + '" alt="" onerror="this.style.display=\'none\'; this.nextElementSibling.style.display=\'flex\'">' +
                     '<span class="logo-ph" style="display:none">' + (it.name.charAt(0) || '📰') + '</span>'
                   : '<span class="logo-ph">' + (it.name.charAt(0) || '📰') + '</span>') +
        '</div>' +
        '<div class="source-body">' +
          '<h3 class="source-name">' + esc(it.name) + (paid ? '<span class="src-paid-badge">付费</span>' : '') + '</h3>' +
          '<div class="source-tags">' +
            '<span class="badge ' + it.grade + '">' + it.grade + '</span>' +
            '<span class="source-tag">' + regionText + '</span>' +
            '<span class="source-tag lean">' + leanText + '</span>' +
            (it.lang ? '<span class="source-tag">' + esc(it.lang) + '</span>' : '') +
          '</div>' +
          '<div class="source-tags src-tag-edit">' +
            catTags.map(c => '<span class="tag-chip src-cat" title="内置分类（不可删除）">' + esc(c) + '</span>').join('') +
            userTags.map(t => '<span class="tag-chip src-user">' + esc(t) + '<button class="tag-remove" data-tag="' + esc(t) + '">×</button></span>').join('') +
            '<button class="src-tag-add" title="添加自定义标签（仅对该发布者生效，可删除）">＋标签</button>' +
            '<button class="src-paid-toggle' + (paid ? ' active' : '') + '" title="标记为付费信源">付费</button>' +
          '</div>' +
          '<p class="source-bg">' + esc(p.background || '暂无背景介绍。') + '</p>' +
        '</div>';
      card.querySelector('.src-watch-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleWatchedSource(it.id); });
      const tagAdd = card.querySelector('.src-tag-add');
      if (tagAdd) tagAdd.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = prompt('添加标签（仅对该发布者生效，可删除）：');
        if (t && t.trim()) addSourceTag(it.id, t.trim());
      });
      card.querySelectorAll('.tag-remove').forEach(btn => btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeSourceTag(it.id, btn.dataset.tag);
      }));
      const paidToggle = card.querySelector('.src-paid-toggle');
      if (paidToggle) paidToggle.addEventListener('click', (e) => { e.stopPropagation(); toggleSourcePaid(it.id); });
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
  function renderModalTags(item) {
    const box = el('modal-tags');
    if (!box) return;
    box.innerHTML = '';
    const tags = getItemTags(item);
    for (const t of tags) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      const rm = document.createElement('button');
      rm.className = 'tag-remove';
      rm.textContent = '×';
      rm.addEventListener('click', () => { removeTag(item, t); renderModalTags(item); renderNews({ animate: false }); });
      chip.appendChild(document.createTextNode(t));
      chip.appendChild(rm);
      box.appendChild(chip);
    }
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tag-input';
    input.placeholder = tags.length ? '＋ 添加标签，回车确认' : '添加标签，回车确认';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        addTag(item, input.value.trim());
        renderModalTags(item);
        renderNews({ animate: false });
        if (state.page === 'favorites') renderFavorites();
      }
    });
    box.appendChild(input);
  }

  function openArticleModal(item) {
    currentModalItem = item;
    markRead(item);
    renderModalTags(item);
    applyFooterMode(settings.modalFooter || 'docked');
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
    if (isPdfLink(item.link)) return false; // PDF 直接内嵌阅读，无需抓正文
    return FeedParser.stripHtml(item.content || '').trim().length < 1200;
  }

  function removeDuplicateTitle(root, title) {
    if (!title || !root) return;
    const firstH = root.querySelector('h1, h2, h3');
    if (!firstH) return;
    const hText = (firstH.innerText || firstH.textContent || '').trim();
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

  // 正文智能排版：去重图注、过滤推荐卡片、识别参考文献、清理空块与冗余换行
  function smartArticleLayout(root) {
    if (!root) return;
    // 1) 相邻重复的 figcaption 只保留一个（源站常见重复图片说明）
    let prevCaption = '';
    Array.from(root.querySelectorAll('figcaption')).forEach(cap => {
      const t = (cap.innerText || cap.textContent || '').trim();
      if (t && t === prevCaption) { cap.remove(); return; }
      prevCaption = t;
    });
    // 2) 与 hero 封面重复的首图移除，避免同一张图在弹窗里出现两次
    const cover = (currentModalItem && currentModalItem.cover) || '';
    if (cover) {
      const firstImg = root.querySelector('img');
      if (firstImg && (firstImg.getAttribute('src') || '') === cover) {
        const fig = firstImg.closest('figure');
        if (fig) fig.remove(); else firstImg.remove();
      }
    }
    // 3) 孤立图片（不在 figure 内、且不在段落内）包成 figure，统一图注与间距
    Array.from(root.querySelectorAll('img')).forEach(img => {
      if (img.closest('figure')) return;
      const parent = img.parentNode;
      if (!parent || parent.tagName === 'P') return;
      const fig = document.createElement('figure');
      parent.insertBefore(fig, img);
      fig.appendChild(img);
    });
    // 4) 移除推荐 / 相关阅读（"N min read"、Discover More、related-articles 等）
    Array.from(root.querySelectorAll('div, section, article, li')).forEach(el => {
      if (!el.isConnected) return;
      const cls = (el.getAttribute('class') || '') + ' ' + (el.getAttribute('id') || '');
      const text = (el.textContent || '').toLowerCase();
      const isReco = /(discover[-_]?more|related[-_]?(articles?|stories?|content|topics)|recommend)/i.test(cls) ||
                     /\d+\s*min\s*read/.test(text);
      if (!isReco) return;
      if (el.querySelectorAll('p').length > 6) return; // 排除正文大容器
      el.remove();
    });
    // 5) 识别参考文献 / 引用资料区块，加统一样式（更小字号、次要色）
    Array.from(root.querySelectorAll('h1, h2, h3, h4')).forEach(h => {
      const t = (h.textContent || '').trim().toLowerCase();
      if (/^(references?|sources?|resources?|further reading|参考|来源|引用)/.test(t)) {
        h.classList.add('article-ref-title');
        let sib = h.nextElementSibling;
        while (sib && !/^H[1-6]$/.test(sib.tagName)) {
          sib.classList.add('article-ref');
          sib = sib.nextElementSibling;
        }
      }
    });
    // 5.5) 收集来源元信息（作者 / 详情 / 标签 / 分享），移到正文末尾的独立来源卡
    const FOOTER_RE = /(about[-_]?author|author[-_]?bio|keep[-_]?exploring|related[-_]?terms|article[-_]?meta|source[-_]?meta|byline|\bdetails\b|\bcontact\b|\bshare\b|sharing|social)/i;
    const footerNodes = [];
    Array.from(root.querySelectorAll('div, section, aside, footer, dl, ul, p')).forEach(el => {
      if (!el.isConnected) return;
      const key = (el.getAttribute('class') || '') + ' ' + (el.getAttribute('id') || '');
      if (!key.trim() || !FOOTER_RE.test(key)) return;
      if (footerNodes.some(n => n.contains(el) || el.contains(n))) return;
      if (el.querySelectorAll('p').length > 6) return; // 避免误收正文大容器
      footerNodes.push(el);
    });
    if (footerNodes.length) {
      const card = document.createElement('section');
      card.className = 'article-source-card';
      const title = document.createElement('h4');
      title.className = 'asc-title';
      title.textContent = '来源信息';
      const body = document.createElement('div');
      body.className = 'asc-body';
      for (const n of footerNodes) { body.appendChild(n.cloneNode(true)); n.remove(); }
      card.appendChild(title);
      card.appendChild(body);
      root.appendChild(card);
    }
    // 6) 清除只含空白 / &nbsp; / <br> 的段落与容器（消除大片空白）
    Array.from(root.querySelectorAll('p, div, section, span')).forEach(el => {
      if (!el.isConnected) return;
      if (el.querySelector('img, figure, table, iframe, video, audio, a, button')) return;
      const meaningful = (el.textContent || '').replace(/[\s\u00a0\u200b]+/g, '');
      if (!meaningful) el.remove();
    });
    // 7) 合并连续 <br>，消除源站冗余换行造成的过大空白
    Array.from(root.querySelectorAll('br')).forEach(br => {
      if (!br.isConnected) return;
      let next = br.nextSibling;
      while (next && next.nodeType === 3 && !next.textContent.trim()) next = next.nextSibling;
      while (next && next.nodeName === 'BR') { const n = next.nextSibling; next.remove(); next = n; }
    });
  }

  // ---------- PDF 文档内嵌阅读 ----------
  function isPdfLink(url) {
    if (!url) return false;
    try { return /\.pdf$/i.test(new URL(url).pathname); }
    catch (_) { return /\.pdf(?:[?#]|$)/i.test(url); }
  }
  function renderPdfViewer(container, url) {
    container.innerHTML = '';
    container.classList.add('pdf-mode');
    const wrap = document.createElement('div');
    wrap.className = 'pdf-viewer-wrap';
    const frame = document.createElement('iframe');
    frame.className = 'pdf-frame';
    frame.setAttribute('title', '在线文档');
    const status = document.createElement('div');
    status.className = 'pdf-tip';
    status.textContent = '正在加载在线文档…';
    let loaded = false;
    frame.addEventListener('load', () => {
      loaded = true;
      status.textContent = '在线文档已加载。若上方显示空白，说明该站点禁止内嵌，可点「下载并内嵌」存到本地后直接阅读。';
    });
    setTimeout(() => {
      if (!loaded) status.textContent = '在线加载较慢或被站点阻止；可点「下载并内嵌」把文件存到本地后直接阅读。';
    }, 8000);

    const actions = document.createElement('div');
    actions.className = 'pdf-actions';
    const openBtn = document.createElement('button');
    openBtn.className = 'btn-secondary';
    openBtn.textContent = '用浏览器打开';
    openBtn.addEventListener('click', () => openLink(url));
    const embedBtn = document.createElement('button');
    embedBtn.className = 'btn-primary';
    embedBtn.textContent = '下载并内嵌';
    embedBtn.addEventListener('click', () => downloadAndEmbed(url, frame, status, embedBtn));
    const sysBtn = document.createElement('button');
    sysBtn.className = 'btn-secondary';
    sysBtn.textContent = '下载到本地（系统打开）';
    sysBtn.addEventListener('click', () => downloadPdf(url, sysBtn));

    actions.appendChild(openBtn);
    actions.appendChild(embedBtn);
    actions.appendChild(sysBtn);
    wrap.appendChild(frame);
    wrap.appendChild(status);
    wrap.appendChild(actions);
    container.appendChild(wrap);
    frame.src = url;
  }
  // 下载在线文档到本地后用 app-file:// 内嵌显示（解决站点禁止 iframe 内嵌的问题）
  async function downloadAndEmbed(url, frame, statusEl, btn) {
    if (!window.electronAPI || !window.electronAPI.downloadDocument) { showToast('仅桌面版支持'); return; }
    if (btn) { btn.disabled = true; btn.textContent = '下载中…'; }
    if (statusEl) statusEl.textContent = '正在下载文档到本地…';
    const r = await window.electronAPI.downloadDocument(url);
    if (btn) { btn.disabled = false; btn.textContent = '下载并内嵌'; }
    if (r && r.ok) {
      frame.src = r.url;
      if (statusEl) statusEl.textContent = '已下载到本地（' + Math.round((r.size || 0) / 1024) + ' KB），正在以本地文件显示；可在「设置 → 缓存与后台」中清理。';
    } else if (statusEl) {
      statusEl.textContent = '下载失败：' + ((r && r.reason) || '未知错误');
    }
  }
  async function downloadPdf(url, btn) {
    if (!window.electronAPI || !window.electronAPI.downloadFile) { showToast('仅桌面版支持'); return; }
    if (btn) { btn.disabled = true; btn.textContent = '下载中…'; }
    const r = await window.electronAPI.downloadFile(url);
    if (btn) { btn.disabled = false; btn.textContent = '下载到本地'; }
    showToast(r && r.ok ? '已下载并用系统程序打开' : '下载失败：' + ((r && r.reason) || '未知错误'));
  }

  function renderModalContent(html, isSummaryOnly, statusNote) {
    const contentEl = el('modal-content');
    contentEl.classList.remove('pdf-mode');
    const link = (currentModalItem && currentModalItem.link) || '';
    if (isPdfLink(link)) { renderPdfViewer(contentEl, link); return; }
    if (html && html.trim()) {
      if (settings.smartClean !== false) {
        html = FeedParser.cleanArticleHtml(html, currentModalItem && currentModalItem.link, { aggressive: false });
      }
      contentEl.innerHTML = sanitizeHtml(html);
      removeDuplicateTitle(contentEl, el('modal-title').textContent);
      smartArticleLayout(contentEl);
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

  // 需要「先渲染再抓取」的站点（JS 渲染或反爬 403）
  function needsRenderedFetch(url) {
    try {
      const h = new URL(url).hostname.replace(/^www\./, '');
      return /(^|\.)nytimes\.com$/.test(h) || /(^|\.)france24\.com$/.test(h);
    } catch (_) { return false; }
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
      return true;
    }

    // 1) 需要渲染的站点：隐藏窗口加载 1.2~2.5s，等正文/图片出现后取 DOM
    if (needsRenderedFetch(item.link) && window.electronAPI && window.electronAPI.fetchRendered) {
      try {
        const r = await window.electronAPI.fetchRendered(item.link, { waitMs: 2000 });
        if (r && r.ok && r.html) {
          const ok = await doExtract(r.html, '渲染页面为空');
          if (ok) return;
        }
      } catch (_) { /* 继续走普通抓取 */ }
    }

    try {
      const res = await DataLayer.fetchText(item.link);
      const html = (res && res.body != null) ? res.body : res;
      await doExtract(html);
    } catch (e) {
      console.warn('[loadFullArticle] 直接抓取失败，尝试代理回退', item.link, e && e.message);
      try {
        const proxyBase = settings.proxyPrefix || 'https://api.allorigins.win/raw?url=';
        const proxyRes = await DataLayer.fetchText(proxyBase + encodeURIComponent(item.link));
        const proxyHtml = (proxyRes && proxyRes.body != null) ? proxyRes.body : proxyRes;
        await doExtract(proxyHtml, '代理返回内容为空');
      } catch (pe) {
        // 2) 动态渲染兜底（反爬 403 / JS 渲染站点）
        let rendered = false;
        try {
          if (window.electronAPI && window.electronAPI.fetchRendered) {
            const r = await window.electronAPI.fetchRendered(item.link, { waitMs: 2500 });
            if (r && r.ok && r.html) rendered = await doExtract(r.html, '渲染页面为空');
          }
        } catch (_) { /* ignore */ }
        if (rendered) return;
        // 3) 最终回退到 RSS 内容
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
    const wasFav = state.favorites.has(k);
    const snapshot = wasFav ? state.favorites.get(k) : null;
    if (wasFav) state.favorites.delete(k);
    else state.favorites.set(k, JSON.parse(JSON.stringify(item)));
    const ok = await Store.saveFavorites(Array.from(state.favorites.values()));
    if (!ok) {
      // 写入失败：回滚内存，避免"界面显示已收藏、重启后消失"
      if (wasFav) state.favorites.set(k, snapshot);
      else state.favorites.delete(k);
      showToast('收藏保存失败，请检查数据目录是否可写');
      return;
    }
    const favBtn = el('modal-favorite');
    if (favBtn) {
      favBtn.textContent = isFav(item) ? '★ 已收藏' : '☆ 收藏';
      favBtn.classList.toggle('favorited', isFav(item));
    }
    renderNews();
    if (state.page === 'favorites') renderFavorites();
  }

  // ---------- 收藏页 ----------
  function renderFavorites() {
    const grid = el('fav-grid');
    const watchList = el('fav-watch-list');
    const countEl = el('fav-count');
    if (!grid) return;
    const tab = state.favTab || 'news';
    const tabs = el('fav-tabs');
    if (tabs) tabs.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.favtab === tab));
    grid.classList.toggle('hidden', tab !== 'news');
    if (watchList) watchList.classList.toggle('hidden', tab !== 'watch');
    const clearBtn = el('clear-favs-btn');
    if (clearBtn) clearBtn.classList.toggle('hidden', tab !== 'news');

    if (tab === 'watch') {
      const ids = settings.watchedSources || [];
      if (countEl) countEl.textContent = ids.length + ' 个';
      if (!watchList) return;
      watchList.innerHTML = '';
      if (!ids.length) {
        watchList.innerHTML = '<div class="placeholder">还没有重点关注发布者。到「发布者」页点卡片右上角 ☆ 即可添加。</div>';
        return;
      }
      const frag = document.createDocumentFragment();
      for (const id of ids) {
        const s = SOURCES.NEWS_SOURCES.find(x => x.id === id);
        if (!s) continue;
        const p = s.profile || {};
        const card = document.createElement('div');
        card.className = 'source-card watched-mark';
        card.innerHTML =
          '<button class="src-watch-btn active" title="取消重点关注">★</button>' +
          '<div class="source-logo"><span class="logo-ph">' + (s.name.charAt(0) || '📰') + '</span></div>' +
          '<div class="source-body">' +
            '<h3 class="source-name">' + esc(s.name) + '</h3>' +
            '<div class="source-tags">' +
              '<span class="badge ' + s.grade + '">' + s.grade + '</span>' +
              '<span class="source-tag">' + (REGION_NAMES[s.region] || s.region || '') + '</span>' +
              (isSourcePaid(s.id) ? '<span class="tag-chip src-cat">付费</span>' : '') +
            '</div>' +
            '<p class="source-bg">' + esc(p.background || '') + '</p>' +
          '</div>';
        card.querySelector('.src-watch-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleWatchedSource(s.id); });
        card.addEventListener('click', () => openLink(sourceWebsite(s)));
        frag.appendChild(card);
      }
      watchList.appendChild(frag);
      return;
    }

    const list = Array.from(state.favorites.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    if (countEl) countEl.textContent = list.length + ' 条';
    if (list.length === 0) {
      grid.innerHTML = '<div class="placeholder">还没有收藏。打开任意新闻，点击「☆ 收藏」即可在此集中查看。</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const it of list) frag.appendChild(buildCard(it, false));
    grid.innerHTML = '';
    grid.appendChild(frag);
  }
  async function clearFavorites() {
    state.favorites.clear();
    await Store.saveFavorites([]);
    renderFavorites();
    renderNews();
    showToast('已清空全部收藏');
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
    // 订阅提醒：新增新闻命中关键词时发系统通知
    const watch = (settings.watchlist || []).map(w => String(w).trim().toLowerCase()).filter(Boolean);
    if (watch.length && window.electronAPI && window.electronAPI.notify) {
      const addedSet = new Set(res.addedKeys || []);
      for (const it of res.merged) {
        if (!addedSet.has(Store.dedupeKey(it))) continue;
        const title = (it.title || '').toLowerCase();
        for (const w of watch) {
          if (title.includes(w)) {
            window.electronAPI.notify('订阅提醒', (it.title || '') + '（' + (it.source || '') + '）');
            break;
          }
        }
      }
    }
    // 自动规则动作（已读/收藏），仅对本次新增项应用
    if (res.addedKeys && res.addedKeys.length && (settings.rules || []).length) {
      const addedSet = new Set(res.addedKeys);
      applyRulesToItems(res.merged.filter(it => addedSet.has(Store.dedupeKey(it))));
    }
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
      const opts = {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: type !== 'bar', labels: { color: '#a1a1a6' } } },
        scales: {
          x: { ticks: { color: '#a1a1a6', maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.06)' } },
          y: { ticks: { color: '#a1a1a6' }, grid: { color: 'rgba(255,255,255,0.06)' }, beginAtZero: true }
        }
      };
      // 复用已有实例，仅 update，避免 destroy 重建导致的闪烁
      const existing = charts[id];
      if (existing && existing.config && existing.config.type === type) {
        existing.data.labels = labels;
        existing.data.datasets[0] = { label, data, backgroundColor: palette, borderColor: palette, borderWidth: 1 };
        existing.update();
        return;
      }
      if (existing) existing.destroy();
      charts[id] = new Chart(cv.getContext('2d'), {
        type,
        data: { labels, datasets: [{ label, data, backgroundColor: palette, borderColor: palette, borderWidth: 1 }] },
        options: opts
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
  function applyFontSize() {
    const map = { s: '15px', m: '17px', l: '20px' };
    document.documentElement.style.setProperty('--article-font-size', map[settings.fontSize] || map.m);
  }
  function watchlistToString() {
    return (settings.watchlist || []).join('、');
  }
  function watchlistFromString(s) {
    return String(s || '').split(/[、,，\n]+/).map(x => x.trim()).filter(Boolean);
  }
  function renderRules() {
    const box = el('rules-list');
    if (!box) return;
    box.innerHTML = '';
    const rules = settings.rules || [];
    if (!rules.length) { box.innerHTML = '<p class="set-hint">暂无规则，添加后自动生效。</p>'; return; }
    const frag = document.createDocumentFragment();
    rules.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'rule-row';
      row.innerHTML =
        '<code class="rule-pattern">' + esc(r.pattern) + '</code>' +
        '<span class="rule-meta">' + (RULE_FIELDS[r.field] || '标题') + ' → ' + (RULE_ACTIONS[r.action] || '已读') + '</span>' +
        '<label class="ios-toggle sm"><input type="checkbox" class="rule-enable" ' + (r.enabled !== false ? 'checked' : '') + ' /><span class="toggle-track"></span></label>' +
        '<button class="rule-del">删除</button>';
      row.querySelector('.rule-enable').addEventListener('change', (e) => {
        rules[i].enabled = e.target.checked;
        Store.saveSettings(settings);
        renderNews({ animate: false });
      });
      row.querySelector('.rule-del').addEventListener('click', () => {
        rules.splice(i, 1);
        Store.saveSettings(settings);
        renderRules();
        renderNews({ animate: false });
      });
      frag.appendChild(row);
    });
    box.appendChild(frag);
  }
  function renderTagChips() {
    const box = el('tag-tabs');
    if (!box) return;
    box.querySelectorAll('.chip[data-tag-dynamic]').forEach(c => c.remove());
    for (const t of allTags()) {
      const b = document.createElement('button');
      b.className = 'chip' + (state.filters.tag === t ? ' active' : '');
      b.dataset.tag = t;
      b.dataset.tagDynamic = '1';
      b.textContent = t;
      box.appendChild(b);
    }
  }

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
    el('set-font-size').value = settings.fontSize || 'm';
    el('set-proxy-prefix').value = settings.proxyPrefix || '';
    el('set-watchlist').value = watchlistToString();
    el('set-llm-enabled').checked = !!(settings.llm && settings.llm.enabled);
    el('set-llm-provider').value = (settings.llm && settings.llm.provider) || 'openai';
    el('set-llm-key').value = (settings.llm && settings.llm.apiKey) || '';
    el('set-llm-base').value = (settings.llm && settings.llm.baseUrl) || '';
    el('set-llm-model').value = (settings.llm && settings.llm.model) || '';
    el('set-llm-brief-auto').checked = !!(settings.llm && settings.llm.briefAuto);
    el('set-tts-provider').value = (settings.tts && settings.tts.provider) || 'system';
    el('set-tts-voice').value = (settings.tts && settings.tts.voice) || 'zh-CN';
    el('set-fever-enabled').checked = !!(settings.fever && settings.fever.enabled);
    el('set-rsshub-base').value = (settings.rsshub && settings.rsshub.base) || 'https://rsshub.app';
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
    renderRules();
    refreshCacheStats();
    // 已下载文档统计（纳入缓存清理范围）
    Store.downloadsInfo().then(info => {
      const box = el('downloads-stats');
      if (!box) return;
      const bytes = info.bytes || 0;
      const sizeText = bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB';
      box.textContent = (info.count || 0) + ' 个文件 · ' + sizeText;
    });
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
    // 信源健康度状态点（绿=最近成功 / 黄=偶发失败 / 红=连续失败 / 灰=未抓取）
    const health = state.sourceHealth[s.id];
    const dot = document.createElement('span');
    dot.className = 'health-dot' + (health ? (health.ok ? ' ok' : (health.consecutiveFails >= 3 ? ' bad' : ' warn')) : ' none');
    dot.title = health
      ? ((health.ok ? '最近成功' : '连续失败 ' + health.consecutiveFails + ' 次') +
         (health.error ? '：' + health.error : '') +
         (health.lastTry ? ' · 上次尝试 ' + new Date(health.lastTry).toLocaleString('zh-CN', { hour12: false }) : ''))
      : '尚未抓取过';
    row.appendChild(dot);

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
    settings.fontSize = el('set-font-size').value || 'm';
    settings.proxyPrefix = el('set-proxy-prefix').value.trim();
    settings.watchlist = watchlistFromString(el('set-watchlist').value);
    settings.llm = settings.llm || {};
    settings.llm.enabled = el('set-llm-enabled').checked;
    settings.llm.provider = el('set-llm-provider').value;
    settings.llm.apiKey = el('set-llm-key').value.trim();
    settings.llm.baseUrl = el('set-llm-base').value.trim();
    settings.llm.model = el('set-llm-model').value.trim();
    settings.llm.briefAuto = el('set-llm-brief-auto').checked;
    settings.tts = settings.tts || {};
    settings.tts.provider = el('set-tts-provider').value;
    settings.tts.voice = el('set-tts-voice').value.trim();
    settings.fever = settings.fever || {};
    settings.fever.enabled = el('set-fever-enabled').checked;
    settings.rsshub = settings.rsshub || {};
    settings.rsshub.base = el('set-rsshub-base').value.trim();
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
    const saved = await Store.saveSettings(settings);
    Store.setSettings(settings); // 同步窗口配置给数据层
    if (window.electronAPI && window.electronAPI.setBackgroundRefresh) {
      window.electronAPI.setBackgroundRefresh(settings.backgroundRefresh !== false);
    }
    syncAutoRefreshFromSettings();
    applyFontSize();
    if (window.DataLayer && DataLayer.MODES) {
      const mode = DataLayer.MODES[settings.fetchMode] || DataLayer.MODES.balanced;
      DataLayer.configure(Object.assign({}, mode, { proxyPrefix: settings.proxyPrefix || '' }));
    }
    if (!saved) { showToast('设置保存失败，请检查数据目录是否可写'); return; }
    showToast(note || '已保存');
  }

  // ---------- 导出与批量已读 ----------
  function exportNews() {
    const list = state.news.filter(it => matchFilters(it) && !isHiddenEffective(it));
    if (!list.length) { showToast('没有可导出的新闻'); return; }
    const lines = ['# 新闻导出', '', '导出时间：' + new Date().toLocaleString('zh-CN', { hour12: false }), '数量：' + list.length + ' 条', ''];
    for (const it of list) {
      const src = it.source || '';
      const grade = it.grade || '';
      const cats = (it.categories || []).map(c => CATEGORY_NAMES[c] || c).join('、');
      const time = it.dateText || '';
      lines.push('## ' + (it.title || '无标题'));
      lines.push('');
      lines.push('- 来源：' + src + (grade ? '（' + grade + '）' : ''));
      if (cats) lines.push('- 分类：' + cats);
      if (time) lines.push('- 时间：' + time);
      if (it.link) lines.push('- 链接：' + it.link);
      const summary = FeedParser.stripHtml(it.summary || '').trim();
      if (summary) lines.push('', summary);
      lines.push('', '---', '');
    }
    const md = lines.join('\n');
    if (window.electronAPI && window.electronAPI.storage) {
      const ts = new Date();
      const p = (d) => String(d).padStart(2, '0');
      const fname = 'exports/news_' + ts.getFullYear() + '-' + p(ts.getMonth() + 1) + '-' + p(ts.getDate()) + '_' + p(ts.getHours()) + p(ts.getMinutes()) + p(ts.getSeconds()) + '.md';
      window.electronAPI.storage.write(fname, md).then(ok => {
        showToast(ok ? '已导出到 data/' + fname : '导出失败');
      });
    } else {
      const blob = new Blob([md], { type: 'text/markdown' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'news_export.md';
      a.click();
      URL.revokeObjectURL(a.href);
      showToast('已导出');
    }
  }
  function markAllRead() {
    const list = state.news.filter(it => matchFilters(it) && !isHiddenEffective(it));
    if (!list.length) { showToast('当前没有新闻'); return; }
    for (const it of list) {
      state.readKeys.set(favKey(it), Date.now());
      state.sessionRead.add(Store.dedupeKey(it));
    }
    Store.saveReadState(state.readKeys);
    renderNews();
    showToast('已标记 ' + list.length + ' 条为已读');
  }
  // ---------- OPML 导入导出 + 备份恢复 ----------
  function escXml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  function exportOpml() {
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<opml version="2.0">', '<head><title>实时新闻中心信源</title></head>', '<body>'];
    for (const s of SOURCES.NEWS_SOURCES) {
      const title = escXml(s.name || s.id);
      const url = escXml(s.url || '');
      const grade = s.grade || '';
      const region = REGION_NAMES[s.region] || s.region || '';
      const cats = (s.categories || []).map(c => CATEGORY_NAMES[c] || c).join(',');
      const catAttr = escXml([region, grade, cats].filter(Boolean).join(' / '));
      lines.push('  <outline type="rss" text="' + title + '" title="' + title + '" xmlUrl="' + url + '" category="' + catAttr + '"/>');
    }
    lines.push('</body></opml>');
    const xml = lines.join('\n');
    if (window.electronAPI && window.electronAPI.storage) {
      window.electronAPI.storage.write('exports/sources.opml', xml).then(ok => showToast(ok ? '已导出到 data/exports/sources.opml' : '导出失败'));
    } else {
      const blob = new Blob([xml], { type: 'text/xml' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'sources.opml'; a.click(); URL.revokeObjectURL(a.href);
      showToast('已导出');
    }
  }
  async function importOpml() {
    if (!window.electronAPI || !window.electronAPI.pickOpml) { showToast('仅桌面版支持导入'); return; }
    const res = await window.electronAPI.pickOpml();
    if (!res || !res.content) return;
    const doc = new DOMParser().parseFromString(res.content, 'text/xml');
    const outlines = doc.querySelectorAll('outline[xmlUrl]');
    const addedSrcs = [];
    for (const o of outlines) {
      const name = (o.getAttribute('title') || o.getAttribute('text') || '').trim();
      const url = (o.getAttribute('xmlUrl') || '').trim();
      if (!name || !url) continue;
      if (SOURCES.NEWS_SOURCES.some(s => s.url === url)) continue;
      const id = 'user-' + Date.now().toString(36) + '-' + addedSrcs.length;
      const src = { id, name, grade: 'P2', region: 'intl', categories: ['politics'], lang: '', url, profile: { fullName: name, country: '', background: '从 OPML 导入的信源。' } };
      addedSrcs.push(src);
      userSources.push(src);
      userSourceIds.add(id);
    }
    if (addedSrcs.length) {
      await Store.saveUserSources(userSources);
      SOURCES.NEWS_SOURCES = SOURCES.NEWS_SOURCES.concat(addedSrcs);
      renderSources(); renderSourceFilterChips();
      showToast('已导入 ' + addedSrcs.length + ' 个信源');
    } else {
      showToast('未发现新信源（可能已存在或文件为空）');
    }
  }
  async function doBackup() {
    if (!window.electronAPI || !window.electronAPI.backupData) { showToast('仅桌面版支持'); return; }
    const r = await window.electronAPI.backupData();
    showToast(r && r.ok ? '备份完成：' + (r.name || '') : '备份失败：' + ((r && r.reason) || '未知错误'));
  }
  async function doRestore() {
    if (!window.electronAPI || !window.electronAPI.listBackups) { showToast('仅桌面版支持'); return; }
    const list = await window.electronAPI.listBackups();
    if (!list.length) { showToast('暂无可用备份'); return; }
    const name = prompt('选择要恢复的备份（输入完整名称）：\n\n' + list.join('\n'));
    if (!name) return;
    if (confirm('恢复将把当前数据覆盖为备份「' + name + '」，确定？')) {
      const r = await window.electronAPI.restoreData(name);
      showToast(r && r.ok ? '已恢复，重启后生效' : '恢复失败：' + ((r && r.reason) || '未知错误'));
    }
  }
  // ---------- 可选 LLM（翻译 / 简报） ----------
  async function callLLM(messages, opts) {
    opts = opts || {};
    if (!window.electronAPI || !window.electronAPI.llmChat) return { ok: false, reason: '仅桌面版支持' };
    const llm = settings.llm || {};
    return await window.electronAPI.llmChat({
      provider: opts.provider || llm.provider,
      apiKey: llm.apiKey,
      baseUrl: llm.baseUrl,
      model: llm.model,
      messages
    });
  }
  function renderMarkdown(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/^### (.*)$/gm, '<h3>$1</h3>')
      .replace(/^## (.*)$/gm, '<h2>$1</h2>')
      .replace(/^# (.*)$/gm, '<h1>$1</h1>')
      .replace(/^[-*] (.*)$/gm, '<li>$1</li>')
      .replace(/\n/g, '<br>');
  }
  function showBriefModal(title, text) {
    el('brief-title').textContent = title || '结果';
    el('brief-content').innerHTML = renderMarkdown(text || '');
    el('brief-modal').classList.remove('hidden');
  }
  function closeBriefModal() { el('brief-modal').classList.add('hidden'); }
  async function translateCurrentArticle() {
    if (!currentModalItem) return;
    const llm = settings.llm || {};
    if (!llm.enabled) { showToast('请先在「设置 → 智能助手」启用 LLM'); return; }
    const title = currentModalItem.title || '';
    const summary = FeedParser.stripHtml(currentModalItem.summary || '').trim();
    const btn = el('modal-translate');
    if (btn) { btn.disabled = true; btn.textContent = '翻译中…'; }
    const res = await callLLM([{ role: 'user', content: '请把下面的新闻标题和摘要翻译成中文（若已是中文则润色），只输出结果：\n\n标题：' + title + '\n摘要：' + summary }]);
    if (btn) { btn.disabled = false; btn.textContent = '翻译'; }
    if (res && res.ok) showBriefModal('翻译结果', res.text);
    else showToast('翻译失败：' + ((res && res.reason) || '未知错误'));
  }
  async function generateBrief() {
    const llm = settings.llm || {};
    if (!llm.enabled) { showToast('请先在「设置 → 智能助手」启用 LLM'); return; }
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const recent = state.news.filter(it => (it.timestamp || 0) >= cutoff).slice(0, 50);
    if (!recent.length) { showToast('暂无最近 24 小时新闻'); return; }
    const titles = recent.map(it => '- [' + (it.source || '') + '] ' + (it.title || '')).join('\n');
    showToast('正在生成简报，请稍候…');
    const res = await callLLM([{ role: 'user', content: '以下是最近 24 小时的重要新闻标题，请生成一份简洁的每日简报：分 3~5 个主题板块，每板块 2~3 句概括要点，最后用「今日要闻」列出最重要的 3 条。用 Markdown 输出。\n\n' + titles }]);
    if (res && res.ok) showBriefModal('每日简报', res.text);
    else showToast('简报生成失败：' + ((res && res.reason) || '未知错误'));
  }
  // ---------- 朗读（TTS：系统 / 云端） ----------
  function speak(text) {
    if (!text) return;
    const tts = settings.tts || {};
    if (tts.provider === 'cloud') {
      const llm = settings.llm || {};
      if (!window.electronAPI || !window.electronAPI.ttsCloud) { showToast('仅桌面版支持'); return; }
      window.electronAPI.ttsCloud({ apiKey: llm.apiKey, baseUrl: llm.baseUrl, model: 'tts-1', voice: tts.voice || 'alloy', text }).then(r => {
        if (r && r.ok) { new Audio('data:audio/mp3;base64,' + r.audio).play(); }
        else showToast('朗读失败：' + ((r && r.reason) || '未知错误'));
      });
    } else {
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = tts.voice || 'zh-CN';
        speechSynthesis.speak(u);
      } catch (e) { showToast('朗读失败'); }
    }
  }
  function speakCurrentArticle() {
    if (!currentModalItem) return;
    const text = (currentModalItem.title || '') + '。' + FeedParser.stripHtml(currentModalItem.content || currentModalItem.summary || '').trim();
    speak(text.slice(0, 3000));
  }
  function stopSpeak() { try { speechSynthesis.cancel(); } catch (_) {} }
  function toggleImmersive() {
    const modal = el('article-modal');
    if (!modal) return;
    const on = modal.classList.toggle('immersive');
    showToast(on ? '沉浸阅读已开启' : '已退出沉浸阅读');
  }
  // 底部工具栏：常驻 / 收起为悬浮按钮
  function applyFooterMode(mode) {
    const footer = el('modal-footer');
    const fab = el('modal-footer-fab');
    if (!footer || !fab) return;
    const collapsed = mode === 'collapsed';
    footer.classList.toggle('collapsed', collapsed);
    fab.classList.toggle('hidden', !collapsed);
  }
  function setFooterMode(mode) {
    settings.modalFooter = mode;
    Store.saveSettings(settings);
    applyFooterMode(mode);
    showToast(mode === 'collapsed' ? '工具栏已收起，点击右下角按钮可展开' : '工具栏已常驻');
  }
  function moveFocus(dir) {
    const cards = document.querySelectorAll('#news-grid .card[data-key]');
    if (!cards.length) return;
    if (state.focusIndex == null) state.focusIndex = -1;
    state.focusIndex += dir;
    if (state.focusIndex < 0) state.focusIndex = 0;
    if (state.focusIndex >= cards.length) state.focusIndex = cards.length - 1;
    cards.forEach(c => c.classList.remove('focused'));
    const c = cards[state.focusIndex];
    c.classList.add('focused');
    c.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  function isTypingTarget(e) {
    const t = e.target;
    if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
  }
  function handleShortcut(e) {
    if (e.key === 'Escape') { closeArticleModal(); closeHotModal(); return; }
    if (isTypingTarget(e)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'r') { refresh('all'); return; }
    if (k === 'f' && currentModalItem) { toggleFavorite(currentModalItem); return; }
    if (k === 'j' || k === 'k') { moveFocus(k === 'j' ? 1 : -1); return; }
    if (k === '?') { showToast('快捷键：R 刷新 · J/K 切换 · F 收藏 · Esc 关闭'); return; }
  }

  // ---------- 绑定 ----------
  function bindUI() {
    el('top-nav').addEventListener('click', (e) => { if (e.target.dataset.page) switchPage(e.target.dataset.page); });

    el('region-tabs').addEventListener('click', (e) => { if (!e.target.dataset.region) return; setActive('region-tabs', e.target); state.filters.region = e.target.dataset.region; resetAndRenderNews(); });
    el('category-tabs').addEventListener('click', (e) => { if (!e.target.dataset.category) return; setActive('category-tabs', e.target); state.filters.category = e.target.dataset.category; resetAndRenderNews(); });
    el('grade-tabs').addEventListener('click', (e) => { if (!e.target.dataset.grade) return; setActive('grade-tabs', e.target); state.filters.grade = e.target.dataset.grade; resetAndRenderNews(); });
    el('tag-tabs').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      state.filters.tag = chip.dataset.tag || '';
      el('tag-tabs').querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === chip));
      resetAndRenderNews();
    });
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

    // 导出 / 批量已读 / 清空收藏
    const exportBtn = el('export-news-btn');
    if (exportBtn) exportBtn.addEventListener('click', exportNews);
    // 置顶开关（收藏 / 重点关注）
    const pinFavBtn = el('pin-fav-btn');
    const pinWatchBtn = el('pin-watch-btn');
    function syncPinBtns() {
      if (pinFavBtn) pinFavBtn.classList.toggle('active', settings.pinFavorites !== false);
      if (pinWatchBtn) pinWatchBtn.classList.toggle('active', settings.pinWatched !== false);
    }
    if (pinFavBtn) pinFavBtn.addEventListener('click', () => {
      settings.pinFavorites = settings.pinFavorites === false;
      Store.saveSettings(settings);
      syncPinBtns();
      renderNews({ animate: false });
    });
    if (pinWatchBtn) pinWatchBtn.addEventListener('click', () => {
      settings.pinWatched = settings.pinWatched === false;
      Store.saveSettings(settings);
      syncPinBtns();
      renderNews({ animate: false });
    });
    syncPinBtns();
    // 收藏页子页切换（新闻收藏 / 重点关注发布者）
    const favTabs = el('fav-tabs');
    if (favTabs) favTabs.addEventListener('click', (e) => {
      const b = e.target.closest('.seg-btn');
      if (!b) return;
      state.favTab = b.dataset.favtab || 'news';
      renderFavorites();
    });
    const markAllReadBtn = el('mark-all-read-btn');
    if (markAllReadBtn) markAllReadBtn.addEventListener('click', markAllRead);
    const clearFavsBtn = el('clear-favs-btn');
    if (clearFavsBtn) clearFavsBtn.addEventListener('click', () => {
      if (state.favorites.size === 0) { showToast('暂无收藏'); return; }
      if (confirm('确定清空全部收藏？此操作不可撤销。')) clearFavorites();
    });

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
    document.addEventListener('keydown', handleShortcut);

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
    bindAutoSave('set-font-size', '字号已保存');
    bindAutoSave('set-proxy-prefix', '代理前缀已保存');
    bindAutoSave('set-watchlist', '订阅关键词已保存');
    // 自动规则：添加规则
    const ruleAddBtn = el('rule-add');
    if (ruleAddBtn) ruleAddBtn.addEventListener('click', () => {
      const pattern = (el('rule-pattern').value || '').trim();
      if (!pattern) { showToast('请输入匹配规则'); return; }
      const field = el('rule-field').value;
      const action = el('rule-action').value;
      settings.rules = settings.rules || [];
      settings.rules.push({ id: 'r' + Date.now().toString(36), pattern, field, action, enabled: true });
      Store.saveSettings(settings);
      el('rule-pattern').value = '';
      renderRules();
      renderNews({ animate: false });
    });
    // LLM / TTS / RSSHub 设置自动保存
    bindAutoSave('set-llm-enabled', '智能助手已保存');
    bindAutoSave('set-llm-provider', '智能助手已保存');
    bindAutoSave('set-llm-key', '智能助手已保存');
    bindAutoSave('set-llm-base', '智能助手已保存');
    bindAutoSave('set-llm-model', '智能助手已保存');
    bindAutoSave('set-llm-brief-auto', '简报设置已保存');
    bindAutoSave('set-tts-provider', '语音设置已保存');
    bindAutoSave('set-tts-voice', '语音设置已保存');
    bindAutoSave('set-rsshub-base', 'RSSHub 设置已保存');
    el('set-fever-enabled').addEventListener('change', () => {
      persistSettings('Fever 设置已保存');
      if (window.electronAPI && window.electronAPI.restartFeverServer) window.electronAPI.restartFeverServer();
    });
    // 简报 / 翻译 / 朗读 / 沉浸阅读
    const briefBtn = el('brief-btn');
    if (briefBtn) briefBtn.addEventListener('click', generateBrief);
    const transBtn = el('modal-translate');
    if (transBtn) transBtn.addEventListener('click', translateCurrentArticle);
    const speakBtn = el('modal-speak');
    if (speakBtn) speakBtn.addEventListener('click', speakCurrentArticle);
    const stopSpeakBtn = el('modal-stop-speak');
    if (stopSpeakBtn) stopSpeakBtn.addEventListener('click', stopSpeak);
    const immersiveBtn = el('modal-immersive');
    if (immersiveBtn) immersiveBtn.addEventListener('click', toggleImmersive);
    const footerToggle = el('modal-footer-toggle');
    if (footerToggle) footerToggle.addEventListener('click', () => setFooterMode('collapsed'));
    const footerFab = el('modal-footer-fab');
    if (footerFab) footerFab.addEventListener('click', () => setFooterMode('docked'));
    const briefClose = el('brief-close');
    if (briefClose) briefClose.addEventListener('click', closeBriefModal);
    const briefBackdrop = el('brief-backdrop');
    if (briefBackdrop) briefBackdrop.addEventListener('click', closeBriefModal);
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
    el('opml-export-btn').addEventListener('click', exportOpml);
    el('opml-import-btn').addEventListener('click', importOpml);
    el('backup-btn').addEventListener('click', doBackup);
    el('restore-btn').addEventListener('click', doRestore);
    const clearDownloadsBtn = el('clear-downloads-btn');
    if (clearDownloadsBtn) clearDownloadsBtn.addEventListener('click', async () => {
      const r = await Store.clearDownloads();
      if (r && r.ok) {
        showToast('已清理 ' + (r.count || 0) + ' 个下载文档');
        const box = el('downloads-stats');
        if (box) box.textContent = '0 个文件 · 0 KB';
      } else {
        showToast('清理失败');
      }
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
      const mode = DataLayer.MODES[settings.fetchMode] || DataLayer.MODES.balanced;
      DataLayer.configure(Object.assign({}, mode, { proxyPrefix: settings.proxyPrefix || '' }));
    }
    applyFontSize();
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
    state.readKeys = await Store.loadReadState();
    state.sourceHealth = await Store.loadSourceHealth();
    state.tags = await Store.loadTags();
    userSources = await Store.loadUserSources();
    userSourceIds = new Set(userSources.map(s => s.id));
    if (userSources.length) SOURCES.NEWS_SOURCES = SOURCES.NEWS_SOURCES.concat(userSources);
    const cached = await Store.loadCachedNews();
    if (cached.length) { state.news = cached; }
    el('auto-refresh').checked = !!settings.autoRefresh;

    bindUI();
    renderSourceFilterChips();
    renderTagChips();
    renderHotTabs();
    renderHot();
    renderNews();
    renderSources();
    renderCalendar();
    setupAutoRefresh();

    if (settings.autoRefreshOnStart) refresh();
    // 启动后自动生成每日简报（可选，需启用 LLM）
    if (settings.llm && settings.llm.enabled && settings.llm.briefAuto) {
      setTimeout(generateBrief, 4000);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
