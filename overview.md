# 修复概述：程序内新闻正文只显示一小段

## 问题
在程序内点击新闻卡片阅读正文时，只能看到 RSS 摘要里的开头一两段（如 France24 的 `<description>`），而源网页实际有完整长文和图片。

## 根因
`feedparser.js` 只解析 RSS/Atom，很多源（尤其是国外媒体）不会在 RSS 里放完整正文，只放一段 lead/摘要。`app.js` 弹窗直接显示这段摘要，因此很短。

## 修复方案
1. **新增正文提取器**（`assets/feedparser.js`）
   - 用浏览器 `DOMParser` 解析文章原网页 HTML。
   - 先尝试常见正文容器选择器：`article`、`[itemprop="articleBody"]`、`.article-body`、`.post-content`、`.main-content` 等。
   - 未命中时，按 `<p>` 数量 + 文本长度做启发式评分，找出最可能是正文的块。
   - 自动把正文里图片/链接的相对路径补成绝对 URL。

2. **弹窗按需抓取完整正文**（`assets/app.js`）
   - 打开弹窗时，先显示 RSS 自带内容。
   - 若自带正文纯文本不足 600 字符且存在原文链接，后台调用 `DataLayer.fetchText(item.link)` 去源站抓取。
   - 用 `FeedParser.extractArticle` 解析；若结果明显长于原内容，立即替换弹窗正文。
   - 加载过程中显示「正在获取完整正文…」动画；失败或内容更短则保留原内容，不破坏体验。

3. **样式**（`assets/styles.css`）
   - 增加 `.inline-loader` 加载提示动画。

## 修改文件
- `assets/feedparser.js`
- `assets/app.js`
- `assets/styles.css`

## 验证
- 已用 `node --check` 对 `feedparser.js`、`app.js`、`datalayer.js`、`main.js`、`preload.js` 做语法检查，全部通过。
- 沙箱为 headless 环境，无法显示 GUI，因此需用户在真实 Windows 下重新运行 `dist\NewsCenter\NewsCenter.exe`（或 `启动.bat`）查看效果。若后续源码有变动，可再次运行项目根目录的 `build.bat` 重新打包。
