const { contextBridge, ipcRenderer } = require('electron');
const { marked } = require('marked');
const DOMPurify = require('dompurify')(window);

marked.use({ gfm: true, breaks: false });

contextBridge.exposeInMainWorld('api', {
  loadCampaign: () => ipcRenderer.invoke('campaign:load'),
  listMarkdownFiles: () => ipcRenderer.invoke('list-markdown-files'),
  listMapFiles: () => ipcRenderer.invoke('list-map-files'),
  readFile: (f) => ipcRenderer.invoke('read-file', f),
  openPdfAt: (page) => ipcRenderer.invoke('open-pdf-at', page),

  loadState: () => ipcRenderer.invoke('load-state'),
  saveState: (s) => ipcRenderer.invoke('save-state', s),
  loadHotspots: () => ipcRenderer.invoke('load-hotspots'),
  saveHotspots: (h) => ipcRenderer.invoke('save-hotspots', h),
  loadWorld: () => ipcRenderer.invoke('load-world'),
  saveWorld: (w) => ipcRenderer.invoke('save-world', w),

  parseMarkdown: (t) => DOMPurify.sanitize(marked.parse(t || '')),
  mapUrl: (f) => 'gmapp://maps/' + f.split('/').map(encodeURIComponent).join('/'),

  onFileChanged: (cb) => ipcRenderer.on('file-changed', (_e, d) => cb(d)),
  offFileChanged: () => ipcRenderer.removeAllListeners('file-changed'),

  ingestLoadSettings: () => ipcRenderer.invoke('ingest:load-settings'),
  ingestSaveSettings: (s) => ipcRenderer.invoke('ingest:save-settings', s),
  ingestCheckDeps: () => ipcRenderer.invoke('ingest:check-deps'),
  ingestPickFile: () => ipcRenderer.invoke('ingest:pick-file'),
  ingestSetupVenv: () => ipcRenderer.invoke('ingest:setup-venv'),
  ingestRunFfmpeg: (src, n) => ipcRenderer.invoke('ingest:run-ffmpeg', src, n),
  ingestRunWhisperx: (wav, n, tok) => ipcRenderer.invoke('ingest:run-whisperx', wav, n, tok),
  ingestCopyTranscript: (src, name) => ipcRenderer.invoke('ingest:copy-transcript', src, name),
  onIngestLog: (cb) => ipcRenderer.on('ingest:log', (_e, d) => cb(d)),
  offIngestLog: () => ipcRenderer.removeAllListeners('ingest:log'),
});
