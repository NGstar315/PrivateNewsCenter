/*
 * scripts/build_release.js —— 一键发版打包
 * ------------------------------------------------
 * 用法：node scripts/build_release.js 1.1.8
 *
 * 自动完成：
 *   1. 提升 package.json / installer.nsi / portable.nsi / version.json 版本号
 *   2. 用白名单 staging 打包 dist/app.asar（增量热更新包，内含红线防护）
 *   3. 覆盖 dist/NewsCenter/resources/app.asar（运行时）
 *   4. makensis 重打安装版 + 便携版（工具缺失则警告跳过）
 *   5. 生成英文命名副本（跨设备分发稳定，避免中文名上传丢名）
 *   6. 若本机装有 gh CLI 且已登录，自动创建/更新 GitHub Release 并上传
 *
 * 🔴 红线：绝不允许把 dist/ 或项目根整体 pack，只允许 pack 白名单 staging，
 *         否则会把 Electron 运行时 + 个人 data 压成数百 MB 的假 asar。
 *
 * 发版后仍需手动做的：git push（把 version.json 推到 master，否则客户端拉不到新版本号）
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { bumpVersion } = require('./publish');

const root = path.resolve(__dirname, '..');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}
function runCapture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'pipe', ...opts }).toString();
}

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error('用法：node scripts/build_release.js 1.1.8');
  process.exit(1);
}

// 1. 版本提升（透传可选的第 3 个参数 Gitee 用户名，避免 mirror 地址被重置成占位符）
console.log('▶ 提升版本号至 v' + version);
bumpVersion(version, process.argv[3]);

// 2. staging 白名单打包 app.asar
const STAGING = path.join(root, '.release_staging');
const ROOT_FILES = ['main.js', 'preload.js', 'index.html', 'version.json', 'package.json', 'updater.js'];
const ASSET_FILES = ['app.js', 'sources.js', 'feedparser.js', 'datalayer.js', 'store.js', 'styles.css', 'chart.umd.min.js', 'tray-icon.png'];

fs.rmSync(STAGING, { recursive: true, force: true });
fs.mkdirSync(path.join(STAGING, 'assets'), { recursive: true });
for (const f of ROOT_FILES) {
  if (!fs.existsSync(path.join(root, f))) { console.error('❌ 缺少根文件：' + f); process.exit(1); }
  fs.copyFileSync(path.join(root, f), path.join(STAGING, f));
}
for (const f of ASSET_FILES) {
  if (!fs.existsSync(path.join(root, 'assets', f))) { console.error('❌ 缺少 assets：' + f); process.exit(1); }
  fs.copyFileSync(path.join(root, 'assets', f), path.join(STAGING, 'assets', f));
}

const asarBin = path.join(root, 'node_modules', 'asar', 'bin', 'asar.js');
const outAsar = path.join(root, 'dist', 'app.asar');

// 🔴 红线：只允许 pack 白名单 staging，绝不允许 pack dist/ 或项目根
run('node', [asarBin, 'pack', STAGING, outAsar]);

// 验证：关键文件齐全 + 无禁止内容混入
// 统一为正斜杠，兼容 Windows/Linux 的 asar list 输出差异
const listed = runCapture('node', [asarBin, 'list', outAsar]).replace(/\\/g, '/');
const MUST = ['updater.js', 'main.js', 'preload.js', 'index.html', 'version.json', 'assets/app.js', 'assets/datalayer.js', 'assets/store.js'];
const missing = MUST.filter(m => !listed.includes(m));
if (missing.length) {
  console.error('❌ asar 缺少关键文件：' + missing.join(', '));
  process.exit(1);
}
// 🔴 红线：asar 内绝不能混入 node_modules / 个人 data / Electron 运行时 exe
const badLines = listed.split('\n').filter(l => l.includes('node_modules/') || l.includes('NewsCenter.exe') || l.includes('/data/'));
if (badLines.length) {
  console.error('❌ asar 混入了禁止内容（node_modules/data/exe），打包中止！\n' + badLines.join('\n'));
  process.exit(1);
}
console.log('✅ app.asar 打包验证通过（' + (fs.statSync(outAsar).size / 1024).toFixed(0) + ' KB）');

// 3. 覆盖运行时 resources/app.asar
fs.copyFileSync(outAsar, path.join(root, 'dist', 'NewsCenter', 'resources', 'app.asar'));

// 4. makensis 重打安装版 + 便携版
const MAK = process.env.MAKENSIS || 'C:/Users/TravisLu/AppData/Local/electron-builder/Cache/nsis/nsis-3.0.4.1/makensis.exe';
if (fs.existsSync(MAK)) {
  console.log('▶ 打包安装版...');
  run(MAK, [path.join(root, 'installer.nsi')], { timeout: 600000 });
  console.log('▶ 打包便携版...');
  run(MAK, [path.join(root, 'portable.nsi')], { timeout: 600000 });
} else {
  console.log('⚠️ 未找到 makensis（' + MAK + '），跳过 exe 打包。请设置环境变量 MAKENSIS 或安装 NSIS 后重跑。');
}

// 5. 英文命名副本（跨设备分发稳定）
const setupSrc = path.join(root, 'dist-installer', '实时新闻中心-Setup-' + version + '.exe');
const setupDst = path.join(root, 'dist-installer', 'PrivateNewsCenter-Setup-' + version + '.exe');
const portSrc = path.join(root, 'dist', '实时新闻中心.exe');
const portDst = path.join(root, 'dist', 'PrivateNewsCenter-Portable-' + version + '.exe');
try {
  if (fs.existsSync(setupSrc)) fs.copyFileSync(setupSrc, setupDst);
  else console.log('⚠️ 安装版未生成，跳过英文副本：' + path.basename(setupSrc));
  if (fs.existsSync(portSrc)) fs.copyFileSync(portSrc, portDst);
  else console.log('⚠️ 便携版未生成，跳过英文副本：' + path.basename(portSrc));
} catch (e) { console.log('⚠️ 英文副本生成失败：' + e.message); }

// 6. gh 自动上传（可选）
function ghAvailable() {
  try { execFileSync('gh', ['--version'], { stdio: 'pipe' }); return true; } catch { return false; }
}
const files = [outAsar, setupDst, portDst].filter(f => fs.existsSync(f));
if (ghAvailable()) {
  const tag = 'v' + version;
  try {
    run('gh', ['release', 'create', tag, ...files, '--title', 'v' + version, '-n', 'v' + version], { stdio: 'inherit' });
    console.log('✅ 已通过 gh 创建 Release 并上传 ' + files.length + ' 个文件');
  } catch (e) {
    try {
      run('gh', ['release', 'upload', tag, ...files, '--clobber'], { stdio: 'inherit' });
      console.log('✅ 已通过 gh 覆盖上传到已有 Release ' + tag);
    } catch (e2) {
      console.log('⚠️ gh 上传失败，请手动上传：\n  ' + files.join('\n  '));
    }
  }
} else {
  console.log('');
  console.log('ℹ️ 未检测到 gh CLI，请从下方 release/ 目录手动上传这 ' + files.length + ' 个文件到 GitHub Release v' + version);
  console.log('（装了 gh 并 gh auth login 后，本脚本会自动上传，无需手动）');
}

// 7. 汇总到 release/ 待上传目录（每次清空重建，方便查看与清理）
const RELEASE_DIR = path.join(root, 'release');
try { fs.rmSync(RELEASE_DIR, { recursive: true, force: true }); } catch (_) {}
fs.mkdirSync(RELEASE_DIR, { recursive: true });
const collected = [];
for (const f of [outAsar, setupDst, portDst]) {
  if (fs.existsSync(f)) {
    const dest = path.join(RELEASE_DIR, path.basename(f));
    fs.copyFileSync(f, dest);
    collected.push(path.basename(f));
  }
}
console.log('📦 待上传文件已汇总到 release/ 目录：');
collected.forEach(n => console.log('  ' + n));

// 清理临时目录
try { fs.rmSync(STAGING, { recursive: true, force: true }); } catch (_) {}

console.log('');
console.log('════════════════════════════════════════════');
console.log('✅ 发版产物生成完成');
console.log('📂 待上传文件已全部汇总到 release/ 目录');
console.log('🔔 别忘了：git push（把 version.json 推到 master，客户端才能拉到新版本号）');
console.log('════════════════════════════════════════════');
