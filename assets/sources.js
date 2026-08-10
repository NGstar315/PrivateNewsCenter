/*
 * sources.js —— 信源配置（可自由增删）
 * ---------------------------------------------------------------
 * 本文件集中管理所有新闻源与热搜源。每个源包含：
 *   id        唯一标识
 *   name      界面显示的名称（发布者 / 机构）
 *   grade     信源等级：P0 一手信源 / P1 可靠信源 / P2 参考信源
 *   region    地区：cn 国内 / us 美国 / uk 英国 / eu 欧盟 / jp 日本 / intl 国际机构
 *   categories 分类（与界面筛选对应）：
 *             politics 时政·国际 / finance 财经·经济 / tech 科技·数码 / society 社会·民生·健康
 *   url       抓取地址（RSS 2.0 / Atom / JSON）
 *   lang      语言（仅作展示）
 *   profile   发布者/机构介绍（背景、国家、政治倾向、LOGO 等）
 *
 * 分级规则（对应"一手信源优先"）：
 *   P0 一手信源：各国政府 / 官方机构发布、权威媒体官方首发
 *   P1 可靠信源：主流通讯社、知名媒体（非一手但高度可信）
 *   P2 参考信源：聚合平台、社媒热点、转载（热搜榜等），仅供参考
 *
 * 加 / 删信源：照葫芦画瓢改本文件即可，无需懂编程（详见 README）。
 * 注：下列 URL 均已实测可用；个别官网可能改版，若长期抓不到，更新其 url。
 * ---------------------------------------------------------------
 */

const CATEGORY_NAMES = {
  politics:    '时政·国际',
  finance:     '财经·经济',
  tech:        '科技·数码',
  society:     '社会·民生·健康',
  // —— 新增一级分类（v10）——
  sports:      '体育',
  culture:     '文化·娱乐',
  education:   '教育',
  defense:     '军事·防务',
  environment: '环境·气候',
  science:     '科学',
  travel:      '旅游',
  auto:        '汽车',
  gaming:      '游戏·电竞',
  realestate:  '房产'
};

const REGION_NAMES = {
  cn:   '国内',
  us:   '美国',
  uk:   '英国',
  eu:   '欧盟',
  jp:   '日本',
  intl: '国际机构'
};

const POLITICAL_LEAN_NAMES = {
  official: '官方',
  neutral:  '中立',
  left:     '偏左',
  right:    '偏右',
  liberal:  '自由派',
  state:    '国营'
};

// 公开 CORS 代理回退（用于部分国际源被网络拦截时重试；仅作为备用，不保证实时可用）
function proxy(url) {
  return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url);
}

/* ====================== 新闻源（RSS / Atom） ====================== */
const NEWS_SOURCES = [
  /* ---------- 国内（中国） ---------- */
  {
    id: 'xinhua-politics', name: '新华网·时政', grade: 'P0', region: 'cn',
    categories: ['politics'], lang: '中文',
    url: 'http://www.xinhuanet.com/politics/news_politics.xml',
    profile: {
      fullName: '新华网',
      country: '中国',
      politicalLean: 'official',
      background: '新华社主办的国家级综合新闻网站，中国官方权威新闻发布平台之一，时政类一手信源。',
      logo: 'https://www.xinhuanet.com/favicon.ico'
    }
  },
  {
    id: 'people-politics', name: '人民日报·时政', grade: 'P0', region: 'cn',
    categories: ['politics', 'society'], lang: '中文',
    url: 'http://www.people.com.cn/rss/politics.xml',
    profile: {
      fullName: '人民日报',
      country: '中国',
      politicalLean: 'official',
      background: '中国共产党中央委员会机关报，中国最具权威性的官方媒体，时政与社会政策一手信源。',
      logo: 'http://www.people.com.cn/favicon.ico'
    }
  },
  {
    id: 'ecns-china', name: '中国新闻网(英文)', grade: 'P1', region: 'cn',
    categories: ['politics', 'society', 'finance'], lang: '英文',
    url: 'https://www.ecns.cn/rss.xml',
    profile: {
      fullName: '中国新闻网',
      country: '中国',
      politicalLean: 'state',
      background: '中国新闻社（中新社）主办的英文新闻门户，面向海外报道中国政治、经济与社会动态。',
      logo: 'https://www.ecns.cn/favicon.ico'
    }
  },
  {
    id: 'gov-cn', name: '中国政府网', grade: 'P0', region: 'cn',
    categories: ['politics', 'society'], lang: '中文',
    url: 'http://www.gov.cn/pushinfo_v15055/rss.xml',
    profile: {
      fullName: '中华人民共和国中央人民政府门户网站',
      country: '中国',
      politicalLean: 'official',
      background: '国务院主办，发布中央政策、国务院文件、政务信息与权威解读，是中国政府官方信息首发平台。',
      logo: 'http://www.gov.cn/favicon.ico'
    }
  },
  {
    id: 'cgtn', name: 'CGTN 中国国际电视台', grade: 'P0', region: 'cn',
    categories: ['politics', 'society'], lang: '英文',
    url: 'https://www.cgtn.com/subscribe/rss/rss.xml',
    fallbacks: [proxy('https://www.cgtn.com/subscribe/rss/rss.xml')],
    profile: {
      fullName: 'China Global Television Network',
      country: '中国',
      politicalLean: 'state',
      background: '中央广播电视总台旗下国际传播机构，以英语向全球报道中国与国际新闻。',
      logo: 'https://www.cgtn.com/favicon.ico'
    }
  },
  {
    id: 'chinadaily', name: '中国日报', grade: 'P1', region: 'cn',
    categories: ['politics', 'society'], lang: '英文',
    url: 'http://www.chinadaily.com.cn/rss/world_rss.xml',
    fallbacks: [
      proxy('http://www.chinadaily.com.cn/rss/world_rss.xml'),
      'http://www.chinadaily.com.cn/rss/entertainment_rss.xml'
    ],
    profile: {
      fullName: 'China Daily',
      country: '中国',
      politicalLean: 'state',
      background: '中国国家级英文日报，面向海外读者报道中国新闻与国际事务。',
      logo: 'http://www.chinadaily.com.cn/favicon.ico'
    }
  },

  /* ---------- 美国 ---------- */
  {
    id: 'nasa', name: 'NASA 美国宇航局', grade: 'P0', region: 'us',
    categories: ['tech', 'society'], lang: '英文',
    url: 'https://www.nasa.gov/feed/',
    fallbacks: [proxy('https://www.nasa.gov/feed/')],
    profile: {
      fullName: 'National Aeronautics and Space Administration',
      country: '美国',
      politicalLean: 'official',
      background: '美国联邦政府独立机构，负责民用太空计划、航空研究与空间科学，科技一手信源。',
      logo: 'https://www.nasa.gov/favicon.ico'
    }
  },
  {
    id: 'npr-news', name: 'NPR 新闻', grade: 'P1', region: 'us',
    categories: ['politics', 'society'], lang: '英文',
    url: 'https://feeds.npr.org/1001/rss.xml',
    fallbacks: [proxy('https://feeds.npr.org/1001/rss.xml')],
    profile: {
      fullName: 'National Public Radio',
      country: '美国',
      politicalLean: 'neutral',
      background: '美国非营利公共广播网络，以深度报道和全国性新闻节目著称，公共资助、编辑独立。',
      logo: 'https://www.npr.org/favicon.ico'
    }
  },
  {
    id: 'npr-world', name: 'NPR 国际', grade: 'P1', region: 'us',
    categories: ['politics'], lang: '英文',
    url: 'https://feeds.npr.org/1019/rss.xml',
    fallbacks: [proxy('https://feeds.npr.org/1019/rss.xml')],
    profile: {
      fullName: 'National Public Radio',
      country: '美国',
      politicalLean: 'neutral',
      background: 'NPR 国际新闻版块，聚焦全球政治、外交与地区冲突。',
      logo: 'https://www.npr.org/favicon.ico'
    }
  },
  {
    id: 'nyt-world', name: '纽约时报·国际', grade: 'P1', region: 'us',
    categories: ['politics'], lang: '英文',
    url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
    fallbacks: [proxy('https://rss.nytimes.com/services/xml/rss/nyt/World.xml')],
    profile: {
      fullName: 'The New York Times',
      country: '美国',
      politicalLean: 'liberal',
      background: '美国最具影响力的全国性日报之一，国际报道网络庞大，倾向自由派。',
      logo: 'https://www.nytimes.com/favicon.ico'
    }
  },
  {
    id: 'nyt-business', name: '纽约时报·商业', grade: 'P1', region: 'us',
    categories: ['finance'], lang: '英文',
    url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml',
    fallbacks: [proxy('https://rss.nytimes.com/services/xml/rss/nyt/Business.xml')],
    profile: {
      fullName: 'The New York Times',
      country: '美国',
      politicalLean: 'liberal',
      background: '纽约时报商业与财经版块，覆盖全球市场、企业与经济政策。',
      logo: 'https://www.nytimes.com/favicon.ico'
    }
  },
  {
    id: 'nyt-tech', name: '纽约时报·科技', grade: 'P1', region: 'us',
    categories: ['tech'], lang: '英文',
    url: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml',
    fallbacks: [proxy('https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml')],
    profile: {
      fullName: 'The New York Times',
      country: '美国',
      politicalLean: 'liberal',
      background: '纽约时报科技版块，报道互联网、人工智能、消费电子与科技政策。',
      logo: 'https://www.nytimes.com/favicon.ico'
    }
  },
  {
    id: 'nyt-health', name: '纽约时报·健康', grade: 'P1', region: 'us',
    categories: ['society'], lang: '英文',
    url: 'https://rss.nytimes.com/services/xml/rss/nyt/Health.xml',
    fallbacks: [proxy('https://rss.nytimes.com/services/xml/rss/nyt/Health.xml')],
    profile: {
      fullName: 'The New York Times',
      country: '美国',
      politicalLean: 'liberal',
      background: '纽约时报健康与科学版块，覆盖医学研究、公共卫生与健康生活。',
      logo: 'https://www.nytimes.com/favicon.ico'
    }
  },

  /* ---------- 美国官方 / 通讯社（P0） ---------- */
  {
    id: 'whitehouse', name: '美国白宫', grade: 'P0', region: 'us',
    categories: ['politics'], lang: '英文',
    url: 'https://www.whitehouse.gov/briefing-room/feed/',
    fallbacks: [proxy('https://www.whitehouse.gov/briefing-room/feed/')],
    profile: {
      fullName: 'The White House',
      country: '美国',
      politicalLean: 'official',
      background: '美国总统行政办公室官方发布平台，提供总统声明、简报、政策文件与日程。',
      logo: 'https://www.whitehouse.gov/favicon.ico'
    }
  },
  {
    id: 'us-treasury', name: '美国财政部', grade: 'P0', region: 'us',
    categories: ['finance', 'politics'], lang: '英文',
    url: 'https://home.treasury.gov/news/press-releases/rss.xml',
    fallbacks: [proxy('https://home.treasury.gov/news/press-releases/rss.xml')],
    profile: {
      fullName: 'U.S. Department of the Treasury',
      country: '美国',
      politicalLean: 'official',
      background: '美国联邦财政部官方发布渠道，涵盖财政政策、制裁、债务、国际财经合作等一手信息。',
      logo: 'https://home.treasury.gov/favicon.ico'
    }
  },
  {
    id: 'federalreserve', name: '美联储', grade: 'P0', region: 'us',
    categories: ['finance'], lang: '英文',
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
    fallbacks: [proxy('https://www.federalreserve.gov/feeds/press_all.xml')],
    profile: {
      fullName: 'Federal Reserve',
      country: '美国',
      politicalLean: 'official',
      background: '美国中央银行，负责货币政策、金融监管与支付系统，其声明对全球金融市场影响重大。',
      logo: 'https://www.federalreserve.gov/favicon.ico'
    }
  },
  {
    id: 'ap-news', name: '美联社 AP', grade: 'P0', region: 'us',
    categories: ['politics', 'society', 'sports'], lang: '英文',
    url: 'https://apnews.com/hub/rss',
    fallbacks: [proxy('https://apnews.com/hub/rss')],
    profile: {
      fullName: 'Associated Press',
      country: '美国',
      politicalLean: 'neutral',
      background: '美国非营利通讯社，全球最大新闻采集机构之一，向全球媒体提供一手新闻稿。',
      logo: 'https://apnews.com/favicon.ico'
    }
  },
  {
    id: 'reuters', name: '路透社 Reuters', grade: 'P0', region: 'us',
    categories: ['politics', 'finance', 'society'], lang: '英文',
    url: 'https://www.reutersagency.com/feed/?best-topics=political-general&post_type=reuters-best',
    fallbacks: [
      proxy('https://www.reutersagency.com/feed/?best-topics=political-general&post_type=reuters-best'),
      'https://www.reuters.com/news/archive/worldnews.rss',
      'https://www.reuters.com/news/archive/businessnews.rss'
    ],
    profile: {
      fullName: 'Reuters',
      country: '英国/跨国',
      politicalLean: 'neutral',
      background: '全球最大国际通讯社之一，以快速、中立、独立的突发新闻与财经报道著称。',
      logo: 'https://www.reuters.com/favicon.ico'
    }
  },
  {
    id: 'afp', name: '法新社 AFP', grade: 'P0', region: 'us',
    categories: ['politics', 'society'], lang: '英文',
    url: 'https://www.afp.com/en/rss.xml',
    fallbacks: [proxy('https://www.afp.com/en/rss.xml')],
    profile: {
      fullName: 'Agence France-Presse',
      country: '法国',
      politicalLean: 'neutral',
      background: '法国最大的通讯社，全球三大通讯社之一，以国际新闻和突发报道见长。',
      logo: 'https://www.afp.com/favicon.ico'
    }
  },

  /* ---------- 英国 ---------- */
  {
    id: 'bbc-news', name: 'BBC 新闻', grade: 'P1', region: 'uk',
    categories: ['politics', 'society'], lang: '英文',
    url: 'https://feeds.bbci.co.uk/news/rss.xml',
    fallbacks: [proxy('https://feeds.bbci.co.uk/news/rss.xml')],
    profile: {
      fullName: 'British Broadcasting Corporation',
      country: '英国',
      politicalLean: 'neutral',
      background: '英国公共广播机构，全球最大新闻采集网络之一，以编辑独立和全球覆盖著称。',
      logo: 'https://www.bbc.co.uk/favicon.ico'
    }
  },
  {
    id: 'bbc-world', name: 'BBC 国际', grade: 'P1', region: 'uk',
    categories: ['politics'], lang: '英文',
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
    fallbacks: [proxy('https://feeds.bbci.co.uk/news/world/rss.xml')],
    profile: {
      fullName: 'British Broadcasting Corporation',
      country: '英国',
      politicalLean: 'neutral',
      background: 'BBC 国际新闻，报道全球重大事件与地区动态。',
      logo: 'https://www.bbc.co.uk/favicon.ico'
    }
  },
  {
    id: 'bbc-business', name: 'BBC 商业', grade: 'P1', region: 'uk',
    categories: ['finance'], lang: '英文',
    url: 'https://feeds.bbci.co.uk/news/business/rss.xml',
    fallbacks: [proxy('https://feeds.bbci.co.uk/news/business/rss.xml')],
    profile: {
      fullName: 'British Broadcasting Corporation',
      country: '英国',
      politicalLean: 'neutral',
      background: 'BBC 商业版块，覆盖全球经济、市场与企业新闻。',
      logo: 'https://www.bbc.co.uk/favicon.ico'
    }
  },
  {
    id: 'bbc-tech', name: 'BBC 科技', grade: 'P1', region: 'uk',
    categories: ['tech'], lang: '英文',
    url: 'https://feeds.bbci.co.uk/news/technology/rss.xml',
    fallbacks: [proxy('https://feeds.bbci.co.uk/news/technology/rss.xml')],
    profile: {
      fullName: 'British Broadcasting Corporation',
      country: '英国',
      politicalLean: 'neutral',
      background: 'BBC 科技版块，聚焦科技创新、网络安全与数字社会。',
      logo: 'https://www.bbc.co.uk/favicon.ico'
    }
  },
  {
    id: 'bbc-health', name: 'BBC 健康', grade: 'P1', region: 'uk',
    categories: ['society'], lang: '英文',
    url: 'https://feeds.bbci.co.uk/news/health/rss.xml',
    fallbacks: [proxy('https://feeds.bbci.co.uk/news/health/rss.xml')],
    profile: {
      fullName: 'British Broadcasting Corporation',
      country: '英国',
      politicalLean: 'neutral',
      background: 'BBC 健康与科学版块，报道医学突破、公共卫生与医疗健康政策。',
      logo: 'https://www.bbc.co.uk/favicon.ico'
    }
  },
  {
    id: 'guardian-world', name: '卫报·国际', grade: 'P1', region: 'uk',
    categories: ['politics'], lang: '英文',
    url: 'https://www.theguardian.com/world/rss',
    fallbacks: [proxy('https://www.theguardian.com/world/rss')],
    profile: {
      fullName: 'The Guardian',
      country: '英国',
      politicalLean: 'left',
      background: '英国左翼主流日报，以调查报道、自由主义立场和数字订阅模式闻名。',
      logo: 'https://www.theguardian.com/favicon.ico'
    }
  },
  {
    id: 'guardian-business', name: '卫报·商业', grade: 'P1', region: 'uk',
    categories: ['finance'], lang: '英文',
    url: 'https://www.theguardian.com/business/rss',
    fallbacks: [proxy('https://www.theguardian.com/business/rss')],
    profile: {
      fullName: 'The Guardian',
      country: '英国',
      politicalLean: 'left',
      background: '卫报商业与财经版块，关注企业责任、经济不平等与全球市场。',
      logo: 'https://www.theguardian.com/favicon.ico'
    }
  },
  {
    id: 'guardian-tech', name: '卫报·科技', grade: 'P1', region: 'uk',
    categories: ['tech'], lang: '英文',
    url: 'https://www.theguardian.com/technology/rss',
    fallbacks: [proxy('https://www.theguardian.com/technology/rss')],
    profile: {
      fullName: 'The Guardian',
      country: '英国',
      politicalLean: 'left',
      background: '卫报科技版块，聚焦科技伦理、平台治理与数字权利。',
      logo: 'https://www.theguardian.com/favicon.ico'
    }
  },
  {
    id: 'guardian-science', name: '卫报·科学', grade: 'P1', region: 'uk',
    categories: ['society'], lang: '英文',
    url: 'https://www.theguardian.com/science/rss',
    fallbacks: [proxy('https://www.theguardian.com/science/rss')],
    profile: {
      fullName: 'The Guardian',
      country: '英国',
      politicalLean: 'left',
      background: '卫报科学版块，报道最新科研成果、气候变化与公共卫生。',
      logo: 'https://www.theguardian.com/favicon.ico'
    }
  },
  {
    id: 'uk-gov', name: '英国政府', grade: 'P0', region: 'uk',
    categories: ['politics', 'society'], lang: '英文',
    url: 'https://www.gov.uk/search/news.atom',
    fallbacks: [proxy('https://www.gov.uk/search/news.atom')],
    profile: {
      fullName: 'UK Government',
      country: '英国',
      politicalLean: 'official',
      background: '英国政府官方新闻发布平台，涵盖政策声明、部长讲话与公共服务公告。',
      logo: 'https://www.gov.uk/favicon.ico'
    }
  },

  /* ---------- 欧盟 ---------- */
  {
    id: 'europarl', name: '欧洲议会', grade: 'P0', region: 'eu',
    categories: ['politics'], lang: '英文',
    url: 'https://www.europarl.europa.eu/rss/doc/top-stories/en.xml',
    fallbacks: [proxy('https://www.europarl.europa.eu/rss/doc/top-stories/en.xml')],
    profile: {
      fullName: 'European Parliament',
      country: '欧盟',
      politicalLean: 'official',
      background: '欧盟三大机构之一，代表欧盟公民行使立法与监督权，发布官方立法与政策动态。',
      logo: 'https://www.europarl.europa.eu/favicon.ico'
    }
  },
  {
    id: 'dw-all', name: '德国之声 DW', grade: 'P1', region: 'eu',
    categories: ['politics', 'society'], lang: '英文',
    url: 'https://rss.dw.com/rdf/rdf-en-all',
    fallbacks: [proxy('https://rss.dw.com/rdf/rdf-en-all')],
    profile: {
      fullName: 'Deutsche Welle',
      country: '德国',
      politicalLean: 'neutral',
      background: '德国公共国际广播机构，以多语种向全球提供新闻，强调德国与欧洲视角。',
      logo: 'https://www.dw.com/favicon.ico'
    }
  },
  {
    id: 'france24', name: '法国24台 France24', grade: 'P1', region: 'eu',
    categories: ['politics', 'society'], lang: '英文',
    url: 'https://www.france24.com/en/rss',
    fallbacks: [proxy('https://www.france24.com/en/rss')],
    profile: {
      fullName: 'France 24',
      country: '法国',
      politicalLean: 'neutral',
      background: '法国公共国际新闻频道，提供法语、英语、阿拉伯语和西班牙语新闻，聚焦国际与非洲事务。',
      logo: 'https://www.france24.com/favicon.ico'
    }
  },
  {
    id: 'eu-commission', name: '欧盟委员会', grade: 'P0', region: 'eu',
    categories: ['politics', 'finance'], lang: '英文',
    url: 'https://ec.europa.eu/newsroom/api/rss?lang=en',
    fallbacks: [proxy('https://ec.europa.eu/newsroom/api/rss?lang=en')],
    profile: {
      fullName: 'European Commission',
      country: '欧盟',
      politicalLean: 'official',
      background: '欧盟行政机关，负责提出立法、执行政策与管理欧盟日常事务。',
      logo: 'https://ec.europa.eu/newsroom/img/favicon.ico'
    }
  },
  {
    id: 'ecb', name: '欧洲央行 ECB', grade: 'P0', region: 'eu',
    categories: ['finance'], lang: '英文',
    url: 'https://www.ecb.europa.eu/rss/press.html',
    fallbacks: [proxy('https://www.ecb.europa.eu/rss/press.html')],
    profile: {
      fullName: 'European Central Bank',
      country: '欧盟',
      politicalLean: 'official',
      background: '欧元区中央银行，负责欧元货币政策、金融稳定与银行监管。',
      logo: 'https://www.ecb.europa.eu/favicon.ico'
    }
  },

  /* ---------- 日本 ---------- */
  {
    id: 'nhk-world', name: 'NHK 世界', grade: 'P1', region: 'jp',
    categories: ['politics'], lang: '英文',
    url: 'https://www3.nhk.or.jp/nhkworld/en/news/rss.xml',
    fallbacks: [proxy('https://www3.nhk.or.jp/nhkworld/en/news/rss.xml')],
    profile: {
      fullName: 'NHK World-Japan',
      country: '日本',
      politicalLean: 'neutral',
      background: '日本广播协会（NHK）的国际英语新闻服务，公共广播、编辑独立，面向海外受众。',
      logo: 'https://www3.nhk.or.jp/favicon.ico'
    }
  },
  {
    id: 'nhk-domestic', name: 'NHK 国内', grade: 'P1', region: 'jp',
    categories: ['politics', 'society'], lang: '日文',
    url: 'https://www3.nhk.or.jp/rss/news/cat0.xml',
    fallbacks: [proxy('https://www3.nhk.or.jp/rss/news/cat0.xml')],
    profile: {
      fullName: '日本放送協会',
      country: '日本',
      politicalLean: 'neutral',
      background: '日本唯一的公共广播机构，由收视费资助，国内新闻以客观、快速著称。',
      logo: 'https://www3.nhk.or.jp/favicon.ico'
    }
  },
  {
    id: 'japan-times', name: '日本时报', grade: 'P1', region: 'jp',
    categories: ['politics', 'finance'], lang: '英文',
    url: 'https://www.japantimes.co.jp/feed/',
    fallbacks: [proxy('https://www.japantimes.co.jp/feed/')],
    profile: {
      fullName: 'The Japan Times',
      country: '日本',
      politicalLean: 'neutral',
      background: '日本历史最悠久的英文日报，私营媒体，以日本政治、经济与外交报道见长。',
      logo: 'https://www.japantimes.co.jp/favicon.ico'
    }
  },
  {
    id: 'mofa-jp', name: '日本外务省', grade: 'P0', region: 'jp',
    categories: ['politics'], lang: '英文',
    url: 'https://www.mofa.go.jp/mofaj/press/release/press/rss.xml',
    fallbacks: [proxy('https://www.mofa.go.jp/mofaj/press/release/press/rss.xml')],
    profile: {
      fullName: 'Ministry of Foreign Affairs of Japan',
      country: '日本',
      politicalLean: 'official',
      background: '日本外务省官方发布渠道，提供外交声明、条约、领导人会见与国际合作信息。',
      logo: 'https://www.mofa.go.jp/favicon.ico'
    }
  },
  {
    id: 'kyodo', name: '共同社 Kyodo', grade: 'P0', region: 'jp',
    categories: ['politics', 'society', 'sports'], lang: '英文',
    url: 'https://english.kyodonews.net/rss/news.xml',
    fallbacks: [proxy('https://english.kyodonews.net/rss/news.xml')],
    profile: {
      fullName: 'Kyodo News Agency',
      country: '日本',
      politicalLean: 'neutral',
      background: '日本最大的通讯社，非营利合作组织，向日本国内外媒体提供一手新闻。',
      logo: 'https://english.kyodonews.net/favicon.ico'
    }
  },
  {
    id: 'yonhap', name: '韩联社 Yonhap', grade: 'P0', region: 'intl',
    categories: ['politics', 'society', 'sports'], lang: '英文',
    url: 'http://english.yonhapnews.co.kr/RSS/news.xml',
    fallbacks: [proxy('http://english.yonhapnews.co.kr/RSS/news.xml')],
    profile: {
      fullName: 'Yonhap News Agency',
      country: '韩国',
      politicalLean: 'neutral',
      background: '韩国最大通讯社，半官方性质，是朝鲜半岛与国际新闻的重要一手来源。',
      logo: 'http://english.yonhapnews.co.kr/favicon.ico'
    }
  },
  {
    id: 'tass', name: '塔斯社 TASS', grade: 'P0', region: 'intl',
    categories: ['politics', 'society'], lang: '英文',
    url: 'http://tass.com/rss/v2.xml',
    fallbacks: [proxy('http://tass.com/rss/v2.xml')],
    profile: {
      fullName: 'TASS Russian News Agency',
      country: '俄罗斯',
      politicalLean: 'state',
      background: '俄罗斯国家通讯社，报道俄罗斯官方立场与国际事务，是俄罗斯官方信息一手来源。',
      logo: 'http://tass.com/favicon.ico'
    }
  },

  /* ---------- 国际机构（一手信源） ---------- */
  {
    id: 'who-news', name: '世界卫生组织 WHO', grade: 'P0', region: 'intl',
    categories: ['society'], lang: '英文',
    url: 'https://www.who.int/rss-feeds/news-english.xml',
    fallbacks: [proxy('https://www.who.int/rss-feeds/news-english.xml')],
    profile: {
      fullName: 'World Health Organization',
      country: '瑞士',
      politicalLean: 'official',
      background: '联合国专门机构，负责国际公共卫生事务，发布疫情、疾病控制与健康政策一手信息。',
      logo: 'https://www.who.int/favicon.ico'
    }
  },
  {
    id: 'un-news', name: '联合国新闻', grade: 'P0', region: 'intl',
    categories: ['politics', 'society'], lang: '英文',
    url: 'https://news.un.org/feed/rss?lang=english',
    fallbacks: [proxy('https://news.un.org/feed/rss?lang=english')],
    profile: {
      fullName: 'United Nations News',
      country: '美国',
      politicalLean: 'official',
      background: '联合国官方新闻网站，报道联合国机构、维和、人道主义、气候变化与全球发展议程。',
      logo: 'https://news.un.org/favicon.ico'
    }
  },
  {
    id: 'worldbank', name: '世界银行', grade: 'P0', region: 'intl',
    categories: ['finance', 'society'], lang: '英文',
    url: 'https://www.worldbank.org/en/news/rss',
    fallbacks: [proxy('https://www.worldbank.org/en/news/rss')],
    profile: {
      fullName: 'World Bank Group',
      country: '美国',
      politicalLean: 'official',
      background: '世界银行集团，提供发展融资、政策研究与全球减贫方案，是国际经济与发展政策一手信源。',
      logo: 'https://www.worldbank.org/favicon.ico'
    }
  },
  {
    id: 'imf', name: '国际货币基金组织 IMF', grade: 'P0', region: 'intl',
    categories: ['finance'], lang: '英文',
    url: 'https://www.imf.org/en/news/rss?lang=eng',
    fallbacks: [proxy('https://www.imf.org/en/news/rss?lang=eng')],
    profile: {
      fullName: 'International Monetary Fund',
      country: '美国',
      politicalLean: 'official',
      background: '联合国专门机构，负责全球货币合作、金融稳定与宏观经济监测。',
      logo: 'https://www.imf.org/favicon.ico'
    }
  },
  {
    id: 'wto', name: '世贸组织 WTO', grade: 'P0', region: 'intl',
    categories: ['finance', 'politics'], lang: '英文',
    url: 'https://www.wto.org/english/news_e/rss_e/news_e.xml',
    fallbacks: [proxy('https://www.wto.org/english/news_e/rss_e/news_e.xml')],
    profile: {
      fullName: 'World Trade Organization',
      country: '瑞士',
      politicalLean: 'official',
      background: '负责全球贸易规则与谈判的国际组织，发布贸易政策、争端解决与市场准入一手信息。',
      logo: 'https://www.wto.org/favicon.ico'
    }
  },

  /* ---------- 新增分类国内信源（提高分类内容覆盖） ---------- */
  {
    id: 'sina-sports', name: '新浪体育', grade: 'P1', region: 'cn',
    categories: ['sports'], lang: '中文',
    url: 'https://sports.sina.com.cn/rss/roll.xml',
    profile: {
      fullName: '新浪体育', country: '中国', politicalLean: 'neutral',
      background: '新浪旗下体育频道，覆盖国内外足球、篮球、综合体育赛事实时资讯。',
      logo: 'https://sports.sina.com.cn/favicon.ico'
    }
  },
  {
    id: 'netease-sports', name: '网易体育', grade: 'P1', region: 'cn',
    categories: ['sports'], lang: '中文',
    url: 'http://sports.163.com/special/00051K7F/rss_sportslq.xml',
    profile: {
      fullName: '网易体育', country: '中国', politicalLean: 'neutral',
      background: '网易体育频道，提供篮球、足球等赛事报道与深度评论。',
      logo: 'https://sports.163.com/favicon.ico'
    }
  },
  {
    id: 'netease-ent', name: '网易娱乐', grade: 'P1', region: 'cn',
    categories: ['culture'], lang: '中文',
    url: 'https://ent.163.com/special/000380VU/newsdata_index.xml',
    profile: {
      fullName: '网易娱乐', country: '中国', politicalLean: 'neutral',
      background: '网易娱乐频道，覆盖影视、音乐、明星动态与综艺资讯。',
      logo: 'https://ent.163.com/favicon.ico'
    }
  },
  {
    id: 'sina-ent', name: '新浪娱乐', grade: 'P1', region: 'cn',
    categories: ['culture'], lang: '中文',
    url: 'https://ent.sina.com.cn/rss/movie.xml',
    profile: {
      fullName: '新浪娱乐', country: '中国', politicalLean: 'neutral',
      background: '新浪娱乐频道，聚焦电影、电视、音乐与明星新闻。',
      logo: 'https://ent.sina.com.cn/favicon.ico'
    }
  },
  /* ---------- 科技·数码（国内源实测可用，补充国际源被墙后的空缺） ---------- */
  {
    id: 'sspai', name: '少数派', grade: 'P1', region: 'cn',
    categories: ['tech'], lang: '中文',
    url: 'https://sspai.com/feed',
    profile: {
      fullName: '少数派', country: '中国', politicalLean: 'neutral',
      background: '聚焦效率工具、数字生活与软硬件技巧的中文科技媒体。',
      logo: 'https://sspai.com/favicon.ico'
    }
  },
  {
    id: 'kr36', name: '36氪', grade: 'P1', region: 'cn',
    categories: ['tech', 'finance'], lang: '中文',
    url: 'https://www.36kr.com/feed',
    profile: {
      fullName: '36氪', country: '中国', politicalLean: 'neutral',
      background: '关注创业、科技与创投趋势的中文财经科技媒体。',
      logo: 'https://www.36kr.com/favicon.ico'
    }
  },
  {
    id: 'huanqiu-mil', name: '环球网军事', grade: 'P1', region: 'cn',
    categories: ['defense'], lang: '中文',
    url: 'https://mil.huanqiu.com/rss.xml',
    profile: {
      fullName: '环球网军事', country: '中国', politicalLean: 'state',
      background: '环球网军事频道，报道全球防务、装备与地缘安全动态。',
      logo: 'https://mil.huanqiu.com/favicon.ico'
    }
  },
  {
    id: 'sina-mil', name: '新浪军事', grade: 'P1', region: 'cn',
    categories: ['defense'], lang: '中文',
    url: 'https://mil.news.sina.com.cn/rollnews.xml',
    profile: {
      fullName: '新浪军事', country: '中国', politicalLean: 'neutral',
      background: '新浪军事频道，提供军事新闻、装备解读与战略观察。',
      logo: 'https://mil.news.sina.com.cn/favicon.ico'
    }
  },
  {
    id: 'cenews-env', name: '中国环境网', grade: 'P1', region: 'cn',
    categories: ['environment'], lang: '中文',
    url: 'http://www.cenews.com.cn/rss.xml',
    profile: {
      fullName: '中国环境网', country: '中国', politicalLean: 'state',
      background: '中国环境报社主办，聚焦生态环境、污染防治与绿色发展政策。',
      logo: 'http://www.cenews.com.cn/favicon.ico'
    }
  },
  {
    id: 'qyer-travel', name: '穷游网', grade: 'P1', region: 'cn',
    categories: ['travel'], lang: '中文',
    url: 'https://www.qyer.com/rss/',
    profile: {
      fullName: '穷游网', country: '中国', politicalLean: 'neutral',
      background: '中文出境游与旅行攻略社区，提供目的地资讯与旅行文化内容。',
      logo: 'https://www.qyer.com/favicon.ico'
    }
  },
  {
    id: 'sina-realestate', name: '新浪房产', grade: 'P1', region: 'cn',
    categories: ['realestate'], lang: '中文',
    url: 'https://news.sina.com.cn/rss/house.xml',
    profile: {
      fullName: '新浪房产', country: '中国', politicalLean: 'neutral',
      background: '新浪房产频道，报道楼市政策、市场动态与行业资讯。',
      logo: 'https://news.sina.com.cn/favicon.ico'
    }
  },

  /* ---------- 教育（国内源实测可用，提高分类内容覆盖） ---------- */
  {
    id: 'xinhua-education', name: '新华网·教育', grade: 'P1', region: 'cn',
    categories: ['education'], lang: '中文',
    url: 'http://www.xinhuanet.com/edu/news_edu.xml',
    profile: {
      fullName: '新华网教育频道', country: '中国', politicalLean: 'official',
      background: '新华社主办教育频道，发布教育政策、留学与校园新闻。',
      logo: 'http://www.xinhuanet.com/favicon.ico'
    }
  },
  {
    id: 'chinanews-edu', name: '中国新闻网·教育', grade: 'P1', region: 'cn',
    categories: ['education'], lang: '中文',
    url: 'https://www.chinanews.com.cn/rss/edu.xml',
    profile: {
      fullName: '中国新闻网教育频道', country: '中国', politicalLean: 'state',
      background: '中国新闻社主办，覆盖教育政策、高校动态与留学资讯。',
      logo: 'https://www.chinanews.com.cn/favicon.ico'
    }
  },

  /* ---------- 汽车（国内 + 国际源互补） ---------- */
  {
    id: 'netease-auto', name: '网易汽车', grade: 'P1', region: 'cn',
    categories: ['auto'], lang: '中文',
    url: 'https://auto.163.com/special/000816M5/rss_autotag.xml',
    profile: {
      fullName: '网易汽车', country: '中国', politicalLean: 'neutral',
      background: '网易汽车频道，报道新车、行业动态与新能源汽车趋势。',
      logo: 'https://auto.163.com/favicon.ico'
    }
  },
  {
    id: 'autohome-news', name: '汽车之家', grade: 'P1', region: 'cn',
    categories: ['auto'], lang: '中文',
    url: 'https://www.autohome.com.cn/rss/all.xml',
    profile: {
      fullName: '汽车之家', country: '中国', politicalLean: 'neutral',
      background: '中国汽车信息与服务平台，提供新车、评测、行业与新能源车资讯。',
      logo: 'https://www.autohome.com.cn/favicon.ico'
    }
  },

  /* ---------- 旅游（国内 + 国际互补） ---------- */
  {
    id: 'travelweekly-cn', name: '环球旅讯', grade: 'P1', region: 'cn',
    categories: ['travel'], lang: '中文',
    url: 'https://www.travelweekly.cn/rss/',
    profile: {
      fullName: '环球旅讯', country: '中国', politicalLean: 'neutral',
      background: '中文旅游财经与行业资讯媒体，关注在线旅游、酒店、航空与目的地。',
      logo: 'https://www.travelweekly.cn/favicon.ico'
    }
  },

  /* ---------- 教育（国内补充） ---------- */
  {
    id: 'jiemodui', name: '芥末堆', grade: 'P1', region: 'cn',
    categories: ['education'], lang: '中文',
    url: 'https://www.jiemodui.com/feed/',
    profile: {
      fullName: '芥末堆', country: '中国', politicalLean: 'neutral',
      background: '专注教育行业的垂直媒体，报道教育政策、职业教育与 EdTech 创业。',
      logo: 'https://www.jiemodui.com/favicon.ico'
    }
  },

  /* ---------- 环境（国内补充） ---------- */
  {
    id: 'chinadialogue', name: '中外对话 ChinaDialogue', grade: 'P1', region: 'cn',
    categories: ['environment'], lang: '中文',
    url: 'https://www.chinadialogue.net/rss/ch',
    fallbacks: [proxy('https://www.chinadialogue.net/rss/ch')],
    profile: {
      fullName: 'China Dialogue',
      country: '中国/英国',
      politicalLean: 'neutral',
      background: '中英双语环境媒体，聚焦中国及全球气候变化、能源与环境政策。',
      logo: 'https://www.chinadialogue.net/favicon.ico'
    }
  },

  /* ---------- 财经·经济（国内补充） ---------- */
  {
    id: 'sina-finance', name: '新浪财经', grade: 'P1', region: 'cn',
    categories: ['finance'], lang: '中文',
    url: 'https://finance.sina.com.cn/rss/roll.xml',
    profile: {
      fullName: '新浪财经', country: '中国', politicalLean: 'neutral',
      background: '新浪旗下综合财经频道，覆盖股市、宏观、产业与公司动态。',
      logo: 'https://finance.sina.com.cn/favicon.ico'
    }
  },
  {
    id: 'yicai', name: '第一财经', grade: 'P1', region: 'cn',
    categories: ['finance'], lang: '中文',
    url: 'https://www.yicai.com/rss/',
    profile: {
      fullName: '第一财经', country: '中国', politicalLean: 'neutral',
      background: '上海广播电视台旗下财经媒体，报道宏观经济、资本市场与商业新闻。',
      logo: 'https://www.yicai.com/favicon.ico'
    }
  },

  /* ---------- 科学（国内补充） ---------- */
  {
    id: 'sciencenet', name: '科学网', grade: 'P1', region: 'cn',
    categories: ['science'], lang: '中文',
    url: 'http://news.sciencenet.cn/news/sub.aspx?id=1',
    profile: {
      fullName: '科学网', country: '中国', politicalLean: 'neutral',
      background: '中国科学院等主办的科学新闻传播平台，报道科研动态与学术资讯。',
      logo: 'http://www.sciencenet.cn/favicon.ico'
    }
  },

  /* ---------- 游戏电竞（国内源实测可用） ---------- */
  {
    id: 'gcores', name: '机核网', grade: 'P1', region: 'cn',
    categories: ['gaming'], lang: '中文',
    url: 'https://www.gcores.com/rss',
    profile: {
      fullName: '机核网 GCORES', country: '中国', politicalLean: 'neutral',
      background: '中文游戏文化与内容社区，覆盖游戏资讯、播客与深度文章。',
      logo: 'https://www.gcores.com/favicon.ico'
    }
  },
  {
    id: 'indienova', name: 'indienova 独立游戏', grade: 'P1', region: 'cn',
    categories: ['gaming'], lang: '中文',
    url: 'https://indienova.com/feed/',
    profile: {
      fullName: 'indienova', country: '中国', politicalLean: 'neutral',
      background: '专注独立游戏的中文媒体，报道独立游戏新闻、开发与评测。',
      logo: 'https://indienova.com/favicon.ico'
    }
  },

  /* ====================== 新增分类信源（v10） ====================== */
  /* ---------- 体育 ---------- */
  {
    id: 'bbc-sport', name: 'BBC 体育', grade: 'P1', region: 'uk',
    categories: ['sports'], lang: '英文',
    url: 'https://feeds.bbci.co.uk/sport/rss.xml',
    fallbacks: [proxy('https://feeds.bbci.co.uk/sport/rss.xml')],
    profile: {
      fullName: 'British Broadcasting Corporation', country: '英国', politicalLean: 'neutral',
      background: 'BBC 体育版块，覆盖全球足球、网球、田径等赛事与体育新闻。',
      logo: 'https://www.bbc.co.uk/favicon.ico'
    }
  },
  {
    id: 'espn-news', name: 'ESPN 体育', grade: 'P1', region: 'us',
    categories: ['sports'], lang: '英文',
    url: 'https://www.espn.com/espn/rss/news',
    fallbacks: [proxy('https://www.espn.com/espn/rss/news')],
    profile: {
      fullName: 'Entertainment and Sports Programming Network', country: '美国', politicalLean: 'neutral',
      background: '美国主流体育电视网，覆盖 NFL、NBA、足球等赛事与运动员动态。',
      logo: 'https://www.espn.com/favicon.ico'
    }
  },
  {
    id: 'goal-com', name: 'Goal.com 足球', grade: 'P1', region: 'us',
    categories: ['sports'], lang: '英文',
    url: 'https://www.goal.com/feeds/en/news',
    fallbacks: [proxy('https://www.goal.com/feeds/en/news')],
    profile: {
      fullName: 'Goal.com', country: '英国/国际', politicalLean: 'neutral',
      background: '全球知名足球资讯网站，覆盖转会、赛事与球队动态。',
      logo: 'https://www.goal.com/favicon.ico'
    }
  },
  {
    id: 'skysports', name: 'Sky Sports', grade: 'P1', region: 'uk',
    categories: ['sports'], lang: '英文',
    url: 'https://www.skysports.com/rss/12040',
    fallbacks: [proxy('https://www.skysports.com/rss/12040')],
    profile: {
      fullName: 'Sky Sports', country: '英国', politicalLean: 'neutral',
      background: '英国天空电视台体育频道，覆盖足球、F1、高尔夫与板球等赛事。',
      logo: 'https://www.skysports.com/favicon.ico'
    }
  },

  /* ---------- 文化·娱乐 ---------- */
  {
    id: 'guardian-culture', name: '卫报·文化', grade: 'P1', region: 'uk',
    categories: ['culture'], lang: '英文',
    url: 'https://www.theguardian.com/culture/rss',
    fallbacks: [proxy('https://www.theguardian.com/culture/rss')],
    profile: {
      fullName: 'The Guardian', country: '英国', politicalLean: 'left',
      background: '卫报文化版块，涵盖艺术、电影、音乐、书籍与流行文化。',
      logo: 'https://www.theguardian.com/favicon.ico'
    }
  },
  {
    id: 'bbc-ent', name: 'BBC 娱乐艺术', grade: 'P1', region: 'uk',
    categories: ['culture'], lang: '英文',
    url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml',
    fallbacks: [proxy('https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml')],
    profile: {
      fullName: 'British Broadcasting Corporation', country: '英国', politicalLean: 'neutral',
      background: 'BBC 娱乐与艺术版块，报道影视、音乐、戏剧与文化艺术动态。',
      logo: 'https://www.bbc.co.uk/favicon.ico'
    }
  },
  {
    id: 'variety', name: 'Variety', grade: 'P1', region: 'us',
    categories: ['culture'], lang: '英文',
    url: 'https://variety.com/rss/',
    fallbacks: [proxy('https://variety.com/rss/')],
    profile: {
      fullName: 'Variety', country: '美国', politicalLean: 'neutral',
      background: '全球娱乐产业权威媒体，报道电影、电视、音乐与流媒体行业。',
      logo: 'https://variety.com/favicon.ico'
    }
  },
  {
    id: 'hollywoodreporter', name: 'The Hollywood Reporter', grade: 'P1', region: 'us',
    categories: ['culture'], lang: '英文',
    url: 'https://www.hollywoodreporter.com/rss/',
    fallbacks: [proxy('https://www.hollywoodreporter.com/rss/')],
    profile: {
      fullName: 'The Hollywood Reporter', country: '美国', politicalLean: 'neutral',
      background: '好莱坞娱乐产业主流媒体，覆盖影视、明星、颁奖与行业动态。',
      logo: 'https://www.hollywoodreporter.com/favicon.ico'
    }
  },
  {
    id: 'deadline', name: 'Deadline', grade: 'P1', region: 'us',
    categories: ['culture'], lang: '英文',
    url: 'https://deadline.com/feed/',
    fallbacks: [proxy('https://deadline.com/feed/')],
    profile: {
      fullName: 'Deadline Hollywood', country: '美国', politicalLean: 'neutral',
      background: '专注好莱坞影视产业新闻，以快速突发和行业深度见长。',
      logo: 'https://deadline.com/favicon.ico'
    }
  },

  /* ---------- 教育 ---------- */
  {
    id: 'guardian-education', name: '卫报·教育', grade: 'P1', region: 'uk',
    categories: ['education'], lang: '英文',
    url: 'https://www.theguardian.com/education/rss',
    fallbacks: [proxy('https://www.theguardian.com/education/rss')],
    profile: {
      fullName: 'The Guardian', country: '英国', politicalLean: 'left',
      background: '卫报教育版块，关注英国及全球教育政策、高校与升学动态。',
      logo: 'https://www.theguardian.com/favicon.ico'
    }
  },
  {
    id: 'inside-higher-ed', name: 'Inside Higher Ed', grade: 'P1', region: 'us',
    categories: ['education'], lang: '英文',
    url: 'https://www.insidehighered.com/rss.xml',
    fallbacks: [proxy('https://www.insidehighered.com/rss.xml')],
    profile: {
      fullName: 'Inside Higher Ed', country: '美国', politicalLean: 'neutral',
      background: '美国高等教育行业权威在线媒体，报道大学政策、研究与职场动态。',
      logo: 'https://www.insidehighered.com/favicon.ico'
    }
  },
  {
    id: 'chronicle-he', name: 'Chronicle of Higher Education', grade: 'P1', region: 'us',
    categories: ['education'], lang: '英文',
    url: 'https://www.chronicle.com/rss/',
    fallbacks: [proxy('https://www.chronicle.com/rss/')],
    profile: {
      fullName: 'The Chronicle of Higher Education', country: '美国', politicalLean: 'neutral',
      background: '美国高等教育领域权威周刊，关注学术、治理、融资与校园议题。',
      logo: 'https://www.chronicle.com/favicon.ico'
    }
  },

  /* ---------- 军事·防务 ---------- */
  {
    id: 'defensenews', name: 'Defense News', grade: 'P1', region: 'us',
    categories: ['defense'], lang: '英文',
    url: 'https://www.defensenews.com/arc/outboundfeeds/rss/',
    fallbacks: [proxy('https://www.defensenews.com/arc/outboundfeeds/rss/')],
    profile: {
      fullName: 'Defense News', country: '美国', politicalLean: 'neutral',
      background: '专注全球国防与军事工业的权威周刊，覆盖军备、战略与防务政策。',
      logo: 'https://www.defensenews.com/favicon.ico'
    }
  },
  {
    id: 'militarytimes', name: 'Military Times', grade: 'P1', region: 'us',
    categories: ['defense'], lang: '英文',
    url: 'https://www.militarytimes.com/arc/outboundfeeds/rss/',
    fallbacks: [proxy('https://www.militarytimes.com/arc/outboundfeeds/rss/')],
    profile: {
      fullName: 'Military Times', country: '美国', politicalLean: 'neutral',
      background: '面向美军官兵与防务观察者的媒体，报道军事行动、装备与退伍军人事务。',
      logo: 'https://www.militarytimes.com/favicon.ico'
    }
  },
  {
    id: 'breaking-defense', name: 'Breaking Defense', grade: 'P1', region: 'us',
    categories: ['defense'], lang: '英文',
    url: 'https://breakingdefense.com/feed/',
    fallbacks: [proxy('https://breakingdefense.com/feed/')],
    profile: {
      fullName: 'Breaking Defense', country: '美国', politicalLean: 'neutral',
      background: '专注国防工业、军事战略与国会预算的防务媒体。',
      logo: 'https://breakingdefense.com/favicon.ico'
    }
  },
  {
    id: 'the-war-zone', name: 'The War Zone', grade: 'P1', region: 'us',
    categories: ['defense'], lang: '英文',
    url: 'https://www.thedrive.com/the-war-zone/rss',
    fallbacks: [proxy('https://www.thedrive.com/the-war-zone/rss')],
    profile: {
      fullName: 'The War Zone', country: '美国', politicalLean: 'neutral',
      background: 'The Drive 旗下防务栏目，聚焦军用航空、舰船、导弹与冲突技术。',
      logo: 'https://www.thedrive.com/favicon.ico'
    }
  },

  /* ---------- 环境·气候 ---------- */
  {
    id: 'guardian-environment', name: '卫报·环境', grade: 'P1', region: 'uk',
    categories: ['environment'], lang: '英文',
    url: 'https://www.theguardian.com/environment/rss',
    fallbacks: [proxy('https://www.theguardian.com/environment/rss')],
    profile: {
      fullName: 'The Guardian', country: '英国', politicalLean: 'left',
      background: '卫报环境版块，报道气候变化、能源转型、生态与可持续发展。',
      logo: 'https://www.theguardian.com/favicon.ico'
    }
  },
  {
    id: 'bbc-env', name: 'BBC 科学环境', grade: 'P1', region: 'uk',
    categories: ['environment', 'science'], lang: '英文',
    url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
    fallbacks: [proxy('https://feeds.bbci.co.uk/news/science_and_environment/rss.xml')],
    profile: {
      fullName: 'British Broadcasting Corporation', country: '英国', politicalLean: 'neutral',
      background: 'BBC 科学与环境版块，覆盖气候、太空、自然与前沿科学研究。',
      logo: 'https://www.bbc.co.uk/favicon.ico'
    }
  },
  {
    id: 'carbon-brief', name: 'Carbon Brief 碳简报', grade: 'P1', region: 'uk',
    categories: ['environment', 'science'], lang: '英文',
    url: 'https://www.carbonbrief.org/feed/',
    fallbacks: [proxy('https://www.carbonbrief.org/feed/')],
    profile: {
      fullName: 'Carbon Brief', country: '英国', politicalLean: 'neutral',
      background: '英国气候变化与能源政策专业媒体，以数据驱动的气候报道著称。',
      logo: 'https://www.carbonbrief.org/favicon.ico'
    }
  },

  /* ---------- 科学 ---------- */
  {
    id: 'sciam', name: '科学美国人', grade: 'P1', region: 'us',
    categories: ['science'], lang: '英文',
    url: 'https://www.scientificamerican.com/feed/',
    fallbacks: [proxy('https://www.scientificamerican.com/feed/')],
    profile: {
      fullName: 'Scientific American', country: '美国', politicalLean: 'neutral',
      background: '创刊于 1845 年的权威科普杂志，报道基础科学与技术应用进展。',
      logo: 'https://www.scientificamerican.com/favicon.ico'
    }
  },
  {
    id: 'nature-journal', name: 'Nature 自然', grade: 'P0', region: 'intl',
    categories: ['science'], lang: '英文',
    url: 'https://www.nature.com/nature.rss',
    fallbacks: [proxy('https://www.nature.com/nature.rss')],
    profile: {
      fullName: 'Nature', country: '英国', politicalLean: 'neutral',
      background: '全球顶尖同行评审科学期刊，发表各学科突破性研究成果（一手信源）。',
      logo: 'https://www.nature.com/favicon.ico'
    }
  },
  {
    id: 'science-journal', name: 'Science 科学', grade: 'P0', region: 'us',
    categories: ['science'], lang: '英文',
    url: 'https://www.science.org/rss/news_current.xml',
    fallbacks: [proxy('https://www.science.org/rss/news_current.xml')],
    profile: {
      fullName: 'Science', country: '美国', politicalLean: 'neutral',
      background: '美国科学促进会（AAAS）旗舰期刊，发表前沿研究与科学政策新闻（一手信源）。',
      logo: 'https://www.science.org/favicon.ico'
    }
  },
  {
    id: 'new-scientist', name: 'New Scientist', grade: 'P1', region: 'uk',
    categories: ['science'], lang: '英文',
    url: 'https://www.newscientist.com/feed/home/',
    fallbacks: [proxy('https://www.newscientist.com/feed/home/')],
    profile: {
      fullName: 'New Scientist', country: '英国', politicalLean: 'neutral',
      background: '国际科普与科技新闻周刊，报道科学新发现、技术与未来趋势。',
      logo: 'https://www.newscientist.com/favicon.ico'
    }
  },

  /* ---------- 旅游 ---------- */
  {
    id: 'guardian-travel', name: '卫报·旅游', grade: 'P1', region: 'uk',
    categories: ['travel'], lang: '英文',
    url: 'https://www.theguardian.com/travel/rss',
    fallbacks: [proxy('https://www.theguardian.com/travel/rss')],
    profile: {
      fullName: 'The Guardian', country: '英国', politicalLean: 'left',
      background: '卫报旅游版块，提供目的地指南、旅行文化与可持续旅游报道。',
      logo: 'https://www.theguardian.com/favicon.ico'
    }
  },
  {
    id: 'travel-leisure', name: 'Travel + Leisure', grade: 'P1', region: 'us',
    categories: ['travel'], lang: '英文',
    url: 'https://www.travelandleisure.com/feed',
    fallbacks: [proxy('https://www.travelandleisure.com/feed')],
    profile: {
      fullName: 'Travel + Leisure', country: '美国', politicalLean: 'neutral',
      background: '全球知名旅游生活方式杂志，提供目的地、酒店、美食与旅行灵感。',
      logo: 'https://www.travelandleisure.com/favicon.ico'
    }
  },
  {
    id: 'lonely-planet', name: 'Lonely Planet', grade: 'P1', region: 'us',
    categories: ['travel'], lang: '英文',
    url: 'https://www.lonelyplanet.com/news/feed',
    fallbacks: [proxy('https://www.lonelyplanet.com/news/feed')],
    profile: {
      fullName: 'Lonely Planet', country: '美国', politicalLean: 'neutral',
      background: '全球知名旅行指南出版商，提供目的地资讯与旅行文化内容。',
      logo: 'https://www.lonelyplanet.com/favicon.ico'
    }
  },
  {
    id: 'natgeo-travel', name: 'National Geographic', grade: 'P1', region: 'us',
    categories: ['travel', 'science', 'environment'], lang: '英文',
    url: 'https://www.nationalgeographic.com/content/natgeo/en_us/rss/index.rss',
    fallbacks: [proxy('https://www.nationalgeographic.com/content/natgeo/en_us/rss/index.rss')],
    profile: {
      fullName: 'National Geographic', country: '美国', politicalLean: 'neutral',
      background: '美国国家地理学会官方媒体，涵盖自然、科学、探险、旅行与环境保护。',
      logo: 'https://www.nationalgeographic.com/favicon.ico'
    }
  },

  /* ---------- 汽车 ---------- */
  {
    id: 'autocar', name: 'Autocar', grade: 'P1', region: 'uk',
    categories: ['auto'], lang: '英文',
    url: 'https://www.autocar.co.uk/rss',
    fallbacks: [proxy('https://www.autocar.co.uk/rss')],
    profile: {
      fullName: 'Autocar', country: '英国', politicalLean: 'neutral',
      background: '英国历史最悠久的汽车杂志，覆盖新车评测、行业与电动化趋势。',
      logo: 'https://www.autocar.co.uk/favicon.ico'
    }
  },
  {
    id: 'caranddriver', name: 'Car and Driver', grade: 'P1', region: 'us',
    categories: ['auto'], lang: '英文',
    url: 'https://www.caranddriver.com/rss',
    fallbacks: [proxy('https://www.caranddriver.com/rss')],
    profile: {
      fullName: 'Car and Driver', country: '美国', politicalLean: 'neutral',
      background: '美国权威汽车媒体，新车测试、购车指南与汽车科技报道。',
      logo: 'https://www.caranddriver.com/favicon.ico'
    }
  },
  {
    id: 'topgear', name: 'Top Gear', grade: 'P1', region: 'uk',
    categories: ['auto'], lang: '英文',
    url: 'https://www.topgear.com/rss.xml',
    fallbacks: [proxy('https://www.topgear.com/rss.xml')],
    profile: {
      fullName: 'Top Gear', country: '英国', politicalLean: 'neutral',
      background: '英国知名汽车娱乐与评测媒体，覆盖新车、超跑与汽车文化。',
      logo: 'https://www.topgear.com/favicon.ico'
    }
  },
  {
    id: 'motortrend', name: 'Motor Trend', grade: 'P1', region: 'us',
    categories: ['auto'], lang: '英文',
    url: 'https://www.motortrend.com/feed/',
    fallbacks: [proxy('https://www.motortrend.com/feed/')],
    profile: {
      fullName: 'Motor Trend', country: '美国', politicalLean: 'neutral',
      background: '美国权威汽车杂志，以年度车型评选、性能测试与行业评论著称。',
      logo: 'https://www.motortrend.com/favicon.ico'
    }
  },

  /* ---------- 游戏·电竞 ---------- */
  {
    id: 'polygon', name: 'Polygon', grade: 'P1', region: 'us',
    categories: ['gaming'], lang: '英文',
    url: 'https://www.polygon.com/rss/index.xml',
    fallbacks: [proxy('https://www.polygon.com/rss/index.xml')],
    profile: {
      fullName: 'Polygon', country: '美国', politicalLean: 'neutral',
      background: '专注游戏文化与产业的媒体，覆盖游戏评测、电竞与行业动态。',
      logo: 'https://www.polygon.com/favicon.ico'
    }
  },
  {
    id: 'ign-all', name: 'IGN', grade: 'P1', region: 'us',
    categories: ['gaming'], lang: '英文',
    url: 'https://feeds.feedburner.com/ign/all',
    fallbacks: [proxy('https://feeds.feedburner.com/ign/all')],
    profile: {
      fullName: 'IGN', country: '美国', politicalLean: 'neutral',
      background: '全球最大的游戏娱乐媒体之一，游戏新闻、评测与电竞报道。',
      logo: 'https://www.ign.com/favicon.ico'
    }
  },

  /* ---------- 房产 ---------- */
  {
    id: 'inman', name: 'Inman', grade: 'P1', region: 'us',
    categories: ['realestate'], lang: '英文',
    url: 'https://www.inman.com/feed/',
    fallbacks: [proxy('https://www.inman.com/feed/')],
    profile: {
      fullName: 'Inman', country: '美国', politicalLean: 'neutral',
      background: '聚焦房地产经纪与 PropTech 的行业媒体，覆盖楼市趋势与交易科技。',
      logo: 'https://www.inman.com/favicon.ico'
    }
  },
  {
    id: 'housingwire', name: 'HousingWire', grade: 'P1', region: 'us',
    categories: ['realestate'], lang: '英文',
    url: 'https://www.housingwire.com/feed/',
    profile: {
      fullName: 'HousingWire', country: '美国', politicalLean: 'neutral',
      background: '美国房地产金融与按揭市场权威媒体，报道楼市数据与政策。',
      logo: 'https://www.housingwire.com/favicon.ico'
    }
  },
  {
    id: 'mortgage-news-daily', name: 'Mortgage News Daily', grade: 'P1', region: 'us',
    categories: ['realestate', 'finance'], lang: '英文',
    url: 'https://www.mortgagenewsdaily.com/rss/',
    fallbacks: [proxy('https://www.mortgagenewsdaily.com/rss/')],
    profile: {
      fullName: 'Mortgage News Daily', country: '美国', politicalLean: 'neutral',
      background: '美国按揭与利率行业权威数据源，提供房贷利率、市场评论与监管动态。',
      logo: 'https://www.mortgagenewsdaily.com/favicon.ico'
    }
  },
  {
    id: 'builder-online', name: 'Builder Online', grade: 'P1', region: 'us',
    categories: ['realestate'], lang: '英文',
    url: 'https://www.builderonline.com/feed',
    fallbacks: [proxy('https://www.builderonline.com/feed')],
    profile: {
      fullName: 'Builder Online', country: '美国', politicalLean: 'neutral',
      background: '美国住宅建筑与房地产开发行业媒体，报道市场趋势、设计与政策。',
      logo: 'https://www.builderonline.com/favicon.ico'
    }
  }
];

/* ====================== 热搜 / 热门榜单源 ====================== */
/*
 * 热搜本质是"大家在搜什么"，天然属 P2 参考信源（聚合 / 社媒）。
 * 每条自带 parse，把不同返回统一成 [{ title, url, hot }]。
 * fallbacks 为备用地址：主 url 失败时会依次尝试，提高可用性。
 */

// 统一把千奇百怪的返回字段转成标准 { title, url, hot }
function normalizeHotList(list) {
  if (!Array.isArray(list)) return [];
  return list.map(it => {
    if (!it || typeof it !== 'object') return null;
    const title = it.title || it.word || it.query || it.name || it.topic || '';
    let url = it.url || it.link || it.mobileUrl || it.mobilUrl || it.href || '';
    let hot = it.hot || it.heat || it.score || it.hotScore || it.ups || it.num || it.raw_hot || it.view || it.popularity || null;
    if (typeof hot === 'string') {
      const m = hot.match(/([\d.]+)\s*(万|亿|w)?/i);
      if (m) {
        hot = parseFloat(m[1]);
        const unit = (m[2] || '').toLowerCase();
        if (unit === '万' || unit === 'w') hot *= 10000;
        if (unit === '亿') hot *= 100000000;
      } else {
        hot = null;
      }
    }
    return title ? { title: String(title), url: String(url || ''), hot: hot == null ? null : Number(hot) } : null;
  }).filter(Boolean);
}

// 从各种千奇百怪的返回结构中，尽可能稳健地提取出"条目数组"。
// 关键修复：避免把对象（而非数组）传给 .slice —— 这正是百度榜单
// 报 "list.slice is not a function" 的根因（某些接口把列表包在 data.data / data.data.cards 等里）。
function extractHotArray(data) {
  if (Array.isArray(data)) return flattenHotArray(data);
  if (!data || typeof data !== 'object') return [];
  const cands = [];
  if (data.data && Array.isArray(data.data)) cands.push(data.data);
  if (data.data && Array.isArray(data.data.realtime)) cands.push(data.data.realtime);
  if (data.data && Array.isArray(data.data.list)) cands.push(data.data.list);
  if (data.data && Array.isArray(data.data.items)) cands.push(data.data.items);
  if (data.data && Array.isArray(data.data.content)) cands.push(data.data.content);
  if (data.data && Array.isArray(data.data.cards)) {
    // 百度官方 API：cards[0].content 才是真正的榜单条目
    const firstContent = data.data.cards.find(c => c && Array.isArray(c.content));
    if (firstContent) cands.push(firstContent.content);
    cands.push(data.data.cards);
  }
  if (data.data && Array.isArray(data.data.children)) cands.push(data.data.children);
  if (data.result && Array.isArray(data.result)) cands.push(data.result);
  if (data.result && Array.isArray(data.result.data)) cands.push(data.result.data);
  if (data.result && Array.isArray(data.result.list)) cands.push(data.result.list);
  if (Array.isArray(data.list)) cands.push(data.list);
  if (Array.isArray(data.items)) cands.push(data.items);
  if (Array.isArray(data.children)) cands.push(data.children);
  if (cands.length) return flattenHotArray(cands[0] || []);
  // 兜底：扫描值，找到首个"对象数组"且元素含标题类字段
  for (const v of Object.values(data)) {
    if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object'
        && (v[0].title || v[0].word || v[0].name || v[0].query)) {
      return flattenHotArray(v);
    }
  }
  return [];
}

function flattenHotArray(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const it of arr) {
    if (!it) continue;
    if (Array.isArray(it)) out.push(...flattenHotArray(it));
    else if (Array.isArray(it.content)) out.push(...flattenHotArray(it.content));
    else out.push(it);
  }
  return out;
}

// ---------- 网页抓取解析辅助 ----------
function htmlText(el, sel) {
  if (!el) return '';
  const n = typeof sel === 'string' ? el.querySelector(sel) : sel;
  return n ? (n.textContent || '').trim() : '';
}
function htmlAttr(el, sel, attr) {
  if (!el) return '';
  const n = typeof sel === 'string' ? el.querySelector(sel) : sel;
  return n ? (n.getAttribute(attr) || '') : '';
}
function parseHtmlTable(doc, config) {
  if (!doc) return [];
  let rows = Array.from(doc.querySelectorAll(config.rowSelector));
  // 兜底：若主选择器未命中，尝试从表格/列表行中自动识别标题链接
  if (!rows.length) {
    rows = Array.from(doc.querySelectorAll('table tbody tr, ul li, ol li, .list-item, [class*="item"]'));
  }
  return rows.map((row, idx) => {
    let title = htmlText(row, config.titleSelector);
    let linkEl = config.linkSelector ? row.querySelector(config.linkSelector) : null;
    if (!title && linkEl) title = (linkEl.textContent || '').trim();
    if (!title) {
      const firstA = row.querySelector('a');
      if (firstA) title = (firstA.textContent || '').trim();
    }
    if (!title) return null;
    let url = htmlAttr(row, config.linkSelector, 'href') || (linkEl ? (linkEl.getAttribute('href') || '') : '');
    if (!url) {
      const firstA = row.querySelector('a');
      if (firstA) url = firstA.getAttribute('href') || '';
    }
    if (url && config.linkPrefix && !/^https?:\/\//.test(url)) url = config.linkPrefix + url;
    let hot = htmlText(row, config.hotSelector) || null;
    return { title, url, hot };
  }).filter(Boolean);
}

const HOT_SOURCES = [
  {
    id: 'weibo', name: '微博热搜', grade: 'P2', region: 'cn',
    // uapis.cn 聚合热榜（实测稳定，无需鉴权）
    url: 'https://uapis.cn/api/v1/misc/hotboard?type=weibo',
    fallbacks: [
      'https://api-hot.imsyy.top/weibo',
      'https://api.codelife.cc/api/top/list?type=weibo',
      proxy('https://api-hot.imsyy.top/weibo'),
      'https://api.pearktrue.cn/api/hotlist/wb',
      'https://api.vvhan.com/api/hotlist/wbhot',
      'https://api.52vmy.cn/api/wl/hot',
      'https://tenapi.cn/v2/weibohot',
      'https://weibo.com/ajax/side/hotSearch',
      proxy('https://weibo.com/ajax/side/hotSearch')
    ],
    parse: (data) => {
      const list = extractHotArray(data).map(it => {
        const title = it.title || it.word || it.name || it.query || '';
        const hot = it.hot_value || it.raw_hot || it.num || it.hot || it.hotScore || null;
        let url = it.url || it.link || it.mobileUrl || it.mobilUrl || it.href || it.wwwUrl || '';
        if (!url && title) url = 'https://s.weibo.com/weibo?q=' + encodeURIComponent('#' + title);
        return { title, url, hot };
      });
      return normalizeHotList(list);
    },
    html: {
      url: 'https://s.weibo.com/top/summary?cate=realtimehot',
      headers: { Referer: 'https://s.weibo.com/top/summary' },
      rowSelector: '#pl_top_realtimehot tbody tr',
      titleSelector: '.td-02 a',
      linkSelector: '.td-02 a',
      hotSelector: '.td-02 span',
      linkPrefix: 'https://s.weibo.com'
    },
    parseHtml: (doc) => normalizeHotList(parseHtmlTable(doc, HOT_SOURCES.find(s => s.id === 'weibo').html))
  },
  {
    id: 'baidu', name: '百度热搜', grade: 'P2', region: 'cn',
    // 百度官方榜首页 API：国内直连、无需鉴权，优先使用
    url: 'https://top.baidu.com/api/board?platform=wise&tab=realtime',
    fallbacks: [
      proxy('https://top.baidu.com/api/board?platform=wise&tab=realtime'),
      'https://api-hot.imsyy.top/baidu',
      proxy('https://api-hot.imsyy.top/baidu'),
      'https://api.pearktrue.cn/api/hotlist/baidu',
      'https://api.vvhan.com/api/hotlist/baidu',
      'https://api.52vmy.cn/api/wl/baidu',
      'https://tenapi.cn/v2/baidu'
    ],
    parse: (data) => {
      const list = extractHotArray(data).map(it => {
        const title = it.title || it.word || it.query || '';
        const hot = it.hotScore || it.hot || it.score || null;
        let url = it.url || it.rawUrl || it.wwwUrl || it.sameLinkUrl || '';
        if (!url && title) url = 'https://www.baidu.com/s?wd=' + encodeURIComponent(title);
        return { title, url, hot };
      });
      return normalizeHotList(list);
    },
    html: {
      url: 'https://top.baidu.com/board?tab=realtime',
      headers: { Referer: 'https://top.baidu.com/' },
      rowSelector: '.category-wrap_iQLoo',
      titleSelector: '.c-single-text-ellipsis',
      linkSelector: 'a[href]',
      hotSelector: '.hot-index_1Bl1a',
      linkPrefix: ''
    },
    parseHtml: (doc) => normalizeHotList(parseHtmlTable(doc, HOT_SOURCES.find(s => s.id === 'baidu').html))
  },
  {
    id: 'zhihu', name: '知乎热榜', grade: 'P2', region: 'cn',
    // uapis.cn 聚合热榜（实测稳定，无需鉴权）
    url: 'https://uapis.cn/api/v1/misc/hotboard?type=zhihu',
    fallbacks: [
      'https://api-hot.imsyy.top/zhihu',
      'https://api.codelife.cc/api/top/list?type=zhihu',
      proxy('https://api-hot.imsyy.top/zhihu'),
      'https://api.pearktrue.cn/api/hotlist/zhihu',
      'https://api.vvhan.com/api/hotlist/zhihu',
      'https://api.52vmy.cn/api/wl/zhihu',
      'https://tenapi.cn/v2/zhihu',
      'https://www.zhihu.com/api/v3/feed/topstory/hot-list',
      proxy('https://www.zhihu.com/api/v3/feed/topstory/hot-list')
    ],
    parse: (data) => {
      const list = extractHotArray(data).map(it => {
        let title = it.title || it.name || '';
        let url = it.url || it.link || it.href || it.wwwUrl || '';
        let hot = it.hot_value || it.hot || it.detail_text || it.excerpt || it.score || it.hotScore || null;
        const t = it.target;
        if (t) {
          title = t.title || title;
          if (t.id) url = 'https://www.zhihu.com/question/' + t.id;
          else if (t.url) url = t.url;
          hot = t.detail_text || t.excerpt || hot;
        }
        if (!url && title) url = 'https://www.zhihu.com/search?type=content&q=' + encodeURIComponent(title);
        return { title, url, hot };
      });
      return normalizeHotList(list);
    },
    html: {
      url: 'https://www.zhihu.com/hot',
      headers: { Referer: 'https://www.zhihu.com/' },
      rowSelector: '.HotItem',
      titleSelector: '.HotItem-title',
      linkSelector: '.HotItem-content a[href]',
      hotSelector: '.HotItem-metrics',
      linkPrefix: 'https://www.zhihu.com'
    },
    parseHtml: (doc) => normalizeHotList(parseHtmlTable(doc, HOT_SOURCES.find(s => s.id === 'zhihu').html))
  },
  {
    id: 'hackernews', name: 'Hacker News', grade: 'P2', region: 'intl',
    // HN 官方 RSS 稳定可访问，作为首要来源；HTML 兜底抓取评论数作为热度
    url: 'https://news.ycombinator.com/rss',
    fallbacks: [
      proxy('https://news.ycombinator.com/rss'),
      'https://hnrss.org/frontpage',
      proxy('https://hnrss.org/frontpage')
    ],
    parse: (data) => {
      const xml = typeof data === 'string' ? data : '';
      const items = FeedParser.parseFeed(xml, {
        id: 'hackernews', name: 'Hacker News', grade: 'P2', region: 'intl', categories: [], lang: '英文'
      });
      return items.map(it => ({
        title: it.title,
        url: it.link,
        hot: null
      }));
    },
    html: {
      url: 'https://news.ycombinator.com/',
      headers: { Referer: 'https://news.ycombinator.com/' },
      rowSelector: '.athing',
      titleSelector: '.titleline > a',
      linkSelector: '.titleline > a',
      hotSelector: '.score',
      linkPrefix: ''
    },
    parseHtml: (doc) => {
      if (!doc) return [];
      const rows = Array.from(doc.querySelectorAll('.athing'));
      return rows.map(row => {
        const titleEl = row.querySelector('.titleline > a');
        if (!titleEl) return null;
        const title = titleEl.textContent.trim();
        let url = titleEl.getAttribute('href') || '';
        if (url && !/^https?:\/\//.test(url)) url = 'https://news.ycombinator.com/' + url;
        const scoreEl = doc.querySelector('#score_' + row.id);
        const hot = scoreEl ? scoreEl.textContent.trim() : null;
        return { title, url, hot };
      }).filter(Boolean);
    }
  },
  {
    id: 'reddit-world', name: 'Reddit·国际', grade: 'P2', region: 'intl',
    url: 'https://www.reddit.com/r/worldnews/hot.json?limit=30',
    fallbacks: [
      proxy('https://www.reddit.com/r/worldnews/hot.json?limit=30'),
      'https://www.reddit.com/r/worldnews.rss',
      proxy('https://www.reddit.com/r/worldnews.rss'),
      'https://www.reddit.com/r/worldnews/top.json?limit=30&t=day',
      'https://www.reddit.com/r/news/hot.json?limit=30',
      'https://www.reddit.com/r/news.rss',
      proxy('https://www.reddit.com/r/news.rss'),
      'https://libreddit.de/r/worldnews/hot.json?limit=30',
      'https://lr.riverside.rocks/r/worldnews/hot.json?limit=30'
    ],
    parse: (data) => {
      // RSS 兜底返回的是 XML 字符串
      if (typeof data === 'string' && /<(rss|feed)\b/i.test(data)) {
        const items = FeedParser.parseFeed(data, { id: 'reddit-world', name: 'Reddit·国际', grade: 'P2', region: 'intl', categories: [], lang: '英文' });
        return items.map(it => ({ title: it.title, url: it.link, hot: null }));
      }
      const list = extractHotArray(data).map(c => {
        const d = c.data || c;
        const url = d.permalink ? ('https://www.reddit.com' + d.permalink) : (d.url || '');
        return { title: d.title, url, hot: d.ups || d.score || null };
      });
      return normalizeHotList(list);
    }
  },
  {
    id: 'reddit-tech', name: 'Reddit·科技', grade: 'P2', region: 'intl',
    url: 'https://www.reddit.com/r/technology/hot.json?limit=30',
    fallbacks: [
      proxy('https://www.reddit.com/r/technology/hot.json?limit=30'),
      'https://www.reddit.com/r/technology.rss',
      proxy('https://www.reddit.com/r/technology.rss'),
      'https://www.reddit.com/r/technology/top.json?limit=30&t=day',
      'https://www.reddit.com/r/tech/hot.json?limit=30',
      'https://www.reddit.com/r/tech.rss',
      proxy('https://www.reddit.com/r/tech.rss'),
      'https://libreddit.de/r/technology/hot.json?limit=30',
      'https://lr.riverside.rocks/r/technology/hot.json?limit=30'
    ],
    parse: (data) => {
      if (typeof data === 'string' && /<(rss|feed)\b/i.test(data)) {
        const items = FeedParser.parseFeed(data, { id: 'reddit-tech', name: 'Reddit·科技', grade: 'P2', region: 'intl', categories: [], lang: '英文' });
        return items.map(it => ({ title: it.title, url: it.link, hot: null }));
      }
      const list = extractHotArray(data).map(c => {
        const d = c.data || c;
        const url = d.permalink ? ('https://www.reddit.com' + d.permalink) : (d.url || '');
        return { title: d.title, url, hot: d.ups || d.score || null };
      });
      return normalizeHotList(list);
    }
  }
];

// 发布者官方地址坐标（方案 A 兜底；GCJ-02 近似，仅作位置参考）
// 按国家/地区给出代表性坐标；个别机构用更精确坐标覆盖
const COUNTRY_COORDS = {
  '中国': [39.9042, 116.4074],
  '美国': [38.9072, -77.0369],
  '英国': [51.5074, -0.1278],
  '欧盟': [50.8503, 4.3517],
  '德国': [52.5200, 13.4050],
  '法国': [48.8566, 2.3522],
  '日本': [35.6762, 139.6503],
  '瑞士': [46.2044, 6.1432]
};

// 世界主要城市 / 国家 / 地区坐标表（用于从标题识别新闻地点，方案 B）
// 优先匹配更具体的城市，再匹配国家/地区；坐标为 WGS-84 近似值，仅作展示
const LOCATION_TABLE = [
  // 中国主要城市
  ['北京', 39.9042, 116.4074], ['上海', 31.2304, 121.4737], ['广州', 23.1291, 113.2644],
  ['深圳', 22.5431, 114.0579], ['香港', 22.3193, 114.1694], ['台北', 25.0330, 121.5654],
  ['澳门', 22.1987, 113.5439], ['天津', 39.0842, 117.2009], ['重庆', 29.5630, 106.5516],
  ['成都', 30.5728, 104.0668], ['杭州', 30.2741, 120.1551], ['武汉', 30.5928, 114.3055],
  ['西安', 34.3416, 108.9398], ['南京', 32.0603, 118.7969], ['苏州', 31.2989, 120.5853],
  ['青岛', 36.0671, 120.3826], ['大连', 38.9140, 121.6147], ['厦门', 24.4798, 118.0894],
  // 东亚
  ['东京', 35.6762, 139.6503], ['大阪', 34.6937, 135.5023], ['京都', 35.0116, 135.7681],
  ['首尔', 37.5665, 126.9780], ['釜山', 35.1796, 129.0756], ['平壤', 39.0392, 125.7625],
  ['曼谷', 13.7563, 100.5018], ['河内', 21.0278, 105.8342], ['胡志明市', 10.8231, 106.6297],
  ['雅加达', -6.2088, 106.8456], ['马尼拉', 14.5995, 120.9842], ['新加坡', 1.3521, 103.8198],
  ['吉隆坡', 3.1390, 101.6869], ['金边', 11.5564, 104.9282], ['万象', 17.9757, 102.6331],
  ['仰光', 16.8661, 96.1951], ['达卡', 23.8103, 90.4125], ['加德满都', 27.7172, 85.3240],
  // 北美
  ['华盛顿', 38.9072, -77.0369], ['纽约', 40.7128, -74.0060], ['洛杉矶', 34.0522, -118.2437],
  ['旧金山', 37.7749, -122.4194], ['芝加哥', 41.8781, -87.6298], ['西雅图', 47.6062, -122.3321],
  ['波士顿', 42.3601, -71.0589], ['迈阿密', 25.7617, -80.1918], ['休斯顿', 29.7604, -95.3698],
  ['多伦多', 43.6510, -79.3470], ['温哥华', 49.2827, -123.1207], ['渥太华', 45.4215, -75.6972],
  ['墨西哥城', 19.4326, -99.1332], ['瓜达拉哈拉', 20.6597, -103.3496],
  // 欧洲
  ['伦敦', 51.5074, -0.1278], ['巴黎', 48.8566, 2.3522], ['柏林', 52.5200, 13.4050],
  ['马德里', 40.4168, -3.7038], ['罗马', 41.9028, 12.4964], ['米兰', 45.4642, 9.1900],
  ['莫斯科', 55.7558, 37.6173], ['圣彼得堡', 59.9311, 30.3609], ['基辅', 50.4501, 30.5234],
  ['布鲁塞尔', 50.8503, 4.3517], ['阿姆斯特丹', 52.3676, 4.9041], ['日内瓦', 46.2044, 6.1432],
  ['苏黎世', 47.3769, 8.5417], ['维也纳', 48.2082, 16.3738], ['华沙', 52.2297, 21.0122],
  ['布达佩斯', 47.4979, 19.0402], ['布拉格', 50.0755, 14.4378], ['雅典', 37.9838, 23.7275],
  ['奥斯陆', 59.9139, 10.7522], ['斯德哥尔摩', 59.3293, 18.0686], ['哥本哈根', 55.6761, 12.5683],
  ['赫尔辛基', 60.1699, 24.9384], ['里斯本', 38.7223, -9.1393], ['都柏林', 53.3498, -6.2603],
  ['雷克雅未克', 64.1466, -21.9426], ['伊斯坦布尔', 41.0082, 28.9784], ['安卡拉', 39.9334, 32.8597],
  // 中东 / 非洲
  ['德黑兰', 35.6892, 51.3890], ['耶路撒冷', 31.7683, 35.2137], ['加沙', 31.5017, 34.4668],
  ['贝鲁特', 33.8938, 35.5018], ['巴格达', 33.3152, 44.3661], ['利雅得', 24.7136, 46.6753],
  ['多哈', 25.2854, 51.5310], ['迪拜', 25.2048, 55.2708], ['阿布扎比', 24.4539, 54.3773],
  ['安曼', 31.9454, 35.9284], ['开罗', 30.0444, 31.2357], ['内罗毕', -1.2921, 36.8219],
  ['拉各斯', 6.5244, 3.3792], ['约翰内斯堡', -26.2041, 28.0473], ['开普敦', -33.9249, 18.4241],
  ['突尼斯', 36.8065, 10.1815], ['阿尔及尔', 36.7538, 3.0588], ['卡萨布兰卡', 33.5731, -7.5898],
  // 大洋洲
  ['悉尼', -33.8688, 151.2093], ['墨尔本', -37.8136, 144.9631], ['堪培拉', -35.2809, 149.1300],
  ['奥克兰', -36.8485, 174.7633], ['惠灵顿', -41.2865, 174.7762],
  // 南美
  ['巴西利亚', -15.7975, -47.8919], ['圣保罗', -23.5505, -46.6333], ['里约热内卢', -22.9068, -43.1729],
  ['布宜诺斯艾利斯', -34.6037, -58.3816], ['利马', -12.0464, -77.0428], ['波哥大', 4.7110, -74.0721],
  ['圣地亚哥', -33.4489, -70.6693], ['加拉加斯', 10.4806, -66.9036], ['蒙得维的亚', -34.9011, -56.1645],
  // 南亚 / 中亚
  ['新德里', 28.6139, 77.2090], ['孟买', 19.0760, 72.8777], ['伊斯兰堡', 33.6844, 73.0479],
  ['卡拉奇', 24.8607, 67.0011], ['科伦坡', 6.9271, 79.8612], ['廷布', 27.4728, 89.6390],
  ['喀布尔', 34.5553, 69.2075], ['塔什干', 41.2995, 69.2401], ['阿拉木图', 43.2220, 76.8512],
  // 国家 / 地区（兜底，用首都或中心坐标）
  ['中国', 35.8617, 104.1954], ['美国', 37.0902, -95.7129], ['俄罗斯', 61.5240, 105.3188],
  ['日本', 36.2048, 138.2529], ['韩国', 35.9078, 127.7669], ['朝鲜', 40.3399, 127.5101],
  ['印度', 20.5937, 78.9629], ['巴基斯坦', 30.3753, 69.3451], ['孟加拉国', 23.6850, 90.3563],
  ['缅甸', 21.9162, 95.9560], ['泰国', 15.8700, 100.9925], ['越南', 14.0583, 108.2772],
  ['菲律宾', 12.8797, 121.7740], ['马来西亚', 4.2105, 101.9758], ['印度尼西亚', -0.7893, 113.9213],
  ['澳大利亚', -25.2744, 133.7751], ['新西兰', -40.9006, 174.8860],
  ['英国', 55.3781, -3.4360], ['法国', 46.2276, 2.2137], ['德国', 51.1657, 10.4515],
  ['意大利', 41.8719, 12.5674], ['西班牙', 40.4637, -3.7492], ['葡萄牙', 39.3999, -8.2245],
  ['荷兰', 52.1326, 5.2913], ['比利时', 50.5039, 4.4699], ['瑞士', 46.8182, 8.2275],
  ['奥地利', 47.5162, 14.5501], ['波兰', 51.9194, 19.1451], ['瑞典', 60.1282, 18.6435],
  ['挪威', 60.4720, 8.4689], ['丹麦', 56.2639, 9.5018], ['芬兰', 61.9241, 25.7482],
  ['爱尔兰', 53.1424, -7.6921], ['冰岛', 64.9631, -19.0208],
  ['乌克兰', 48.3794, 31.1656], ['白俄罗斯', 53.7098, 27.9534], ['罗马尼亚', 45.9432, 24.9668],
  ['捷克', 49.8175, 15.4730], ['匈牙利', 47.1625, 19.5033], ['希腊', 39.0742, 21.8243],
  ['塞尔维亚', 44.0165, 21.0059], ['保加利亚', 42.7339, 25.4858], ['克罗地亚', 45.1000, 15.2000],
  ['土耳其', 38.9637, 35.2433], ['以色列', 31.0461, 34.8516], ['巴勒斯坦', 31.9522, 35.2332],
  ['叙利亚', 34.8021, 38.9968], ['伊拉克', 33.2232, 43.6793], ['伊朗', 32.4279, 53.6880],
  ['黎巴嫩', 33.8547, 35.8623], ['约旦', 30.5852, 36.2384], ['沙特阿拉伯', 23.8859, 45.0792],
  ['阿联酋', 23.4241, 53.8478], ['卡塔尔', 25.3548, 51.1839], ['科威特', 29.3117, 47.4818],
  ['阿曼', 21.4735, 55.9754], ['也门', 15.5527, 48.5164], ['巴林', 26.0667, 50.5577],
  ['埃及', 26.8206, 30.8025], ['南非', -30.5595, 22.9375], ['尼日利亚', 9.0820, 8.6753],
  ['肯尼亚', -0.0236, 37.9062], ['埃塞俄比亚', 9.1450, 40.4897], ['坦桑尼亚', -6.3690, 34.8888],
  ['摩洛哥', 31.7917, -7.0926], ['阿尔及利亚', 28.0339, 1.6596], ['利比亚', 26.3351, 17.2283],
  ['突尼斯国', 33.8869, 9.5375], ['加纳', 7.9465, -1.0232], ['乌干达', 1.3733, 32.2903],
  ['加拿大', 56.1304, -106.3468], ['墨西哥', 23.6345, -102.5528], ['古巴', 21.5218, -77.7812],
  ['巴西', -14.2350, -51.9253], ['阿根廷', -38.4161, -63.6167], ['智利', -35.6751, -71.5430],
  ['秘鲁', -9.1900, -75.0152], ['哥伦比亚', 4.5709, -74.2973], ['委内瑞拉', 6.4238, -66.5897],
  ['厄瓜多尔', -1.8312, -78.1834], ['玻利维亚', -16.2902, -63.5887], ['乌拉圭', -32.5228, -55.7658],
  ['巴拉圭', -23.4425, -58.4438], ['圭亚那', 4.8604, -58.9302], ['苏里南', 3.9193, -56.0278],
  // 地区 / 冲突热点
  ['克里米亚', 45.3453, 34.4997], ['顿巴斯', 48.0021, 37.8053], ['加沙地带', 31.5017, 34.4668],
  ['库尔德斯坦', 36.6380, 43.9830], ['克什米尔', 34.0479, 76.7936], ['台湾海峡', 24.0000, 120.0000],
  ['南海', 12.0000, 115.0000], ['东海', 30.0000, 126.0000], ['中东', 29.2985, 42.5510],
  ['东欧', 51.1657, 24.0000], ['西欧', 48.8566, 4.0000], ['北欧', 62.0000, 15.0000],
  ['东南亚', 4.2105, 101.9758], ['南亚', 20.5937, 78.9629], ['非洲', -8.7832, 34.5085],
  ['拉丁美洲', -4.4420, -61.3269], ['北美洲', 54.5260, -105.2551], ['欧洲', 54.5260, 15.2551],
  ['大洋洲', -22.7359, 140.0188], ['亚洲', 34.0479, 100.6197]
];

function detectLocation(title) {
  if (!title) return null;
  for (const [name, lat, lng] of LOCATION_TABLE) {
    if (title.includes(name)) return { name, lat, lng };
  }
  return null;
}

// 个别机构精确坐标覆盖（发布者官网所在地/总部）
const SOURCE_COORDS_OVERRIDE = {
  'nasa': [38.8833, -77.0164],        // 华盛顿特区 NASA HQ
  'who-news': [46.2342, 6.1490],      // 日内瓦 WHO 总部
  'europarl': [50.8388, 4.3744],      // 布鲁塞尔 欧洲议会
  'xinhua-politics': [39.9123, 116.3972],
  'people-politics': [39.9055, 116.3976],
  'ecns-china': [39.9097, 116.3975],
  'nhk-world': [35.6586, 139.7454],   // 东京 NHK
  'nhk-domestic': [35.6586, 139.7454],
  'japan-times': [35.6850, 139.7516]  // 东京
};

function getSourceCoords(src) {
  if (!src) return null;
  if (SOURCE_COORDS_OVERRIDE[src.id]) return SOURCE_COORDS_OVERRIDE[src.id];
  const country = src.profile && src.profile.country;
  if (country && COUNTRY_COORDS[country]) return COUNTRY_COORDS[country];
  return null;
}

// 兼容浏览器（<script>）与 Node（require）
(function (global) {
  const API = {
    NEWS_SOURCES, HOT_SOURCES, CATEGORY_NAMES, REGION_NAMES, POLITICAL_LEAN_NAMES,
    COUNTRY_COORDS, SOURCE_COORDS_OVERRIDE, getSourceCoords,
    LOCATION_TABLE, detectLocation
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.SOURCES = API;
})(typeof window !== 'undefined' ? window : globalThis);
