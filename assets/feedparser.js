/*
 * feedparser.js —— RSS 2.0 / Atom 解析器（零依赖，浏览器与 Node 通用）
 * ---------------------------------------------------------------
 * 专业说明：
 *   用纯字符串正则提取 <item>/<entry> 及其子字段，支持 CDATA、Atom 的
 *   <link href>、media:content / media:thumbnail / enclosure 封面图，
 *   以及描述里的首张 <img> 作为封面兜底。无第三方 XML 库，省体积、更稳。
 *
 * 通俗说明：
 *   各国新闻网站给的"机器可读新闻"是一段带标签的文字（RSS/Atom）。
 *   这段代码负责把这段"带标签文字"翻译成我们能用的：标题、链接、
 *   发布时间、摘要、封面图。任何一个源格式不全也不会崩溃。
 * ---------------------------------------------------------------
 */
(function (global) {
  'use strict';

  // 解码常见 HTML 实体
  function decode(str) {
    if (!str) return '';
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(parseInt(d, 10)))
      .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
      .trim();
  }

  // 把相对 URL 补成绝对 URL（基于文章链接或 RSS 源地址）
  function toAbsoluteUrl(url, base) {
    if (!url) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
    if (!base) return url;
    try { return new URL(url, base).href; } catch (_) { return url; }
  }

  // 把正文 HTML 里的 src/href 相对路径全部补全
  function resolveContentUrls(html, base) {
    if (!html || !base) return html;
    return html
      .replace(/src=["']([^"']+)["']/gi, (m, u) => 'src="' + toAbsoluteUrl(u, base) + '"')
      .replace(/href=["']([^"']+)["']/gi, (m, u) => 'href="' + toAbsoluteUrl(u, base) + '"');
  }

  // 取某个标签内的文本（兼容 CDATA）
  function tag(block, name) {
    const re = new RegExp('<' + name + '[^>]*>([\\s\\S]*?)<\\/' + name + '>', 'i');
    const m = block.match(re);
    if (!m) return '';
    let v = m[1];
    v = v.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
    return decode(v);
  }

  // 取链接：Atom 用 <link href>，RSS 用 <link>文本
  function getLink(block) {
    const attr = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
    if (attr) return decode(attr[1]);
    return tag(block, 'link');
  }

  // 取封面图：优先 media:content(图片) / media:thumbnail / enclosure(图片)，
  // 再退而求其次取 description / content:encoded / summary / content 里的第一张 <img>
  function getCover(block) {
    const patterns = [
      /<media:content[^>]*medium=["']image["'][^>]*url=["']([^"']+)["']/i,
      /<media:content[^>]*url=["']([^"']+)["'][^>]*medium=["']image["']/i,
      /<media:thumbnail[^>]*url=["']([^"']+)["']/i,
      /<enclosure[^>]*type=["']image[^"']*["'][^>]*url=["']([^"']+)["']/i,
      /<enclosure[^>]*url=["']([^"']+)["'][^>]*type=["']image[^"']*["']/i
    ];
    for (const p of patterns) {
      const m = block.match(p);
      if (m) return decode(m[1]);
    }
    // 很多 RSS 只在 content:encoded 里放首图，需要单独读取完整 HTML
    const desc = tag(block, 'content:encoded') || tag(block, 'description') ||
                 tag(block, 'summary') || tag(block, 'content');
    const img = desc.match(/<img[^>]+src=["']([^"']+)["']/i) ||
                desc.match(/<img[^>]+data-src=["']([^"']+)["']/i);
    if (img) return decode(img[1]);
    return '';
  }

  // 去 HTML 标签，得到纯文本摘要
  function stripHtml(html) {
    if (!html) return '';
    return decode(String(html)
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim());
  }

  // 统一时间字段 -> 毫秒时间戳（解析失败给 0，排序时排最后）
  function toTimestamp(block) {
    const raw = tag(block, 'pubDate') || tag(block, 'published') ||
                tag(block, 'updated') || tag(block, 'dc:date');
    if (!raw) return 0;
    const t = Date.parse(raw);
    return isNaN(t) ? 0 : t;
  }

  // 站点特定的正文容器选择器（域名 -> 选择器数组）
  const SITE_SELECTORS = {
    'france24.com': ['article .article__body', 'article', '[class*="article-body"]', '[class*="article__body"]', '.main-content'],
    'nasa.gov': ['.article-body', '.entry-content', '.content-area', 'article', '#main-content'],
    'reuters.com': ['article', '[data-testid="paragraph-0"]', '.article-body__content__', '[class*="article-body"]', '[class*="ArticleBody"]'],
    'apnews.com': ['.RichTextStoryBody', 'article', '[class*="RichText"]'],
    'bbc.com': ['article', '[data-component="text-block"]', '.ssrcss-pv1rh6-ArticleWrapper'],
    'cnn.com': ['article', '.article__content', '[class*="article-body"]', '.zn-body__paragraph'],
    'xinhuanet.com': ['article', '#detailContent', '.main', '[class*="content"]'],
    'people.com.cn': ['.text_con', '.box_con', '#rwb_zw'],
    'chinadaily.com.cn': ['#Content', '.article-content', 'article'],
    'ecns.cn': ['.content', '.article-content', 'article'],
    // 政府/央行/官方机构站点通常把正文放在 id=article / .container / .panel 里
    'federalreserve.gov': ['#article', '.container', '#main-content', '.panel panel-default', '.panel'],
    'whitehouse.gov': ['.briefing-room__body', '#main-content', 'article', '.body-content'],
    'home.treasury.gov': ['#main-content', '.press-release', 'article', '.body-content'],
    'ecb.europa.eu': ['.content', '#main-wrapper', 'article'],
    'ec.europa.eu': ['.ecl-paragraph', '#main-content', '.content'],
    'mofa.go.jp': ['#contents-main', '#main-content', '.contents'],
    'gov.uk': ['.govuk-grid-column-two-thirds', '#main-content', 'article'],
    'tass.com': ['.article__content', '.article-content', '.text-content', 'article', '#main-content', '.container'],
    'tass.ru': ['.article__content', '.article-content', '.text-content', 'article', '#main-content', '.container']
  };

  // 智能正文清理：只保留标题、发布者、时间、正文段落与相关图片
  // aggressive=false 用于 RSS description（保留摘要），aggressive=true 用于完整网页抓取
  function cleanArticleHtml(html, baseUrl, options) {
    options = options || {};
    const aggressive = options.aggressive !== false; // 默认激进
    if (!html || typeof DOMParser === 'undefined') return html || '';

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // 1) 直接移除非内容标签（音频/视频播放器、表单、画布、SVG 等）
    const removeTags = [
      'script', 'style', 'iframe', 'nav', 'header', 'footer', 'aside',
      'noscript', 'form', 'button', 'input', 'textarea', 'select',
      'svg', 'canvas', 'audio', 'video', 'embed', 'object', 'source', 'track'
    ];
    doc.querySelectorAll(removeTags.join(',')).forEach(el => el.remove());

    // 2) 按 ARIA 语义移除 banner/navigation/complementary 等区域
    doc.querySelectorAll('[role="banner"],[role="navigation"],[role="complementary"],[role="contentinfo"],[role="alert"],[role="search"]').forEach(el => el.remove());

    // 3) class/id 噪声词：导航、菜单、分享、评论、广告、推荐、工具栏、翻页等
    const noiseRe = /\b(nav|navbar|menu|menubar|sidebar|site-header|site-footer|page-header|page-footer|breadcrumb|toolbar|share|sharing|social|related|recommend|recommended|popular|trending|most-read|comments|comment|reply|newsletter|subscribe|follow|advertisement|ad-|ads-|adsby|promo|promotion|sponsor|affiliate|partner|cookie|consent|popup|modal|overlay|banner|widget|tagcloud|tags|metadata|meta-bar|author-bio|bio|pagination|pager|prev|next|toc|outline|index|jumpto|skip|accessibility|actions|utility|tools|copyright|license|disclaimer)\b/i;
    // 图标/Logo/水印类
    const logoRe = /\b(logo|icon|favicon|brand|symbol|badge|avatar|site-logo|header-logo|footer-logo|watermark|app-icon)\b/i;
    // 常见纯导航/工具文本开头（不区分大小写）
    const navTextRe = /^\s*(Explore This Section|In This Section|On This Page|Table of Contents|Jump to|Read More|More from|Also read|Related Articles|Related Stories|See Also|You might also like|Popular Now|Trending Now|Comments|Leave a Comment|Share This|Share on|Follow Us|Subscribe|Sign Up|Download|Listen|Transcript|Watch|Watch Now|Play Video|Audio Player|Print|Font Size|Next Article|Previous Article|Back to Top)/i;

    function walk(el) {
      const tag = el.tagName.toLowerCase();
      const cls = (el.getAttribute('class') || '');
      const id = (el.getAttribute('id') || '');
      const text = (el.innerText || '').trim();
      const combinedLower = (cls + ' ' + id).toLowerCase();

      // 命中噪声 class/id 直接删除
      if (noiseRe.test(cls + ' ' + id) || logoRe.test(cls + ' ' + id)) {
        el.remove(); return;
      }
      // 命中纯导航文本直接删除
      if (navTextRe.test(text)) { el.remove(); return; }

      // 删除「收听 / 下载 / 文字稿 / 播放 / 分享」等纯功能链接
      if (tag === 'a') {
        const t = text.replace(/\s+/g, ' ').toLowerCase();
        if (/^(listen|download|transcript|watch|play|audio|video|share)$/i.test(t) ||
            /^(收听|下载|文字稿|观看|播放|分享)$/i.test(t)) {
          el.remove(); return;
        }
      }

      // 删除明显是 Logo/图标/水印/小装饰的图片
      if (tag === 'img') {
        const src = (el.getAttribute('src') || '').toLowerCase();
        const alt = (el.getAttribute('alt') || '').toLowerCase();
        if (/logo|icon|favicon|brand|symbol|badge|avatar|watermark|button|sprite|svg/i.test(src + ' ' + alt + ' ' + combinedLower)) {
          el.remove(); return;
        }
        const w = parseInt(el.getAttribute('width'), 10) || 0;
        const h = parseInt(el.getAttribute('height'), 10) || 0;
        if ((w && w < 80) || (h && h < 80)) { el.remove(); return; }
      }

      // 激进模式：删除无意义短文本、链接占比过高的导航列表
      if (aggressive) {
        if (['p', 'div', 'span', 'section'].includes(tag) && el.querySelectorAll('img').length === 0) {
          if (text.length === 0) { el.remove(); return; }
          // 政府/机构站点的短句（如 "For release at 4:30 p.m. EDT"）往往是正文，阈值放低到 15 字符
          if (text.length < 15 && !/[。！？.?!]/.test(text)) { el.remove(); return; }
        }
        const links = el.querySelectorAll('a');
        // 仅当链接明显占主导（>75%）且不是富文本段落时才删，避免误伤含邮件/分享链接的短新闻
        if (links.length >= 2 && text.length > 0 && text.length < 400) {
          const linkText = Array.from(links).reduce((s, a) => s + (a.innerText || '').length, 0);
          if (linkText / text.length > 0.75) { el.remove(); return; }
        }
      }

      Array.from(el.children).forEach(child => walk(child));
    }

    Array.from(doc.body.children).forEach(child => walk(child));

    // 4) 图片/链接相对路径补全，清理会破坏排版的属性
    doc.querySelectorAll('img').forEach(img => {
      const raw = img.getAttribute('src') ||
                  img.getAttribute('data-src') ||
                  img.getAttribute('data-original') ||
                  img.getAttribute('data-lazy-src') || '';
      if (raw) img.setAttribute('src', toAbsoluteUrl(raw, baseUrl));
      ['srcset', 'sizes', 'loading', 'style', 'width', 'height'].forEach(a => img.removeAttribute(a));
    });
    doc.querySelectorAll('a').forEach(a => {
      const href = a.getAttribute('href');
      if (href) a.setAttribute('href', toAbsoluteUrl(href, baseUrl));
    });
    doc.querySelectorAll('*[style]').forEach(el => {
      if (el.tagName === 'IMG') return;
      const style = el.getAttribute('style') || '';
      if (/position\s*:\s*(fixed|absolute)/i.test(style) || /float\s*:/i.test(style) || /transform\s*:/i.test(style)) {
        el.removeAttribute('style');
      }
    });

    // 5) 清理后删除空容器
    doc.querySelectorAll('p, div, section, li, h1, h2, h3, h4, h5, h6, figcaption').forEach(el => {
      if ((el.innerText || '').trim().length === 0 && el.querySelectorAll('img').length === 0) el.remove();
    });

    return doc.body.innerHTML;
  }

  // 从文章原网页提取正文（RSS 经常只给摘要，需要二次抓取）
  // options.clean = false 时只选择正文容器并补全 URL，不做智能噪声清理（供设置关闭清理时使用）
  function extractArticle(html, baseUrl, options) {
    options = options || {};
    const doClean = options.clean !== false;
    if (!html || typeof DOMParser === 'undefined') return '';

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // 1) 先移除全页通用噪声，但避免误删嵌套在正文容器内的同类标签（如 <article> 内的小 <header>）
    const contentSelectors = 'article, [itemprop="articleBody"], .article-body, .article__body, .article-content, .article-text, .post-content, .entry-content, .content-body, .story-body, .main-content, #article-body, #main-content, .body-content';
    const noiseSelectors = [
      'script', 'style', 'iframe', 'nav', 'header', 'footer', 'aside',
      'noscript', 'form', 'button', 'input', 'textarea', 'select',
      '[role="banner"]', '[role="navigation"]', '[role="complementary"]',
      '.share', '.sharing', '.social', '.social-share', '.related', '.comments',
      '.newsletter', '.subscribe', '.advertisement', '.ad', '.promo', '.sidebar',
      '.breadcrumb', '.tags', '.meta', '.author-bio', '.pagination',
      '[class*="related-"]', '[class*="comment"]', '[class*="share-"]',
      '[id*="disqus"]', '[class*="disqus"]', '[class*="newsletter"]'
    ];
    doc.querySelectorAll(noiseSelectors.join(',')).forEach(el => {
      if (!el.closest(contentSelectors)) el.remove();
    });

    // 2) 常见正文容器选择器（按优先级）
    const genericSelectors = [
      'article',
      '[itemprop="articleBody"]',
      '.article-body', '.article__body', '.article-content', '.article-text',
      '.post-content', '.entry-content', '.content-body', '.story-body',
      '.main-content', '#article-body', '#main-content', '.body-content'
    ];

    let selectors = genericSelectors;
    try {
      const host = new URL(baseUrl).hostname.replace(/^www\./, '');
      for (const domain of Object.keys(SITE_SELECTORS)) {
        if (host.endsWith(domain)) {
          selectors = SITE_SELECTORS[domain].concat(genericSelectors);
          break;
        }
      }
    } catch (_) { /* ignore */ }

    // 2/3) 在所有候选（站点特定选择器 + 通用选择器 +  div/section/main）中
    // 按 "文本长度 + 段落数" 打分，取最高分作为正文容器，避免首个命中但过小
    let best = null;
    let maxScore = 0;
    function scoreEl(el) {
      if (!el) return 0;
      if (el.closest('header, footer, nav, aside')) return 0;
      const text = (el.innerText || '').trim();
      const paras = el.querySelectorAll('p').length;
      if (text.length < 60 || paras < 1) return 0;
      return text.length + paras * 300;
    }
    const seen = new Set();
    for (const sel of selectors) {
      try {
        const el = doc.querySelector(sel);
        if (!el || seen.has(el)) continue;
        seen.add(el);
        const s = scoreEl(el);
        if (s > maxScore) { maxScore = s; best = el; }
      } catch (_) { /* invalid selector in older engines */ }
    }
    // 若站点选择器得分不高，再用通用块兜底
    if (!best || maxScore < 2000) {
      for (const el of doc.querySelectorAll('div, section, main')) {
        if (seen.has(el)) continue;
        const s = scoreEl(el);
        if (s > maxScore) { maxScore = s; best = el; }
      }
    }

    if (!best) return '';

    // 4) 用智能清理器二次过滤，仅保留正文段落与相关图片
    let cleaned = doClean ? cleanArticleHtml(best.innerHTML, baseUrl, { aggressive: true }) : best.innerHTML;
    let text = stripHtml(cleaned).trim();

    // 5) 激进清洗后正文过短，说明可能误删了内容，回退到轻量清洗
    if (doClean && text.length < 160) {
      cleaned = cleanArticleHtml(best.innerHTML, baseUrl, { aggressive: false });
      text = stripHtml(cleaned).trim();
    }
    // 仍过短，则回退到原始容器 HTML（通用噪声已在前面移除，保留全部正文）
    if (doClean && text.length < 80) {
      cleaned = resolveContentUrls(best.innerHTML, baseUrl);
      text = stripHtml(cleaned).trim();
    }

    // 6) 不做清理时仍需补全 URL、清理危险内联样式
    if (!doClean) {
      const tmp = parser.parseFromString('<div id="__tmp__">' + cleaned + '</div>', 'text/html');
      const wrap = tmp.getElementById('__tmp__');
      wrap.querySelectorAll('img').forEach(img => {
        const raw = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazy-src') || '';
        if (raw) img.setAttribute('src', toAbsoluteUrl(raw, baseUrl));
        ['srcset', 'sizes', 'loading', 'style', 'width', 'height'].forEach(a => img.removeAttribute(a));
      });
      wrap.querySelectorAll('a').forEach(a => {
        const href = a.getAttribute('href');
        if (href) a.setAttribute('href', toAbsoluteUrl(href, baseUrl));
      });
      wrap.querySelectorAll('*[style]').forEach(el => {
        if (el.tagName === 'IMG') return;
        const style = el.getAttribute('style') || '';
        if (/position\s*:\s*(fixed|absolute)/i.test(style) || /float\s*:/i.test(style) || /transform\s*:/i.test(style)) {
          el.removeAttribute('style');
        }
      });
      return wrap.innerHTML;
    }

    // 7) 最终校验：即便回退后仍几乎无内容，才认为抓取失败
    if (text.length < 40) return '';

    return cleaned;
  }

  // 解析整段 XML -> 归一化条目数组
  function parseFeed(xml, meta) {
    if (!xml || typeof xml !== 'string') return [];
    const items = [];
    // RSS 用 <item>，Atom 用 <entry>
    const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ||
                   xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];

    for (const block of blocks) {
      const title = tag(block, 'title');
      if (!title) continue;
      const link = getLink(block);
      // 优先用文章链接作为基准，解析正文/图片中的相对 URL
      const baseUrl = link || (meta ? meta.url : '');
      const ts = toTimestamp(block);
      const summaryRaw = tag(block, 'description') || tag(block, 'summary') ||
                         tag(block, 'content');
      const summary = stripHtml(summaryRaw).slice(0, 160);
      // content 保留原始 HTML（优先 content:encoded，其次是 description/summary/content）
      const contentRaw = tag(block, 'content:encoded') || tag(block, 'description') ||
                         tag(block, 'summary') || tag(block, 'content');
      const content = resolveContentUrls(contentRaw, baseUrl);
      const cover = toAbsoluteUrl(getCover(block), baseUrl);
      items.push({
        title: title,
        link: link,
        timestamp: ts,
        dateText: ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '',
        summary: summary,
        content: content,
        cover: cover,
        // 以下来自信源配置（一手元数据）
        source: meta.name,
        sourceId: meta.id,
        grade: meta.grade,
        region: meta.region,
        categories: meta.categories || [],
        lang: meta.lang || ''
      });
    }
    return items;
  }

  const API = { parseFeed, stripHtml, decode, extractArticle, cleanArticleHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.FeedParser = API;
})(typeof window !== 'undefined' ? window : globalThis);
