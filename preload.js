const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hek', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (v) => ipcRenderer.invoke('settings:set', v),
  loadChats: () => ipcRenderer.invoke('chats:load'),
  saveChats: (v) => ipcRenderer.invoke('chats:save', v),
  loadWorks: () => ipcRenderer.invoke('works:load'),
  saveWorks: (v) => ipcRenderer.invoke('works:save', v),
  runAgent: (messages) => ipcRenderer.invoke('agent:run', messages),
  stopAgent: () => ipcRenderer.invoke('agent:stop'),
  answerPermission: (id, ok) => ipcRenderer.invoke('permission:answer', id, ok),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  answerClarify: (id, text) => ipcRenderer.invoke('clarify:answer', id, text),
  listSkills: () => ipcRenderer.invoke('skills:list'),
  cronList: () => ipcRenderer.invoke('cron:list'),
  cronAction: (a) => ipcRenderer.invoke('cron:action', a),
  toolsInfo: () => ipcRenderer.invoke('tools:info'),
  openToolsDir: (what) => ipcRenderer.invoke('tools:open', what),
  compressChat: (messages) => ipcRenderer.invoke('chat:compress', messages),
  onEvent: (cb) => ipcRenderer.on('agent:event', (_e, d) => cb(d)),

  // File picker
  pickFiles: () => ipcRenderer.invoke('dialog:openFile'),
  pickFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    reload: () => ipcRenderer.invoke('plugins:reload'),
    toggle: (name, on) => ipcRenderer.invoke('plugins:toggle', name, on),
    remove: (name) => ipcRenderer.invoke('plugins:remove', name),
    pick: (kind) => ipcRenderer.invoke('plugins:pick', kind),
    installCode: (name, code) => ipcRenderer.invoke('plugins:installCode', name, code),
    example: () => ipcRenderer.invoke('plugins:example'),
    exampleCode: () => ipcRenderer.invoke('plugins:exampleCode'),
    openDir: () => ipcRenderer.invoke('plugins:open'),
  },
  // Read file inline (for @ mentions — expand @path to file content)
  readInline: (filePath) => ipcRenderer.invoke('file:readInline', filePath),

  // Telegram
  telegramStart: () => ipcRenderer.invoke('telegram:start'),
  telegramStop: () => ipcRenderer.invoke('telegram:stop'),
  telegramStatus: () => ipcRenderer.invoke('telegram:status'),
  telegramTest: (token, proxyUrl) => ipcRenderer.invoke('telegram:test', token, proxyUrl),
  onTelegramStatus: (cb) => ipcRenderer.on('telegram:status', (_e, d) => cb(d)),

  // TTS — OpenAI-compatible /audio/speech endpoint. Returns { audio: Uint8Array }
  // or { error: string }.
  // Misc
  nodeVersion: () => process.versions.node,
  electronVersion: () => process.versions.electron,
  chromeVersion: () => process.versions.chrome,
});
