// ============================================================
// 地图模块备份（开发中暂不出现在编译版本）
// ============================================================
// 说明：
// 该文件保存了原先内嵌在 assets/app.js 中的完整地图功能代码。
// 当前地图页显示「正在开发」占位，本文件不参与 asar 打包，
// 因此不会增加安装包体积，也不会在运行时加载腾讯地图 SDK。
//
// 当地图功能重新开发时，可将此代码整体合并回 app.js（或重构为 ES 模块），
// 并恢复 index.html 中 #page-map 内的地图容器、控制开关和图例。
//
// 注意：以下代码依赖 app.js 闭包内的以下符号，合并时需要确保可访问：
//   el, settings, SOURCES, Store, escapeHtml, formatTime, sourceWebsite,
//   openLink, openArticleModal, POLITICAL_LEAN_NAMES, REGION_NAMES
// ============================================================

// ---------- 地图 ----------
let mapObj = null, mapScriptLoading = false, geoLimit = 200;
let mapLayers = { news: null, pubs: null, labels: null, flags: null, boundaries: null, infoWindow: null };
let mapState = { showNames: true, showFlags: false, showPubs: true, showBoundaries: false, hoverNewsId: null, hoverPubId: null };
let mapGeoCache = {}; // city -> {lat, lng}
let mapFlagGeometries = []; // 国旗图层原始 geometries，用于开关切换

// 世界主要国家/地区标注（用于「国家名称/国旗」开关）
const MAP_COUNTRIES = [
  { name: '中国', code: 'CN', lat: 35.86, lng: 104.19, flag: '🇨🇳' },
  { name: '美国', code: 'US', lat: 39.83, lng: -98.58, flag: '🇺🇸' },
  { name: '俄罗斯', code: 'RU', lat: 61.52, lng: 105.32, flag: '🇷🇺' },
  { name: '日本', code: 'JP', lat: 36.20, lng: 138.25, flag: '🇯🇵' },
  { name: '德国', code: 'DE', lat: 51.17, lng: 10.45, flag: '🇩🇪' },
  { name: '英国', code: 'GB', lat: 55.38, lng: -3.44, flag: '🇬🇧' },
  { name: '法国', code: 'FR', lat: 46.23, lng: 2.21, flag: '🇫🇷' },
  { name: '印度', code: 'IN', lat: 20.59, lng: 78.96, flag: '🇮🇳' },
  { name: '巴西', code: 'BR', lat: -14.24, lng: -51.93, flag: '🇧🇷' },
  { name: '加拿大', code: 'CA', lat: 56.13, lng: -106.35, flag: '🇨🇦' },
  { name: '澳大利亚', code: 'AU', lat: -25.27, lng: 133.78, flag: '🇦🇺' },
  { name: '韩国', code: 'KR', lat: 35.91, lng: 127.77, flag: '🇰🇷' },
  { name: '意大利', code: 'IT', lat: 41.87, lng: 12.57, flag: '🇮🇹' },
  { name: '西班牙', code: 'ES', lat: 40.46, lng: -3.75, flag: '🇪🇸' },
  { name: '墨西哥', code: 'MX', lat: 23.63, lng: -102.55, flag: '🇲🇽' },
  { name: '印度尼西亚', code: 'ID', lat: -0.79, lng: 113.92, flag: '🇮🇩' },
  { name: '沙特阿拉伯', code: 'SA', lat: 23.89, lng: 45.08, flag: '🇸🇦' },
  { name: '土耳其', code: 'TR', lat: 38.96, lng: 35.24, flag: '🇹🇷' },
  { name: '南非', code: 'ZA', lat: -30.56, lng: 22.94, flag: '🇿🇦' },
  { name: '埃及', code: 'EG', lat: 26.82, lng: 30.80, flag: '🇪🇬' }
];

function svgMarkerUrl(color, size, stroke) {
  const s = size || 20;
  const half = s / 2;
  const r = half - 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><circle cx="${half}" cy="${half}" r="${r}" fill="${color}" stroke="${stroke || '#ffffff'}" stroke-width="2"/></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
function loadScript(src, timeoutMs) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    let done = false;
    const timer = timeoutMs ? setTimeout(() => {
      if (!done) { done = true; try { s.remove(); } catch (_) {} rej(new Error('脚本加载超时，请检查网络或 Key 是否被拦截')); }
    }, timeoutMs) : null;
    s.onload = () => { if (!done) { done = true; if (timer) clearTimeout(timer); res(); } };
    s.onerror = () => { if (!done) { done = true; if (timer) clearTimeout(timer); rej(new Error('脚本加载失败，请检查网络或域名白名单')); } };
    document.head.appendChild(s);
  });
}
function detectLocation(title) {
  return SOURCES.detectLocation(title);
}
async function initMap() {
  const key = settings.geo.apiKey;
  const box = el('map');
  if (!key) {
    box.innerHTML = '<div class="placeholder">地图需要 API Key。请到「设置 → 地图 API」填入你申请的腾讯地图（或高德/天地图）Key。</div>';
    return;
  }
  if (typeof TMap === 'undefined') {
    if (mapScriptLoading) return;
    mapScriptLoading = true;
    try {
      await loadScript('https://map.qq.com/api/gljs?v=1.exp&key=' + encodeURIComponent(key) + '&libraries=service', 20000);
    } catch (e) {
      box.innerHTML = '<div class="placeholder">地图 SDK 加载失败，请检查网络或 Key。</div>';
      mapScriptLoading = false; return;
    }
    mapScriptLoading = false;
  }
  if (!mapObj) {
    const mapOptions = { zoom: 2, center: new TMap.LatLng(25, 10) };
    const styleId = settings.geo && settings.geo.mapStyleId;
    if (styleId) {
      try { mapOptions.mapStyleId = styleId; } catch (_) {}
    }
    mapObj = new TMap.Map('map', mapOptions);
    bindMapControls();
    createMapLayers();
  } else {
    mapObj.resize && mapObj.resize();
  }
  renderMapMarkers();
}

function createMapLayers() {
  if (!mapObj || typeof TMap === 'undefined') return;
  const newsIcon = svgMarkerUrl('#ff9f0a', 20, '#ffffff');
  const newsHlIcon = svgMarkerUrl('#ffd60a', 30, '#ffffff');
  const newsDimIcon = svgMarkerUrl('#ff9f0a', 16, 'rgba(255,255,255,0.3)');
  const pubIcon = svgMarkerUrl('#0a84ff', 18, '#ffffff');
  const pubHlIcon = svgMarkerUrl('#64d2ff', 28, '#ffffff');
  const pubDimIcon = svgMarkerUrl('#0a84ff', 14, 'rgba(255,255,255,0.3)');

  mapLayers.news = new TMap.MultiMarker({
    map: mapObj, id: 'news-layer',
    styles: {
      news: new TMap.MarkerStyle({ width: 20, height: 20, anchor: { x: 10, y: 10 }, src: newsIcon }),
      hl: new TMap.MarkerStyle({ width: 30, height: 30, anchor: { x: 15, y: 15 }, src: newsHlIcon }),
      dim: new TMap.MarkerStyle({ width: 16, height: 16, anchor: { x: 8, y: 8 }, src: newsDimIcon, opacity: 0.35 })
    },
    geometries: []
  });
  mapLayers.pubs = new TMap.MultiMarker({
    map: mapObj, id: 'pubs-layer',
    styles: {
      pub: new TMap.MarkerStyle({ width: 18, height: 18, anchor: { x: 9, y: 9 }, src: pubIcon }),
      hl: new TMap.MarkerStyle({ width: 28, height: 28, anchor: { x: 14, y: 14 }, src: pubHlIcon }),
      dim: new TMap.MarkerStyle({ width: 14, height: 14, anchor: { x: 7, y: 7 }, src: pubDimIcon, opacity: 0.35 })
    },
    geometries: []
  });

  // 国家名称标签：深色文字 + 浅色描边，确保在浅色地图上可见
  mapLayers.labels = new TMap.MultiLabel({
    map: mapObj, id: 'country-labels',
    styles: {
      country: new TMap.LabelStyle({
        color: '#1c1c1e', size: 14, offset: { x: 0, y: 0 },
        alignment: 'center', verticalAlignment: 'middle',
        strokeColor: 'rgba(255,255,255,0.92)', strokeWidth: 3
      })
    },
    geometries: MAP_COUNTRIES.map(c => ({
      id: 'lbl_' + c.code,
      styleId: 'country',
      position: new TMap.LatLng(c.lat, c.lng),
      content: c.name
    }))
  });

  // 国旗标签：统一先创建在地图上，通过 geometries 切换控制显隐
  mapFlagGeometries = MAP_COUNTRIES.map(c => ({
    id: 'flag_' + c.code,
    styleId: 'flag',
    position: new TMap.LatLng(c.lat, c.lng),
    content: c.flag
  }));
  mapLayers.flags = new TMap.MultiLabel({
    map: mapObj, id: 'country-flags',
    styles: {
      flag: new TMap.LabelStyle({
        color: '#1c1c1e', size: 16, offset: { x: 0, y: -18 },
        alignment: 'center', verticalAlignment: 'bottom',
        strokeColor: 'rgba(255,255,255,0.85)', strokeWidth: 2
      })
    },
    geometries: mapState.showFlags ? mapFlagGeometries : []
  });

  mapLayers.infoWindow = new TMap.InfoWindow({
    map: mapObj, enableCustom: true,
    position: new TMap.LatLng(0, 0),
    offset: { x: 0, y: -20 },
    content: ''
  });
  mapLayers.infoWindow.close();

  // 新闻标记交互
  mapLayers.news.on('mouseover', (e) => {
    const geo = e && e.geometry;
    if (!geo) return;
    mapState.hoverNewsId = geo.id;
    mapState.hoverPubId = null;
    updateMapStyles();
    showMapInfo(geo.properties && geo.properties.item, geo.position);
  });
  mapLayers.news.on('mouseout', () => {
    mapState.hoverNewsId = null;
    updateMapStyles();
    if (mapLayers.infoWindow) mapLayers.infoWindow.close();
  });
  mapLayers.news.on('click', (e) => {
    const item = e && e.geometry && e.geometry.properties && e.geometry.properties.item;
    if (item) openArticleModal(item);
  });

  // 发布者标记交互
  mapLayers.pubs.on('mouseover', (e) => {
    const geo = e && e.geometry;
    if (!geo) return;
    mapState.hoverPubId = geo.id;
    mapState.hoverNewsId = null;
    updateMapStyles();
    showPubMapInfo(geo.properties && geo.properties.source, geo.position);
  });
  mapLayers.pubs.on('mouseout', () => {
    mapState.hoverPubId = null;
    updateMapStyles();
    if (mapLayers.infoWindow) mapLayers.infoWindow.close();
  });
  mapLayers.pubs.on('click', (e) => {
    const src = e && e.geometry && e.geometry.properties && e.geometry.properties.source;
    const url = sourceWebsite(src);
    if (url) openLink(url);
  });
}

function updateMapStyles() {
  if (!mapLayers.news || !mapLayers.pubs) return;
  const hid = mapState.hoverNewsId;
  const pid = mapState.hoverPubId;

  // 悬停新闻时：该新闻高亮，其它新闻变暗；关联发布者高亮，其它发布者变暗
  const hoveredNews = hid ? mapLayers.news.getGeometries().find(g => g.id === hid) : null;
  const hoveredItem = hoveredNews && hoveredNews.properties && hoveredNews.properties.item;
  const relatedPubId = hoveredItem && hoveredItem.sourceId ? 'pub_' + hoveredItem.sourceId : null;

  // 悬停发布者时：该发布者高亮，其它发布者变暗；所有新闻变暗（避免遮挡）
  mapLayers.news.setGeometries(mapLayers.news.getGeometries().map(g => ({
    ...g,
    styleId: (!hid && !pid ? 'news' : (g.id === hid ? 'hl' : 'dim'))
  })));
  mapLayers.pubs.setGeometries(mapLayers.pubs.getGeometries().map(g => ({
    ...g,
    styleId: (!hid && !pid ? 'pub' : (g.id === (pid || relatedPubId) ? 'hl' : 'dim'))
  })));
}

function showMapInfo(item, position) {
  if (!item || !mapLayers.infoWindow) return;
  const src = SOURCES.NEWS_SOURCES.find(s => s.id === item.sourceId) || {};
  const country = (src.profile && src.profile.country) || '未知';
  const loc = detectLocation(item.title);
  const locName = loc ? loc.name : '未知';
  const html = `<div class="tmap-info-card">
    <div class="title">${escapeHtml(item.title)}</div>
    <div class="meta">
      <span>发布者：${escapeHtml(item.source || '未知')}</span><br/>
      <span>国家：${escapeHtml(country)}</span>
      <span>识别地点：${escapeHtml(locName)}</span><br/>
      <span>时间：${escapeHtml(formatTime(item.timestamp))}</span>
    </div>
    <div class="actions">
      <button onclick="window.__openMapArticle('${item.link || ''}')">阅读全文</button>
      <button class="secondary" onclick="window.__openMapLink('${item.link || ''}')">原文链接</button>
    </div>
  </div>`;
  mapLayers.infoWindow.setPosition(position);
  mapLayers.infoWindow.setContent(html);
  mapLayers.infoWindow.open();
}

function showPubMapInfo(src, position) {
  if (!src || !mapLayers.infoWindow) return;
  const p = src.profile || {};
  const lean = POLITICAL_LEAN_NAMES[p.politicalLean] || p.politicalLean || '未知';
  const html = `<div class="tmap-info-card">
    <div class="title">${escapeHtml(src.name)}</div>
    <div class="meta">
      <span>国家：${escapeHtml(p.country || '未知')}</span><br/>
      <span>全称：${escapeHtml(p.fullName || src.name)}</span><br/>
      <span>倾向：${escapeHtml(lean)}</span><br/>
      <span>等级：${escapeHtml(src.grade || '未知')}</span>
    </div>
    <div class="actions">
      <button onclick="window.__openMapSource('${src.id || ''}')">访问官网</button>
    </div>
  </div>`;
  mapLayers.infoWindow.setPosition(position);
  mapLayers.infoWindow.setContent(html);
  mapLayers.infoWindow.open();
}

window.__openMapSource = (id) => {
  const src = SOURCES.NEWS_SOURCES.find(s => s.id === id);
  if (src) openLink(sourceWebsite(src));
};

window.__openMapArticle = (link) => {
  const item = state.news.find(it => it.link === link);
  if (item) openArticleModal(item);
};
window.__openMapLink = (link) => { if (link) openLink(link); };

function bindMapControls() {
  const namesCb = el('map-show-names');
  const flagsCb = el('map-show-flags');
  const pubsCb = el('map-show-pubs');
  const boundariesCb = el('map-show-boundaries');
  if (namesCb) namesCb.addEventListener('change', (e) => {
    mapState.showNames = e.target.checked;
    if (mapLayers.labels) mapLayers.labels.setMap(mapState.showNames ? mapObj : null);
  });
  if (flagsCb) flagsCb.addEventListener('change', (e) => {
    mapState.showFlags = e.target.checked;
    if (mapLayers.flags) {
      // 通过 setGeometries 切换国旗显隐，兼容性最好
      mapLayers.flags.setGeometries(mapState.showFlags ? mapFlagGeometries : []);
    }
  });
  if (pubsCb) pubsCb.addEventListener('change', (e) => {
    mapState.showPubs = e.target.checked;
    if (mapLayers.pubs) mapLayers.pubs.setMap(mapState.showPubs ? mapObj : null);
  });
  if (boundariesCb) boundariesCb.addEventListener('change', (e) => {
    mapState.showBoundaries = e.target.checked;
    toggleBoundaryLayer();
  });
}

async function renderMapMarkers() {
  if (!mapObj || typeof TMap === 'undefined') return;
  if (!mapLayers.news) createMapLayers();

  // 发布者标记（蓝）
  const pubGeoms = [];
  for (const s of SOURCES.NEWS_SOURCES) {
    const c = SOURCES.getSourceCoords(s);
    if (c) pubGeoms.push({ id: 'pub_' + s.id, styleId: 'pub', position: new TMap.LatLng(c[0], c[1]), properties: { source: s } });
  }
  if (mapLayers.pubs) {
    mapLayers.pubs.setGeometries(pubGeoms);
    mapLayers.pubs.setMap(mapState.showPubs ? mapObj : null);
  }

  // 新闻地点标记（橙）
  // 优先从标题识别具体地点；未识别则兜底到发布者总部所在国家，确保每条新闻都有标记
  const newsGeoms = [];
  const used = new Set(); // 避免同一坐标大量堆叠：相同坐标仅保留前几条
  const cappedItems = state.news.slice(0, 200);
  for (const it of cappedItems) {
    let loc = detectLocation(it.title);
    let approx = false;
    if (!loc) {
      const src = SOURCES.NEWS_SOURCES.find(s => s.id === it.sourceId);
      const c = src && SOURCES.getSourceCoords(src);
      if (!c) continue;
      loc = { name: (src.profile && src.profile.country) || '未知', lat: c[0], lng: c[1] };
      approx = true;
    }
    const key = loc.lat.toFixed(1) + ',' + loc.lng.toFixed(1);
    if (used.has(key)) continue; // 同一网格只保留一条，减少视觉堆叠
    used.add(key);
    newsGeoms.push({
      id: 'news_' + newsGeoms.length,
      styleId: 'news',
      position: new TMap.LatLng(loc.lat, loc.lng),
      properties: { item: it, locName: loc.name, approx }
    });
  }
  if (mapLayers.news) mapLayers.news.setGeometries(newsGeoms);

  // 国家名称/国旗图层根据开关显隐
  if (mapLayers.labels) mapLayers.labels.setMap(mapState.showNames ? mapObj : null);
  if (mapLayers.flags) mapLayers.flags.setGeometries(mapState.showFlags ? mapFlagGeometries : []);

  // 行政边界
  toggleBoundaryLayer();
}

async function loadBoundaryLayer() {
  if (mapLayers.boundaries || !window.electronAPI || !window.electronAPI.storage) return;
  try {
    const raw = await window.electronAPI.storage.read('world_boundaries.geojson');
    if (!raw) return;
    const geojson = JSON.parse(raw);
    if (!geojson || !Array.isArray(geojson.features)) return;

    const geometries = [];
    geojson.features.forEach((f, idx) => {
      if (!f.geometry) return;
      const rings = [];
      if (f.geometry.type === 'Polygon') {
        f.geometry.coordinates.forEach(ring => rings.push(ring.map(c => new TMap.LatLng(c[1], c[0]))));
      } else if (f.geometry.type === 'MultiPolygon') {
        f.geometry.coordinates.forEach(poly => {
          poly.forEach(ring => rings.push(ring.map(c => new TMap.LatLng(c[1], c[0]))));
        });
      }
      if (rings.length) {
        geometries.push({
          id: 'boundary_' + idx,
          paths: rings,
          properties: f.properties || {}
        });
      }
    });

    if (!geometries.length) return;
    mapLayers.boundaries = new TMap.MultiPolygon({
      map: mapObj, id: 'boundary-layer',
      styles: {
        boundary: new TMap.PolygonStyle({
          color: 'rgba(10, 132, 255, 0.08)',
          showBorder: true,
          borderColor: 'rgba(10, 132, 255, 0.55)',
          borderWidth: 1
        })
      },
      geometries: geometries.map(g => ({ ...g, styleId: 'boundary' }))
    });
  } catch (e) {
    console.error('[loadBoundaryLayer]', e && e.message);
  }
}

async function toggleBoundaryLayer() {
  const hint = el('map-boundary-hint');
  if (!mapState.showBoundaries) {
    if (mapLayers.boundaries) mapLayers.boundaries.setMap(null);
    if (hint) hint.classList.add('hidden');
    return;
  }
  if (!mapLayers.boundaries) await loadBoundaryLayer();
  if (mapLayers.boundaries) {
    mapLayers.boundaries.setMap(mapObj);
    if (hint) hint.classList.add('hidden');
  } else {
    if (hint) hint.classList.remove('hidden');
  }
}

// 设置页中验证地图 Key 的函数（与地图模块一起暂存）
async function verifyGeoKey() {
  const key = el('set-geo-key').value.trim();
  const res = el('geo-verify-result');
  const setRes = (text, isError) => {
    console.log('[verifyGeoKey]', text);
    if (res) { res.textContent = text; res.style.color = isError ? 'var(--danger)' : 'var(--P0)'; }
    if (!res || isError) window.alert(text);
  };
  if (!key) { setRes('请先填入 Key', true); return; }
  setRes('验证中…', false);
  try {
    await loadScript('https://map.qq.com/api/gljs?v=1.exp&key=' + encodeURIComponent(key) + '&libraries=service', 15000);
    if (typeof TMap === 'undefined' || !TMap.service) {
      throw new Error('SDK 未就绪：地图脚本加载后被拦截，或 Key 未启用「地图 JavaScript API GL」');
    }
    const gc = new TMap.service.Geocoder({ key });
    const geoRes = await Promise.race([
      gc.getLocation({ address: '北京' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('地理编码请求超时')), 15000))
    ]);
    console.log('[verifyGeoKey] geocoder response:', geoRes);
    if (geoRes && geoRes.status === 0 && geoRes.result && geoRes.result.location) {
      setRes('Key 有效 ✓', false);
    } else if (geoRes && geoRes.status !== undefined) {
      throw new Error('地理编码返回错误：' + (geoRes.message || ('status=' + geoRes.status)) + '，请确认 Key 已启用 WebServiceAPI 且域名白名单留空');
    } else {
      throw new Error('地理编码返回异常，无法解析坐标');
    }
  } catch (e) {
    setRes('验证失败：' + (e && e.message || '未知错误'), true);
  }
}

// 使用示例（合并回 app.js 后）：
//   在 switchPage 中恢复：if (page === 'map') initMap();
//   在 bindUI 中恢复：el('geo-verify').addEventListener('click', verifyGeoKey);
//   在 renderSettings 中恢复：Store.getGeoUsage().then(...)
