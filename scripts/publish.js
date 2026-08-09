/*
 * scripts/publish.js —— 发布辅助脚本
 * ---------------------------------------------------------------
 * 用法：node scripts/publish.js [版本号]
 * 示例：node scripts/publish.js 1.1.8
 *
 * 该脚本会：
 *   1. 更新 package.json 和 installer.nsi / portable.nsi 中的版本号。
 *   2. 生成/更新 version.json（用于客户端自动更新检查）。
 *   3. 提示你手动运行 makensis 打包（因为 NSIS 工具需本机路径）。
 *
 * 发布到 GitHub / Gitee 后：
 *   - 把生成的安装包上传到 Release Assets。
 *   - 把 version.json 放到仓库根目录或你的 CDN，让客户端能拉取到。
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(p) { return fs.readFileSync(path.join(root, p), 'utf-8'); }
function write(p, c) { fs.writeFileSync(path.join(root, p), c, 'utf-8'); }

function bumpVersion(newVersion) {
  // package.json
  const pkgPath = 'package.json';
  const pkg = JSON.parse(read(pkgPath));
  pkg.version = newVersion;
  write(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  // installer.nsi
  ['installer.nsi', 'portable.nsi'].forEach(nsiFile => {
    const p = path.join(root, nsiFile);
    if (!fs.existsSync(p)) return;
    let c = read(nsiFile);
    c = c.replace(/!define APPVERSION "[^"]+"/, `!define APPVERSION "${newVersion}"`);
    write(nsiFile, c);
  });

  // version.json（增量热更新 schema）
  const versionPath = 'version.json';
  let v = {};
  if (fs.existsSync(path.join(root, versionPath))) {
    try { v = JSON.parse(read(versionPath)); } catch (_) {}
  }
  const ghBase = `https://github.com/NGstar315/PrivateNewsCenter/releases/download/v${newVersion}`;
  const gtBase = `https://gitee.com/你的用户名/PrivateNewsCenter/releases/download/v${newVersion}`;
  v.version = newVersion;
  v.asar = {
    url: `${ghBase}/app.asar`,
    mirror: `${gtBase}/app.asar`
  };
  v.installer = {
    url: `${ghBase}/PrivateNewsCenter-Setup-${newVersion}.exe`,
    mirror: `${gtBase}/PrivateNewsCenter-Setup-${newVersion}.exe`
  };
  // electronVersion 取 package.json 的 electron 主.次号（补丁号变化不触发完整重装）
  const elec = (pkg.devDependencies && pkg.devDependencies.electron) || (pkg.dependencies && pkg.dependencies.electron) || '';
  const mm = elec.match(/(\d+)\.(\d+)/);
  if (mm) v.electronVersion = `${mm[1]}.${mm[2]}`;
  write(versionPath, JSON.stringify(v, null, 2) + '\n');

  console.log(`版本已更新为 v${newVersion}`);
  console.log('下一步：');
  console.log('  1. 打包并生成 dist/NewsCenter/resources/app.asar（增量包）与 dist-installer/PrivateNewsCenter-Setup-' + newVersion + '.exe');
  console.log('  2. 把 app.asar、安装包、便携版上传到 GitHub / Gitee Release。');
  console.log('  3. 把 version.json 提交到仓库根目录或上传到你的更新服务器。');
}

const v = process.argv[2];
if (!v || !/^\d+\.\d+\.\d+/.test(v)) {
  console.error('请提供版本号，例如：node scripts/publish.js 1.1.8');
  process.exit(1);
}
bumpVersion(v);
