/*
 * preload.js —— 预加载脚本（安全桥接）
 * ---------------------------------------------------------------
 * 通过 contextBridge 向渲染进程安全暴露方法：
 *   fetchUrl / openExternal（原有）
 *   storage.*（本地文件读写/列表/删除）
 *   imageCache(url)（图片下载到本地，返回 file:// 路径）
 * 不暴露整个 Node / Electron 能力，符合最小权限原则。
 * ---------------------------------------------------------------
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  fetchUrl: (url, opts) => ipcRenderer.invoke('fetch-url', url, opts),
  fetchHotHtml: (url, extraHeaders) => ipcRenderer.invoke('fetch-hot-html', url, extraHeaders),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  appPaths: () => ipcRenderer.invoke('app-paths'),

  storage: {
    read: (file) => ipcRenderer.invoke('storage-read', file),
    write: (file, content) => ipcRenderer.invoke('storage-write', file, content),
    exists: (file) => ipcRenderer.invoke('storage-exists', file),
    list: (dir) => ipcRenderer.invoke('storage-list', dir),
    deleteFile: (file) => ipcRenderer.invoke('storage-delete-file', file),
    deleteDir: (dir, recursive) => ipcRenderer.invoke('storage-delete-dir', dir, recursive),
    dirInfo: (dir) => ipcRenderer.invoke('storage-dir-info', dir),
    clearImageCache: () => ipcRenderer.invoke('storage-clear-image-cache'),
    clearAllCaches: () => ipcRenderer.invoke('storage-clear-all-caches')
  },

  imageCache: (url) => ipcRenderer.invoke('image-cache', url),

  // 系统通知（订阅关键词命中提醒等）
  notify: (title, body) => ipcRenderer.invoke('notify', title, body),

  // OPML 导入 + 备份/恢复
  pickOpml: () => ipcRenderer.invoke('pick-opml'),
  backupData: () => ipcRenderer.invoke('backup-data'),
  listBackups: () => ipcRenderer.invoke('list-backups'),
  restoreData: (name) => ipcRenderer.invoke('restore-data', name),

  // LLM / 云端 TTS / Fever
  llmChat: (opts) => ipcRenderer.invoke('llm-chat', opts),
  ttsCloud: (opts) => ipcRenderer.invoke('tts-cloud', opts),
  restartFeverServer: () => ipcRenderer.invoke('restart-fever'),
  downloadFile: (url) => ipcRenderer.invoke('download-file', url),
  downloadDocument: (url) => ipcRenderer.invoke('download-document', url),
  clearDownloads: () => ipcRenderer.invoke('clear-downloads'),
  downloadsInfo: () => ipcRenderer.invoke('downloads-info'),
  fetchRendered: (url, opts) => ipcRenderer.invoke('fetch-rendered', url, opts),

  // 后台刷新开关（关闭窗口后是否在托盘保留进程自动刷新）
  getBackgroundRefresh: () => ipcRenderer.invoke('get-background-refresh'),
  setBackgroundRefresh: (val) => ipcRenderer.invoke('set-background-refresh', val),

  // 监听系统托盘"刷新新闻+热搜"指令，触发渲染端刷新
  onTrayRefresh: (callback) => {
    ipcRenderer.removeAllListeners('tray-trigger-refresh');
    ipcRenderer.on('tray-trigger-refresh', () => { try { callback(); } catch (_) {} });
  },

  // 轻量自动更新：立即检查 / 下载并替换 / 忽略版本 / 进度 / 监听推送 / 当前版本
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: (info) => ipcRenderer.invoke('download-update', info),
  openUpdateDownload: (url) => ipcRenderer.invoke('open-update-download', url),
  dismissUpdate: (version) => ipcRenderer.invoke('dismiss-update', version),
  onUpdateAvailable: (callback) => {
    ipcRenderer.removeAllListeners('update-available');
    ipcRenderer.on('update-available', (event, info) => { try { callback(info); } catch (_) {} });
  },
  onUpdateProgress: (callback) => {
    ipcRenderer.removeAllListeners('update-progress');
    ipcRenderer.on('update-progress', (event, pct) => { try { callback(pct); } catch (_) {} });
  },
  onUpdateStatusMessage: (callback) => {
    ipcRenderer.removeAllListeners('update-status-message');
    ipcRenderer.on('update-status-message', (event, data) => { try { callback(data); } catch (_) {} });
  },
  currentVersion: () => ipcRenderer.invoke('current-version'),

  isElectron: true
});
