/*
 * scripts/release.js —— 一键发版统一编排（构建 + 双源上传 + GitHub 推代码）
 * ===================================================================
 * 用法：node scripts/release.js <版本号> [Gitee用户名]
 *   例：node scripts/release.js 1.1.8
 *       node scripts/release.js 1.1.8 NGstar
 *
 * 流程：
 *   1. node scripts/build_release.js <版本> [Gitee用户]  —— 提版本 + 重打 asar + 安装版/便携版 exe + 汇总到 release/
 *   2. 若配置了 github 令牌  → 上传到 GitHub（含推送源码）
 *   3. 若配置了 gitee 令牌   → 上传到 Gitee
 *
 * 令牌来源：优先读取环境变量 GITHUB_TOKEN / GITEE_TOKEN（由 DevUI dev-server 透传，
 * 令牌只存于 DevUI 本地，不进项目仓库），回退读取项目根 .release_tokens.json。
 * 缺失某一源则自动跳过该源。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const version = process.argv[2];
if (!version) {
  console.error('❌ 请提供版本号：node scripts/release.js <版本号> [Gitee用户名]');
  process.exit(1);
}
const giteeUser = process.argv[3] || 'NGstar';

// 读取令牌配置：优先使用环境变量（由 DevUI dev-server 透传），回退项目根 .release_tokens.json
let tokens = {};
try { tokens = JSON.parse(fs.readFileSync(path.join(root, '.release_tokens.json'), 'utf-8')); } catch (_) {}
if (process.env.GITHUB_TOKEN) tokens.github = process.env.GITHUB_TOKEN;
if (process.env.GITEE_TOKEN) tokens.gitee = process.env.GITEE_TOKEN;

const env = { ...process.env };
if (tokens.gitee) env.GITEE_TOKEN = tokens.gitee;
if (tokens.github) env.GITHUB_TOKEN = tokens.github;

// 1. 构建
console.log('▶ [1/3] 构建发版产物 v' + version + ' ...');
const build = spawnSync('node', ['scripts/build_release.js', version, giteeUser], { cwd: root, stdio: 'inherit', env });
if (build.status !== 0) { console.error('❌ 构建失败，中止发版'); process.exit(1); }

// 2. GitHub
let ghResult = null;
if (tokens.github) {
  console.log('\n▶ [2/3] 上传到 GitHub ...');
  ghResult = spawnSync('node', ['scripts/upload_github.js'], { cwd: root, stdio: 'inherit', env });
} else {
  console.log('\n⏭️ [2/3] 未配置 GitHub 令牌，跳过（在 .release_tokens.json 填 "github" 后启用）');
}

// 3. Gitee
let giteeResult = null;
if (tokens.gitee) {
  console.log('\n▶ [3/3] 上传到 Gitee ...');
  giteeResult = spawnSync('node', ['scripts/upload_gitee.js'], { cwd: root, stdio: 'inherit', env });
} else {
  console.log('\n⏭️ [3/3] 未配置 Gitee 令牌，跳过（在 .release_tokens.json 填 "gitee" 后启用）');
}

console.log('\n══════════════ 发版结果汇总 ════════════════');
console.log('  构建    ：' + (build.status === 0 ? '✅ 成功' : '❌ 失败'));
console.log('  GitHub ：' + (tokens.github ? (ghResult && ghResult.status === 0 ? '✅ 成功' : '⚠️ 失败/跳过（见上方日志，不影响 Gitee）') : '⏭️ 未配置令牌'));
console.log('  Gitee  ：' + (tokens.gitee ? (giteeResult && giteeResult.status === 0 ? '✅ 成功' : '⚠️ 失败（见上方日志）') : '⏭️ 未配置令牌'));
console.log('════════════════════════════════════════════');
if (build.status !== 0) process.exit(1);
console.log('✅ release.js 执行完毕');
