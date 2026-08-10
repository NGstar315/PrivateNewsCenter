/*
 * scripts/upload_gitee.js —— 用 Gitee API 自动发版 + 上传 + 提交 version.json
 * ===================================================================
 * 用法：node scripts/upload_gitee.js [Gitee私人访问令牌]
 *   或：set GITEE_TOKEN=xxx && node scripts/upload_gitee.js
 *
 * 需要的令牌权限（scope）：projects（读写仓库，用于建 Release / 上传附件 / 提交文件）
 * 生成地址：https://gitee.com/profile/personal_access_tokens
 *
 * 自动完成：
 *   1. 在 NGstar/PrivateNewsCenter 创建 Release vX.Y.Z（已存在则复用）
 *   2. 上传 release/ 目录下 3 个产物（app.asar / Setup / Portable）作为附件
 *   3. 把 version.json 提交/更新到 master 分支（供客户端拉取更新检查）
 *
 * 注意：Gitee 单文件附件有体积上限（约 100MB），若便携版(~110MB)上传失败，
 *       脚本会明确报错，可改用安装版或改用 GitHub 源，不影响 app.asar 与 Setup。
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const OWNER = 'NGstar';
const REPO = 'PrivateNewsCenter';
const API = 'https://gitee.com/api/v5';

const token = process.argv[2] || process.env.GITEE_TOKEN || (() => {
  try { const c = JSON.parse(fs.readFileSync(path.join(root, '.release_tokens.json'), 'utf-8')); return c.gitee || null; } catch (_) { return null; }
})();
if (!token) {
  console.error('❌ 请提供 Gitee 私人访问令牌(PAT)：');
  console.error('   用法：node scripts/upload_gitee.js <你的PAT>');
  console.error('   或先执行：set GITEE_TOKEN=xxx');
  console.error('   生成地址：https://gitee.com/profile/personal_access_tokens （勾选 projects 权限）');
  process.exit(1);
}

// 读取版本号（来自 version.json）
let version = '1.1.7';
try { version = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf-8')).version; } catch (_) {}
const tag = 'v' + version;

// 待上传文件：优先 release/ 目录
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

// 统一的 Gitee API 调用封装（自动附带 access_token）
async function gitee(method, urlPath, { qs = {}, body, isForm = false } = {}) {
  const params = new URLSearchParams({ access_token: token, ...qs });
  const url = `${API}${urlPath}?${params}`;
  const headers = {};
  let payload;
  if (isForm) {
    payload = body; // FormData（让 fetch 自动设置 multipart boundary）
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: res.status, json };
}

// 确保仓库有可用分支：空仓库(gitee 不允许在无提交分支上打 tag)时，
// 先提交 version.json 到 master 以初始化分支，否则建 Release 会 400 “创建标签失败”。
async function ensureMaster() {
  const br = await gitee('GET', `/repos/${OWNER}/${REPO}/branches`, { qs: { per_page: 20 } });
  if (Array.isArray(br.json) && br.json.length > 0) return;
  console.log('ℹ️ 仓库暂无分支，先提交 version.json 初始化 master ...');
  const b64 = Buffer.from(fs.readFileSync(path.join(root, 'version.json'), 'utf-8'), 'utf-8').toString('base64');
  const res = await gitee('POST', `/repos/${OWNER}/${REPO}/contents/version.json`, {
    body: { content: b64, message: 'chore: init version.json (bootstrap master)', branch: 'master' }
  });
  if (res.status === 201) console.log('✅ 已初始化 master 分支');
  else console.error('⚠️ 初始化分支失败：' + res.status + ' ' + JSON.stringify(res.json));
}

// 获取或创建 Release
async function getOrCreateRelease() {
  const listRes = await gitee('GET', `/repos/${OWNER}/${REPO}/releases`, { qs: { per_page: 100 } });
  if (Array.isArray(listRes.json)) {
    const found = listRes.json.find(r => r.tag_name === tag);
    if (found) { console.log('ℹ️ Release ' + tag + ' 已存在，复用 id=' + found.id); return found; }
  }
  const createRes = await gitee('POST', `/repos/${OWNER}/${REPO}/releases`, {
    body: {
      tag_name: tag,
      name: tag,
      body: tag + ' 自动发布（Gitee 镜像源，供国内网络回退）',
      target_commitish: 'master'
    }
  });
  if (createRes.status === 201 && createRes.json.id) {
    console.log('✅ 已创建 Release ' + tag + ' (id=' + createRes.json.id + ')');
    return createRes.json;
  }
  console.error('❌ 创建 Release 失败：', createRes.status, JSON.stringify(createRes.json));
  process.exit(1);
}

// 上传单个文件为 Release 附件
async function uploadFile(releaseId, filePath) {
  const name = path.basename(filePath);
  const sizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(1);
  console.log('▶ 上传 ' + name + ' (' + sizeMB + ' MB) ...');
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(filePath)]), name);
  const res = await gitee('POST', `/repos/${OWNER}/${REPO}/releases/${releaseId}/attach_files`, { isForm: true, body: form });
  if (res.status === 201 || res.status === 200) {
    console.log('  ✅ ' + name + ' 上传成功');
  } else {
    console.error('  ❌ ' + name + ' 上传失败：HTTP ' + res.status + ' ' + JSON.stringify(res.json));
  }
}

// 把 version.json 提交/更新到 master 分支
async function pushVersionJson() {
  const p = path.join(root, 'version.json');
  if (!fs.existsSync(p)) { console.log('⚠️ 未找到 version.json，跳过提交'); return; }
  const b64 = Buffer.from(fs.readFileSync(p, 'utf-8'), 'utf-8').toString('base64');
  const getRes = await gitee('GET', `/repos/${OWNER}/${REPO}/contents/version.json`, { qs: { ref: 'master' } });
  const body = { content: b64, message: 'chore: update version.json to ' + tag, branch: 'master' };
  let res;
  if (getRes.json && getRes.json.sha) {
    body.sha = getRes.json.sha;
    res = await gitee('PUT', `/repos/${OWNER}/${REPO}/contents/version.json`, { body });
  } else {
    res = await gitee('POST', `/repos/${OWNER}/${REPO}/contents/version.json`, { body });
  }
  if (res.status === 200 || res.status === 201) console.log('✅ version.json 已提交到 master');
  else console.error('❌ version.json 提交失败：HTTP ' + res.status + ' ' + JSON.stringify(res.json));
}

(async () => {
  console.log('🚀 开始上传到 Gitee：' + OWNER + '/' + REPO + ' @ ' + tag);
  console.log('   待上传文件：' + files.map(f => path.basename(f)).join('、'));
  await ensureMaster(); // 空仓库先初始化 master，否则建 Release 会失败
  const release = await getOrCreateRelease();
  for (const f of files) await uploadFile(release.id, f);
  await pushVersionJson();
  console.log('');
  console.log('════════════════════════════════════════════');
  console.log('✅ Gitee 上传流程结束（失败项见上方 ❌）');
  console.log('🔗 Release 页：https://gitee.com/' + OWNER + '/' + REPO + '/releases/' + tag);
  console.log('════════════════════════════════════════════');
})();
