import { MediaViewer, reportError } from './media-viewer.js';

const vscode = acquireVsCodeApi();
const app = document.querySelector('#app');

app.innerHTML = `
  <div class="vscode-host">
    <section id="viewer" class="viewer"></section>
  </div>
`;

const viewer = new MediaViewer(document.querySelector('#viewer'));
let pendingItem = null;

viewer.ready()
  .then(() => vscode.postMessage({ type: 'ready' }))
  .catch((err) => {
    reportError('Failed to initialize FFmpeg', err);
    viewer.setStatus(String(err?.message ?? err), true);
  });

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg?.type === 'media') {
    pendingItem = {
      id: msg.id,
      uri: msg.uri,
      name: msg.name,
      size: msg.size,
    };
    viewer.setStatus(`Reading ${pendingItem.name}...`);
    vscode.postMessage({ type: 'readFile', id: pendingItem.id, uri: pendingItem.uri });
  } else if (msg?.type === 'fileBytes' && pendingItem?.id === msg.id) {
    try {
      pendingItem.bytes = bytesFromMessage(msg.bytes);
      if (!pendingItem.bytes.byteLength) {
        throw new Error(`Received 0 bytes for ${pendingItem.name}`);
      }
      viewer.open(pendingItem);
    } catch (err) {
      reportError(`Failed to open ${pendingItem.name}`, err);
      viewer.setStatus(String(err?.message ?? err), true);
    }
  } else if (msg?.type === 'error') {
    const err = new Error(msg.message || 'VS Code extension error');
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
