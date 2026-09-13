const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mascotAPI', {
  onState: (cb) => ipcRenderer.on('mascot:state', (_e, payload) => cb(payload)),
  onCaption: (cb) => ipcRenderer.on('mascot:caption', (_e, payload) => cb(payload)),
  // Scroll the caption body at reading pace while a reply is spoken aloud —
  // separate from onCaption so a crawl can be started/stopped without
  // rewriting the text it is scrolling through.
  onCaptionCrawl: (cb) => ipcRenderer.on('mascot:caption-crawl', (_e, payload) => cb(payload)),
  onCaptionCrawlEnd: (cb) => ipcRenderer.on('mascot:caption-crawl-end', () => cb()),
  onSettings: (cb) => ipcRenderer.on('mascot:settings', (_e, payload) => cb(payload)),
  onRecordControl: (cb) => ipcRenderer.on('mascot:record-control', (_e, action) => cb(action)),
  sendAudioChunk: (buffer) => ipcRenderer.send('mascot:audio-chunk', buffer),
  endAudio: () => ipcRenderer.invoke('mascot:audio-end'),
  micOpened: () => ipcRenderer.send('mascot:mic-opened'),
  // `spoke` = did voice-activity detection ever hear sustained real speech
  // this turn. Lets the main process tell "nothing was ever said" apart from
  // "you were heard but STT returned nothing" — only the latter is worth an
  // out-loud apology.
  micClosing: (spoke) => ipcRenderer.send('mascot:mic-closing', !!spoke),
  logVadCalibration: (threshold) => ipcRenderer.send('mascot:vad-calibration', threshold),
  micError: () => ipcRenderer.send('mascot:mic-error'),
  quit: () => ipcRenderer.send('mascot:quit'),
  showContextMenu: () => ipcRenderer.send('mascot:context-menu'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  requestMicrophone: () => ipcRenderer.invoke('mic:request'),
  openMicrophoneSettings: () => ipcRenderer.send('mic:open-settings'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  restart: () => ipcRenderer.send('mascot:restart'),
});
