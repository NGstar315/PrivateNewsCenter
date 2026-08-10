# 上传到 Gitee 教程（备用更新源）

本教程说明如何把「实时新闻中心」的更新资源发布到 **Gitee**，作为国内网络下的**备用更新线路**（首选仍是 GitHub）。

> 完成后，用户在客户端「设置 → 更新」里把线路切到「备用」，即可优先从 Gitee 拉取 `version.json` 与更新包。

---

## 一、前置条件

- 已注册 Gitee 账号（https://gitee.com）。
- 已经有一个 **GitHub** 仓库 `NGstar315/PrivateNewsCenter` 并发布过 Release（项目当前已具备，可对照参考）。
- 本地已打好本次版本的三个文件（见第五步的产出路径）。

---

## 二、在 Gitee 创建仓库

1. 登录 Gitee → 右上角「+」→「新建仓库」。
2. 仓库名称填 `PrivateNewsCenter`，勾选「公开」（**必须公开**，否则 raw 与附件无法被客户端访问）。
3. 初始化可不勾选 README（我们稍后会把 `version.json` 提交进去）。
4. 创建完成后，记下你的 **Gitee 用户名**（浏览器地址栏 `gitee.com/这里就是用户名`）。

---

## 三、发布 Release 并上传三个文件

客户端自动更新需要以下三个资源（与 GitHub Release 同名同结构）：

| 文件名 | 说明 | 本地来源 |
| --- | --- | --- |
| `app.asar` | 增量热更新包（网页+后端，约 0.5MB） | `dist/NewsCenter/resources/app.asar` |
| `PrivateNewsCenter-Setup-X.Y.Z.exe` | 安装版（大版本兜底） | `dist-installer/PrivateNewsCenter-Setup-X.Y.Z.exe` |
| `PrivateNewsCenter-Portable-X.Y.Z.exe` | 便携版 | `dist/PrivateNewsCenter-Portable-X.Y.Z.exe` |

步骤：
1. 进入 Gitee 仓库 → 「发行版 / Releases」→「新建发行版」。
2. 标签填 `vX.Y.Z`（例如 `v1.1.8`），与 GitHub 保持一致；标题可写版本号。
3. 把上面**三个文件**拖到「上传附件」区，等待上传完成。
4. 点击「发布」。发布后，附件地址形如：
   `https://gitee.com/<你的用户名>/PrivateNewsCenter/releases/download/vX.Y.Z/app.asar`

---

## 四、提交 version.json 到 Gitee 仓库根目录

客户端读取更新信息的地址是：
`https://gitee.com/<你的用户名>/PrivateNewsCenter/raw/master/version.json`

所以**必须**把 `version.json` 提交到 Gitee 仓库的 `master` 分支根目录：

1. 把本地项目根目录的 `version.json` 复制到 Gitee 仓库（可直接在 Gitee 网页「文件」→「新建文件」，文件名 `version.json`，粘贴内容）。
2. 提交到 `master` 分支。
3. 浏览器打开上面的 raw 地址，确认能看到 JSON 内容（不是 404 页面）。

---

## 五、填入你的 Gitee 用户名（关键）

项目里所有 Gitee 地址都用了占位符 `你的用户名`，需要替换成你的真实用户名。提供两种方式：

### 方式 A：一键替换（推荐）
```bash
node scripts/set_gitee.js <你的Gitee用户名>
```
脚本会替换 `version.json` 与 `updater.js` 中的占位符，并提示替换了几处。

### 方式 B：发布时直接带入
```bash
node scripts/publish.js 1.1.8 <你的Gitee用户名>
```
`publish.js` 第三个参数即为 Gitee 用户名，会直接写进 `version.json` 的 mirror 地址。

### 方式 C：手动替换
在 `version.json` 和 `updater.js` 中，把所有 `你的用户名` 改成你的真实用户名（全局替换即可）。

---

## 六、重新打包 asar（让客户端内置新地址）

改完 `updater.js` 后，**必须重新打包 asar**，否则运行中的客户端仍是旧占位符地址：

```bash
# 方式 1：一键发版（推荐，会重打 asar + 重包安装/便携版 + 聚合并上传文件到 release/）
node scripts/build_release.js 1.1.8 <你的Gitee用户名>

# 方式 2：仅重打 asar（若只想更新内置地址，不动安装包）
node node_modules/asar/bin/asar.js pack .asar_staging dist/NewsCenter/resources/app.asar
```
> 白名单打包细节见 `UPDATE_GUIDE.md`。打包后 `dist/NewsCenter/resources/app.asar` 即为最新。

---

## 七、客户端切换备用线路

1. 打开客户端 →「设置」→「更新」板块。
2. 点击「更新线路」分段开关，把滑块拨到 **「备用」**（即 Gitee）。
3. 点「检查更新」验证：若 GitHub 不可达，会自动回退到 Gitee；当线路设为「备用」时优先访问 Gitee。
4. 切换会即时保存，下次启动沿用。

---

## 八、验证清单

- [ ] Gitee 仓库为**公开**。
- [ ] Release 已上传 `app.asar` / 安装版 / 便携版 三个文件。
- [ ] `version.json` 已提交到 Gitee `master` 根目录，raw 地址可访问。
- [ ] 所有 `你的用户名` 占位符已替换（用方式 A/B/C 之一）。
- [ ] 已重新打包 asar，且 `dist/NewsCenter/resources/app.asar` 内含更新后的 `updater.js`（可 `asar extract` 抽查）。
- [ ] 客户端「更新」板块线路切到「备用」后，「检查更新」能正常拉取。

---

## 九、常见问题

- **Gitee 私有库行不行？** 不行。raw 与 Release 附件都需要公开访问，客户端才能拉取。
- **`raw.githubusercontent` 与 Gitee `raw` 区别？** GitHub 用 `raw.githubusercontent.com`，Gitee 用 `gitee.com/.../raw/分支/`。本项目已分别写死，无需改动路径格式。
- **只填了 GitHub，没填 Gitee 会怎样？** 完全正常——只是没有国内备用线路，全部走 GitHub。
- **切换线路后要不要重装？** 不需要。线路选择保存在本地 `settings.json`，下次启动自动生效；只有大版本（Electron 主.次号变化）才需要重装安装包。
