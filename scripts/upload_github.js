/*
 * scripts/upload_github.js —— 用 GitHub API 自动发版 + 上传附件 + 推送源码
 * ===================================================================
 * 用法（令牌优先级）：
 *   1. 环境变量 GITHUB_TOKEN
 *   2. 本地 .release_tokens.json 的 github 字段（已 gitignore，不入库）
 *   3. node scripts/upload_github.js <GitHub私人访问令牌>
 *
 * 需要的令牌权限（scope）：repo（全仓库读写：建 Release / 上传附件 / 推送代码）
 * 生成地址：https://github.com/settings/tokens （勾 repo）
 *
 * 自动完成：
 *   1. 把当前源码 git push 到 GitHub（master + tag），实现"更新代码库"
 *   2. 在 NGstar315/PrivateNewsCenter 创建 Release vX.Y.Z（已存在则复用）
 *   3. 上传 release/ 下 3 个产物（app.asar / Setup / Portable）作为附件
 *
 * 优势：GitHub 单文件附件上限约 2GB，便携版(~110MB)可正常上传（不像 Gitee 的 100MB 限制）。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const OWNER = 'NGstar315';
const REPO = 'PrivateNewsCenter';
const API = 'https://api.github.com';

// 解析令牌
function resolveToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.release_tokens.json'), 'utf-8'));
    if (cfg.github) return cfg.github;
  } catch (_) {}
  return process.argv[2] || null;
}
const token = resolveToken();
if (!token) {
  console.error('❌ 缺少 GitHub 令牌(PAT)。请二选一：');
  console.error('   1) 在 .release_tokens.json 填入 "github": "<你的PAT>"');
  console.error('   2) 环境变量：set GITHUB_TOKEN=xxx');
  console.error('   生成地址：https://github.com/settings/tokens （勾 repo 权限）');
  process.exit(1);
}

// 读取版本号
let version = '1.1.7';
try { version = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf-8')).version; } catch (_) {}
const tag = 'v' + version;

// 待上传文件：release/ 目录
const releaseDir = path.join(root, 'release');
const candidates = [
  path.join(releaseDir, 'app.asar'),
  path.join(releaseDir, `PrivateNewsCenter-Setup-${version}.exe`),
  path.join(releaseDir, `PrivateNewsCenter-Portable-${version}.exe`),
];
const files = candidates.filter(f => fs.existsSync(f));
if (files.length === 0) {
  console.error('❌ 未在 release/ 找到待上传文件。请先运行：node scripts/build_release.js ' + version + ' NGstar');
  process.exit(1);
}

// GitHub API 封装（带 30s 超时，避免网络半开时无限挂起）
async function gh(method, urlPath, { body, isBinary = false } = {}) {
  const url = `${API}${urlPath}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'newscenter-release',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  let payload;
  if (isBinary) { headers['Content-Type'] = 'application/octet-stream'; payload = body; }
  else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { method, headers, body: payload, signal: ctrl.signal });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

// 获取或创建 Release（GitHub 在 tag 不存在时会自动创建 tag，指向默认分支）
async function getOrCreateRelease() {
  const list = await gh('GET', `/repos/${OWNER}/${REPO}/releases?per_page=100`);
  if (Array.isArray(list.json)) {
    const found = list.json.find(r => r.tag_name === tag);
    if (found) { console.log('ℹ️ Release ' + tag + ' 已存在，复用 id=' + found.id); return found; }
  }
  const created = await gh('POST', `/repos/${OWNER}/${REPO}/releases`, {
    body: { tag_name: tag, name: tag, body: tag + ' 自动发布', draft: false, prerelease: false, target_commitish: 'master' }
  });
  if (created.status === 201 && created.json.id) {
    console.log('✅ 已创建 Release ' + tag + ' (id=' + created.json.id + ')');
    return created.json;
  }
  console.error('❌ 创建 Release 失败：', created.status, JSON.stringify(created.json));
  process.exit(1);
}

// 上传单个文件为 Release 附件（支持大文件，无 100MB 限制）
async function uploadAsset(releaseId, filePath) {
  const name = path.basename(filePath);
  const sizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(1);
  console.log('▶ 上传 ' + name + ' (' + sizeMB + ' MB) ...');
  const buf = fs.readFileSync(filePath);
  const res = await gh('POST', `/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, { isBinary: true, body: buf });
  if (res.status === 201) console.log('  ✅ ' + name + ' 上传成功');
  else console.error('  ❌ ' + name + ' 上传失败：HTTP ' + res.status + ' ' + JSON.stringify(res.json));
}

// 把源码推送到 GitHub（实现"更新代码库"）
function pushCode() {
  console.log('▶ 推送源码到 GitHub (' + OWNER + '/' + REPO + ') ...');
  const remote = `https://${token}@github.com/${OWNER}/${REPO}.git`;
  // 1) 暂存所有改动
  spawnSync('git', ['add', '-A'], { cwd: root, stdio: 'inherit' });
  // 2) 仅当有暂存改动时才提交（避免"无改动"导致后续 push 被跳过）
  const diff = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: root });
  if (diff.status === 0) {
    console.log('ℹ️ 工作区已干净，无需提交，直接推送');
  } else {
    const c = spawnSync('git', ['commit', '-m', `release ${tag}`], { cwd: root, stdio: 'inherit' });
    if (c.status !== 0) console.error('⚠️ git commit 失败（请检查钩子/提交信息），继续尝试推送');
  }
  // 3) 始终尝试推送（已最新则 no-op）
  const p = spawnSync('git', ['push', remote, 'master'], { cwd: root, stdio: 'inherit' });
  if (p.status !== 0) console.error('⚠️ git push 失败（可能网络不可达或与远端冲突）');
  const t = spawnSync('git', ['push', remote, '--tags'], { cwd: root, stdio: 'inherit' });
  if (t.status !== 0) console.error('⚠️ git push --tags 失败');
}

(async () => {
  try {
    console.log('🚀 开始上传到 GitHub：' + OWNER + '/' + REPO + ' @ ' + tag);
    console.log('   待上传文件：' + files.map(f => path.basename(f)).join('、'));
    pushCode(); // 先推代码，让 tag 指向最新提交
    const rel = await getOrCreateRelease();
    for (const f of files) await uploadAsset(rel.id, f);
    console.log('');
    console.log('════════════════════════════════════════════');
    console.log('✅ GitHub 上传流程结束（失败项见上方 ❌）');
    console.log('🔗 Release 页：https://github.com/' + OWNER + '/' + REPO + '/releases/' + tag);
    console.log('════════════════════════════════════════════');
  } catch (e) {
    const net = /fetch failed|network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout|AbortError|getaddrinfo|ECONNRESET/i.test(e.message || '');
    console.error('');
    console.error('════════════════════════════════════════════');
    if (net) {
      console.error('❌ GitHub 网络不可达：无法连接 api.github.com（' + (e.message || e) + '）');
      console.error('   可能原因：当前网络环境无法访问 GitHub（如区域性网络限制）。');
      console.error('   建议：① Gitee 备用源不受影响，发布将继续；② 如需双云端，请在可访问 GitHub 的网络/代理下重试本步。');
    } else {
      console.error('❌ GitHub 上传异常：' + (e.message || e));
    }
    console.error('════════════════════════════════════════════');
    process.exit(1);
  }
})();
