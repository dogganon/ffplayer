import { MediaViewer, reportError } from './media-viewer.js';

const SETTINGS_KEY = 'ffplayer.viewer.settings.v1';

const app = document.querySelector('#app');
app.innerHTML = `
  <div class="browser-host">
    <div class="topbar">
      <label class="file-button">
        <span>Open file</span>
        <input id="file" type="file" />
      </label>
      <label class="file-button">
        <span>Open directory</span>
        <input id="directory" type="file" multiple webkitdirectory />
      </label>
    </div>
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

viewer.ready().catch((err) => {
  reportError('Failed to initialize FFmpeg', err);
  viewer.setStatus(String(err?.message ?? err), true);
});

fileInput.addEventListener('change', () => {
  setPlaylist([...fileInput.files]);
});

directoryInput.addEventListener('change', () => {
  setPlaylist([...directoryInput.files]);
});

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
    button.querySelector('.playlist-meta').textContent = formatBytes(item.size ?? 0);
    button.addEventListener('click', () => selectItem(index));
    return button;
  }));
}

async function selectItem(index) {
  for (const node of playlistEl.querySelectorAll('.playlist-item')) {
    node.classList.toggle('active', Number(node.dataset.index) === index);
  }
  const item = playlist[index];
  if (!item) return;
  try {
    viewer.setBusy(true, `Reading ${item.name}...`);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    item.bytes = new Uint8Array(await item.file.arrayBuffer());
    await viewer.open(item);
  } catch (err) {
    reportError(`Failed to read ${item.name}`, err);
    viewer.setStatus(String(err?.message ?? err), true);
    viewer.showStageNote(String(err?.message ?? err), true);
  } finally {
    viewer.setBusy(false);
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
