/*
 * scripts/set_gitee.js —— 一键填入 Gitee 用户名（辅助脚本）
 * ---------------------------------------------------------------
 * 用法：node scripts/set_gitee.js <你的Gitee用户名>
 * 示例：node scripts/set_gitee.js my-gitee-id
 *
 * 作用：把项目里所有 `你的用户名` 占位符替换成你的真实 Gitee 用户名，
 *       覆盖两个文件：
 *         - version.json        （增量更新的 mirror 下载地址）
 *         - updater.js          （主进程读取 Gitee version.json 的地址）
 *       替换后请重新打包 asar（见 GITEE_GUIDE.md）。
 *
 * 注意：只替换占位符，不会改动其它内容；若已填过则提示跳过。
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const PLACEHOLDER = '你的用户名';

function replaceInFile(relPath, user) {
  const full = path.join(root, relPath);
  if (!fs.existsSync(full)) {
    console.log('⚠️  跳过（文件不存在）：' + relPath);
    return;
  }
  const text = fs.readFileSync(full, 'utf-8');
  if (!text.includes(PLACEHOLDER)) {
    console.log('ℹ️  无需替换（已填或无占位符）：' + relPath);
    return;
  }
  const updated = text.split(PLACEHOLDER).join(user);
  fs.writeFileSync(full, updated, 'utf-8');
  const count = (text.match(new RegExp(PLACEHOLDER, 'g')) || []).length;
  console.log(`✅ ${relPath}：替换 ${count} 处为「${user}」`);
}

const user = process.argv[2];
if (!user || /[\s/\\]/.test(user)) {
  console.error('请提供合法的 Gitee 用户名，例如：node scripts/set_gitee.js my-gitee-id');
  process.exit(1);
}

console.log('开始填入 Gitee 用户名：' + user + '\n');
replaceInFile('version.json', user);
replaceInFile('updater.js', user);
console.log('\n下一步：按 GITEE_GUIDE.md 在 Gitee 发布同版本 Release 并上传三个文件，然后重新打包 asar。');
