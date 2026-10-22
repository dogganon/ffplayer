import { MediaViewer, reportError } from './media-viewer.js';

const SETTINGS_KEY = 'ffplayer.viewer.settings.v1';

const app = document.querySelector('#app');
app.innerHTML = `
  <div class="browser-host">
    <div class="topbar">
      <label class="file-button">
        <span>Open file</span>
        <input id="file" type="file" multiple />
      </label>
      <label class="file-button">
        <span>Open directory</span>
        <input id="directory" type="file" multiple webkitdirectory />
      </label>
      <button id="url-toggle" type="button" aria-expanded="false" aria-controls="url-form">Open URL</button>
      <form id="url-form" class="url-form" hidden>
        <input id="media-url" type="url" required placeholder="https://example.com/video.mp4" aria-label="Media URL" />
        <button type="submit">Open</button>
      </form>
    </div>
    <div class="drop-hint">Drop media files or a link anywhere to open</div>
    <div id="browser-shell" class="browser-shell">
      <aside id="playlist" class="playlist"></aside>
      <section id="viewer" class="viewer"></section>
    </div>
  </div>
`;

const viewer = new MediaViewer(document.querySelector('#viewer'), {
  settings: loadSettings(),
  onSettingsChange: saveSettings,
});
const fileInput = document.querySelector('#file');
const directoryInput = document.querySelector('#directory');
const browserShell = document.querySelector('#browser-shell');
const playlistEl = document.querySelector('#playlist');
let playlist = [];
let selection = 0;
let pendingDownload;
const host = document.querySelector('.browser-host');
const urlInput = document.querySelector('#media-url');
const urlForm = document.querySelector('#url-form');
const urlToggle = document.querySelector('#url-toggle');
function showUrlInput(show) {
  urlForm.hidden = !show;
  urlToggle.setAttribute('aria-expanded', String(show));
}
urlToggle.addEventListener('click', () => {
  showUrlInput(urlForm.hidden);
  if (!urlForm.hidden) urlInput.focus();
});
urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    showUrlInput(false);
    urlToggle.focus();
  }
});
const ready = viewer.ready();

ready.catch((err) => {
  reportError('Failed to initialize FFmpeg', err);
  viewer.setStatus(String(err?.message ?? err), true);
});

fileInput.addEventListener('change', () => {
  setPlaylist([...fileInput.files]);
});

directoryInput.addEventListener('change', () => {
  setPlaylist([...directoryInput.files]);
});

document.querySelector('#url-form').addEventListener('submit', (event) => {
  event.preventDefault();
  openUrl(urlInput.value);
});

let dragDepth = 0;
function acceptsDrop(event) {
  return [...(event.dataTransfer?.types || [])].some(type =>
    ['Files', 'text/uri-list', 'text/plain'].includes(type));
}
window.addEventListener('dragenter', (event) => {
  if (!acceptsDrop(event)) return;
  event.preventDefault();
  dragDepth += 1;
  host.classList.add('drag-over');
});
window.addEventListener('dragover', (event) => {
  if (!acceptsDrop(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) host.classList.remove('drag-over');
});
window.addEventListener('dragend', clearDrag);
window.addEventListener('drop', (event) => {
  clearDrag();
  if (!acceptsDrop(event)) return;
  event.preventDefault();
  const files = [...event.dataTransfer.files];
  if (files.length) {
    setPlaylist(files);
    return;
  }
  const text = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain');
  const url = text.split(/\r?\n/).find(line => line.trim() && !line.startsWith('#'));
  if (url) {
    urlInput.value = url.trim();
    openUrl(url);
  }
});

function clearDrag() {
  dragDepth = 0;
  host.classList.remove('drag-over');
}

function openUrl(value) {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Enter an HTTP or HTTPS media URL.');
    playlist = [{ id: url.href, name: url.pathname.split('/').pop() || url.hostname, url: url.href }];
    renderPlaylist();
    selectItem(0);
  } catch (err) {
    viewer.setStatus('Enter a valid HTTP or HTTPS media URL.', true);
    viewer.showStageNote('Enter a valid HTTP or HTTPS media URL.', true);
  }
}

// Probe with GET because some media servers do not implement HEAD.
async function remoteItem(item, signal) {
  const request = async (start, end) => {
    let response;
    try {
      response = await fetch(item.url, { headers: { Range: `bytes=${start}-${end}` }, signal });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new Error('Unable to load media URL. Check the connection and whether the server allows cross-origin requests (CORS).');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Unable to load media URL: HTTP ${response.status}`);
    }
    return response;
  };
  const probe = await request(0, 0);
  if (probe.status === 200) {
    const file = await probe.blob();
    return { ...item, file, size: file.size };
  }
  let range;
  try {
    range = parseContentRange(probe);
  } catch (err) {
    await probe.body?.cancel();
    throw err;
  }
  if (range.start !== 0 || range.end !== 0) {
    await probe.body?.cancel();
    throw new Error('The server returned an unexpected media range.');
  }
  await probe.arrayBuffer();
  return { ...item, size: range.size, async readRange(offset, length) {
    const end = Math.min(range.size, offset + length) - 1;
    if (end < offset) return new Uint8Array();
    const response = await request(offset, end);
    let received;
    try {
      received = parseContentRange(response);
      if (received.start !== offset || received.end !== end || received.size !== range.size) {
        throw new Error('The server returned an unexpected media range.');
      }
    } catch (err) {
      await response.body?.cancel();
      throw err;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== end - offset + 1) throw new Error('The server returned an incomplete media range.');
    return bytes;
  } };
}

function parseContentRange(response) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
  if (response.status !== 206 || !match) {
    throw new Error('The server must support byte ranges and expose Content-Range through CORS.');
  }
  const [start, end, size] = match.slice(1).map(Number);
  if (![start, end, size].every(Number.isSafeInteger) || start > end || end >= size) {
    throw new Error('The server returned an invalid media size or range.');
  }
  return { start, end, size };
}

function setPlaylist(files) {
  playlist = files.map((file, index) => ({
    id: `local-${index}`,
    name: file.webkitRelativePath || file.name,
    size: file.size,
    file,
  }));
  renderPlaylist();
  if (playlist.length) selectItem(0);
}

function renderPlaylist() {
  browserShell.classList.toggle('has-playlist', playlist.length > 0);
  playlistEl.replaceChildren(...playlist.map((item, index) => {
    const button = document.createElement('button');
    button.className = 'playlist-item';
    button.type = 'button';
    button.dataset.index = String(index);
    button.innerHTML = `
      <div class="playlist-name"></div>
      <div class="playlist-meta"></div>
    `;
    button.querySelector('.playlist-name').textContent = item.name;
    button.querySelector('.playlist-meta').textContent = item.size == null ? 'URL' : formatBytes(item.size);
    button.addEventListener('click', () => selectItem(index));
    return button;
  }));
}

async function selectItem(index) {
  const current = ++selection;
  pendingDownload?.abort();
  const controller = pendingDownload = new AbortController();
  for (const node of playlistEl.querySelectorAll('.playlist-item')) {
    node.classList.toggle('active', Number(node.dataset.index) === index);
  }
  let item = playlist[index];
  if (!item) return;
  urlInput.value = item.url || "";
  showUrlInput(false);
  try {
    viewer.setBusy(true, `Reading ${item.name}...`);
    await ready;
    if (current !== selection) return;
    if (item.url) {
      item = await remoteItem(item, controller.signal);
      if (current !== selection) return;
      playlist[index] = item;
      playlistEl.querySelectorAll('.playlist-meta')[index].textContent = formatBytes(item.size);
    }
    await viewer.open(item);
  } catch (err) {
    if (current !== selection) return;
    reportError(`Failed to read ${item.name}`, err);
    viewer.setStatus(String(err?.message ?? err), true);
    viewer.showStageNote(String(err?.message ?? err), true);
  } finally {
    if (current === selection) viewer.setBusy(false);
  }
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
  } catch (err) {
    reportError('Failed to load viewer settings', err);
    return null;
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (err) {
    reportError('Failed to save viewer settings', err);
  }
}
