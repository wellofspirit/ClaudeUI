import { BrowserWindow, protocol, ipcMain } from 'electron'
import { join } from 'path'
import { logger, logRing, type LogEntry } from './logger'

const LOG_VIEWER_SCHEME = 'log-viewer'

// ---------------------------------------------------------------------------
// HTML template for the log viewer
// ---------------------------------------------------------------------------

function getLogViewerHTML(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>ClaudeUI Log Viewer</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #0d0d1a;
    --bg-row-alt: #12122a;
    --bg-header: #14142e;
    --border: #2a2a4a;
    --text: #c8c8d4;
    --text-muted: #6a6a8a;
    --text-bright: #e8e8f0;
    --accent: #7c6fe0;
    --level-debug: #5a9bcf;
    --level-info: #68c490;
    --level-warn: #d4a94a;
    --level-error: #d45a5a;
    --source-main: #7c6fe0;
    --source-renderer: #cf8f5a;
    --source-plugin: #5ac4cf;
    --font-mono: 'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace;
  }
  html, body { height: 100%; background: var(--bg); color: var(--text); font-family: var(--font-mono); font-size: 12px; }
  body { display: flex; flex-direction: column; }

  /* Toolbar */
  .toolbar {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; background: var(--bg-header);
    border-bottom: 1px solid var(--border); flex-shrink: 0;
    -webkit-app-region: drag;
  }
  .toolbar > * { -webkit-app-region: no-drag; }
  .toolbar .title { font-size: 13px; font-weight: 600; color: var(--text-bright); margin-right: 8px; }
  .toolbar .count { font-size: 11px; color: var(--text-muted); }
  .toolbar .spacer { flex: 1; }

  /* Filter controls */
  .filter-btn {
    padding: 2px 8px; border-radius: 4px; border: 1px solid var(--border);
    background: transparent; color: var(--text-muted); cursor: pointer;
    font-family: var(--font-mono); font-size: 11px; transition: all 0.15s;
  }
  .filter-btn:hover { border-color: var(--accent); color: var(--text); }
  .filter-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .filter-btn.level-debug.active { background: var(--level-debug); border-color: var(--level-debug); }
  .filter-btn.level-info.active { background: var(--level-info); border-color: var(--level-info); }
  .filter-btn.level-warn.active { background: var(--level-warn); border-color: var(--level-warn); }
  .filter-btn.level-error.active { background: var(--level-error); border-color: var(--level-error); }

  .search-input {
    padding: 2px 8px; border-radius: 4px; border: 1px solid var(--border);
    background: var(--bg); color: var(--text); font-family: var(--font-mono);
    font-size: 11px; width: 180px; outline: none;
  }
  .search-input:focus { border-color: var(--accent); }

  .clear-btn {
    padding: 2px 10px; border-radius: 4px; border: 1px solid var(--border);
    background: transparent; color: var(--text-muted); cursor: pointer;
    font-family: var(--font-mono); font-size: 11px;
  }
  .clear-btn:hover { border-color: #d45a5a; color: #d45a5a; }

  /* Log area */
  .log-area {
    flex: 1; overflow-y: auto; overflow-x: hidden;
    padding: 0; font-size: 12px; line-height: 1.5;
  }
  .log-area::-webkit-scrollbar { width: 8px; }
  .log-area::-webkit-scrollbar-track { background: transparent; }
  .log-area::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
  .log-area::-webkit-scrollbar-thumb:hover { background: #3a3a5a; }

  /* Log entry */
  .log-entry {
    display: flex; padding: 1px 12px; border-bottom: 1px solid transparent;
    white-space: pre-wrap; word-break: break-all;
  }
  .log-entry:nth-child(even) { background: var(--bg-row-alt); }
  .log-entry:hover { background: #1a1a3a; }
  .log-entry.hidden { display: none; }

  .log-ts { color: var(--text-muted); flex-shrink: 0; width: 100px; user-select: all; }
  .log-level {
    flex-shrink: 0; width: 52px; font-weight: 600; text-transform: uppercase;
    text-align: center; border-radius: 3px; margin: 1px 4px 1px 0; padding: 0 2px;
  }
  .log-level.debug { color: var(--level-debug); }
  .log-level.info { color: var(--level-info); }
  .log-level.warn { color: var(--level-warn); }
  .log-level.error { color: var(--level-error); background: rgba(212,90,90,0.1); }
  .log-source { color: var(--source-main); flex-shrink: 0; min-width: 120px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; margin-right: 8px; }
  .log-source.renderer { color: var(--source-renderer); }
  .log-source.plugin { color: var(--source-plugin); }
  .log-msg { color: var(--text); flex: 1; min-width: 0; }
  .log-msg .err { color: var(--level-error); opacity: 0.8; display: block; padding-left: 12px; }

  /* Scroll indicator */
  .scroll-indicator {
    position: fixed; bottom: 16px; right: 24px;
    padding: 6px 16px; border-radius: 6px;
    background: var(--accent); color: #fff; font-size: 11px;
    cursor: pointer; display: none; z-index: 10;
    box-shadow: 0 2px 8px rgba(0,0,0,0.4);
  }
  .scroll-indicator:hover { opacity: 0.9; }
  .scroll-indicator.visible { display: block; }
</style>
</head>
<body>
  <div class="toolbar">
    <span class="title">Log Viewer</span>
    <button class="filter-btn level-debug active" data-level="debug">DBG</button>
    <button class="filter-btn level-info active" data-level="info">INF</button>
    <button class="filter-btn level-warn active" data-level="warn">WRN</button>
    <button class="filter-btn level-error active" data-level="error">ERR</button>
    <input class="search-input" placeholder="Filter source..." />
    <span class="spacer"></span>
    <span class="count" id="count">0 entries</span>
    <button class="clear-btn" id="clear">Clear</button>
  </div>
  <div class="log-area" id="log-area"></div>
  <div class="scroll-indicator" id="scroll-ind">New entries below</div>

<script>
  const logArea = document.getElementById('log-area');
  const countEl = document.getElementById('count');
  const scrollInd = document.getElementById('scroll-ind');
  const searchInput = document.querySelector('.search-input');
  const levelButtons = document.querySelectorAll('.filter-btn[data-level]');
  const clearBtn = document.getElementById('clear');

  let autoScroll = true;
  let totalCount = 0;
  const activeLevels = new Set(['debug', 'info', 'warn', 'error']);

  // Source class determination
  function sourceClass(src) {
    if (src === 'renderer' || src === 'renderer:error') return 'renderer';
    if (src.startsWith('plugin:')) return 'plugin';
    return '';
  }

  function createEntryEl(entry) {
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.dataset.level = entry.level;
    div.dataset.source = entry.source;

    let msgHtml = escapeHtml(entry.message);
    if (entry.error) {
      msgHtml += '<span class="err">' + escapeHtml(entry.error) + '</span>';
    }

    div.innerHTML =
      '<span class="log-ts">' + escapeHtml(entry.timestamp) + '</span>' +
      '<span class="log-level ' + entry.level + '">' + entry.level.toUpperCase().padEnd(5) + '</span>' +
      '<span class="log-source ' + sourceClass(entry.source) + '" title="' + escapeHtml(entry.source) + '">' + escapeHtml(entry.source) + '</span>' +
      '<span class="log-msg">' + msgHtml + '</span>';

    return div;
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function applyFilters(el) {
    const level = el.dataset.level;
    const source = el.dataset.source;
    const searchTerm = searchInput.value.toLowerCase();
    const levelOk = activeLevels.has(level);
    const searchOk = !searchTerm || source.toLowerCase().includes(searchTerm);
    el.classList.toggle('hidden', !(levelOk && searchOk));
  }

  function refilterAll() {
    for (const el of logArea.children) {
      applyFilters(el);
    }
  }

  function addEntry(entry) {
    totalCount++;
    const el = createEntryEl(entry);
    applyFilters(el);
    logArea.appendChild(el);
    countEl.textContent = totalCount + ' entries';

    if (autoScroll) {
      logArea.scrollTop = logArea.scrollHeight;
    } else {
      scrollInd.classList.add('visible');
    }
  }

  function addBatch(entries) {
    const frag = document.createDocumentFragment();
    for (const entry of entries) {
      totalCount++;
      const el = createEntryEl(entry);
      applyFilters(el);
      frag.appendChild(el);
    }
    logArea.appendChild(frag);
    countEl.textContent = totalCount + ' entries';
    if (autoScroll) logArea.scrollTop = logArea.scrollHeight;
  }

  // Scroll detection
  logArea.addEventListener('scroll', () => {
    const atBottom = logArea.scrollHeight - logArea.scrollTop - logArea.clientHeight < 40;
    autoScroll = atBottom;
    if (atBottom) scrollInd.classList.remove('visible');
  });

  scrollInd.addEventListener('click', () => {
    logArea.scrollTop = logArea.scrollHeight;
    autoScroll = true;
    scrollInd.classList.remove('visible');
  });

  // Level filter buttons
  levelButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const level = btn.dataset.level;
      if (activeLevels.has(level)) {
        activeLevels.delete(level);
        btn.classList.remove('active');
      } else {
        activeLevels.add(level);
        btn.classList.add('active');
      }
      refilterAll();
    });
  });

  // Search filter
  searchInput.addEventListener('input', () => refilterAll());

  // Clear
  clearBtn.addEventListener('click', () => {
    logArea.innerHTML = '';
    totalCount = 0;
    countEl.textContent = '0 entries';
  });

  // IPC bridge — populated by preload
  if (window.logViewerApi) {
    window.logViewerApi.onBatch((entries) => addBatch(entries));
    window.logViewerApi.onEntry((entry) => addEntry(entry));
    window.logViewerApi.ready();
  }
</script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// LogViewer service
// ---------------------------------------------------------------------------

export class LogViewer {
  private win: BrowserWindow | null = null
  private unsubLogger: (() => void) | null = null
  private static protocolRegistered = false

  constructor(mainWindow: BrowserWindow) {

    // Forward live log entries to the viewer window (if open).
    // logRing (in logger.ts) captures ALL entries from process start,
    // so the viewer can catch up even for entries before this point.
    this.unsubLogger = logger.subscribe((entry) => {
      if (this.win && !this.win.isDestroyed()) {
        this.win.webContents.send('log-viewer:entry', entry)
      }
    })

    // Capture renderer console messages (Event object API)
    mainWindow.webContents.on('console-message', (event) => {
      const { level, message, lineNumber, sourceId } = event
      const mappedLevel = level === 'warning' ? 'warn' : level  // normalize 'warning' → 'warn'
      const entry: LogEntry = {
        timestamp: new Date().toISOString().slice(11, 23),
        level: mappedLevel as LogEntry['level'],
        source: level === 'error' ? 'renderer:error' : 'renderer',
        message: sourceId ? `${message}  (${sourceId}:${lineNumber})` : message
      }
      logRing.push(entry)
      if (this.win && !this.win.isDestroyed()) {
        this.win.webContents.send('log-viewer:entry', entry)
      }
    })

    // Register the custom protocol (once globally)
    if (!LogViewer.protocolRegistered) {
      protocol.handle(LOG_VIEWER_SCHEME, () => {
        return new Response(getLogViewerHTML(), {
          headers: { 'content-type': 'text/html; charset=utf-8' }
        })
      })
      LogViewer.protocolRegistered = true
    }

    // Register IPC handlers
    ipcMain.removeHandler('log-viewer:open')
    ipcMain.handle('log-viewer:open', () => this.open())

    ipcMain.removeHandler('log-viewer:ready')
    ipcMain.handle('log-viewer:ready', () => {
      // Viewer opened — send buffered entries
      if (this.win && !this.win.isDestroyed()) {
        this.win.webContents.send('log-viewer:batch', logRing.toArray())
      }
    })
  }

  open(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.focus()
      return
    }

    this.win = new BrowserWindow({
      width: 1100,
      height: 650,
      minWidth: 600,
      minHeight: 300,
      title: 'ClaudeUI Log Viewer',
      backgroundColor: '#0d0d1a',
      webPreferences: {
        preload: join(__dirname, '../preload/log-viewer-preload.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      },
      // Don't show in taskbar as a separate app on macOS
      ...(process.platform === 'darwin' ? { type: 'panel' } : {})
    })

    this.win.setMenuBarVisibility(false)
    this.win.loadURL(`${LOG_VIEWER_SCHEME}://viewer`)

    this.win.on('closed', () => {
      this.win = null
    })
  }

  close(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.close()
      this.win = null
    }
  }

  destroy(): void {
    if (this.unsubLogger) {
      this.unsubLogger()
      this.unsubLogger = null
    }
    this.close()
  }
}
