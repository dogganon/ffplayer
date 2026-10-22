import { MediaViewer, reportError } from './media-viewer.js';

const vscode = acquireVsCodeApi();
const app = document.querySelector('#app');

app.innerHTML = `
  <div class="vscode-host">
    <section id="viewer" class="viewer"></section>
  </div>
`;

const viewer = new MediaViewer(document.querySelector('#viewer'), {
  onSettingsChange(settings) {
    vscode.postMessage({ type: 'settingsChanged', settings });
  },
});
let nextRangeId = 0;
const ranges = new Map();

viewer.ready()
  .then(() => vscode.postMessage({ type: 'ready' }))
  .catch((err) => {
    reportError('Failed to initialize FFmpeg', err);
    viewer.setStatus(String(err?.message ?? err), true);
  });

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg?.type === 'settings') {
    viewer.applySettings(msg.settings);
  } else if (msg?.type === 'media') {
    viewer.open({ id: msg.id, name: msg.name, size: msg.size, readRange });
  } else if (msg?.type === 'rangeBytes') {
    const request = ranges.get(msg.id);
    if (!request) return;
    ranges.delete(msg.id);
    clearTimeout(request.timer);
    if (msg.error) request.reject(new Error(msg.error));
    else request.resolve(bytesFromMessage(msg.bytes));
  } else if (msg?.type === 'error') {
    const err = new Error(msg.message || 'VS Code extension error');
    viewer.setBusy(false);
    reportError(err.message, err);
    viewer.setStatus(err.message, true);
  }
});

function bytesFromMessage(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return new Uint8Array(bytes);
}

function readRange(offset, length) {
  return new Promise((resolve, reject) => {
    const id = ++nextRangeId;
    const timer = setTimeout(() => {
      ranges.delete(id);
      reject(new Error('File range request timed out'));
    }, 30000);
    ranges.set(id, { resolve, reject, timer });
    vscode.postMessage({ type: 'readRange', id, offset, length });
  });
}
