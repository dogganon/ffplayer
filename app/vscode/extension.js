const vscode = require('vscode');
const fs = require('node:fs/promises');
const MAX_RANGE_BYTES = 256 * 1024;
const SETTINGS_KEY = 'ffplayer.viewer.settings.v1';

function activate(context) {
  const provider = new FFplayerMediaViewer(context);
  const options = {
    webviewOptions: { retainContextWhenHidden: true },
    supportsMultipleEditorsPerDocument: false,
  };
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('ffplayer.mediaViewer', provider, options),
    vscode.window.registerCustomEditorProvider('ffplayer.mediaViewer.optional', provider, options),
  );
}

class FFplayerMediaViewer {
  constructor(context) {
    this.context = context;
  }

  async openCustomDocument(uri) {
    return { uri, dispose() {} };
  }

  async resolveCustomEditor(document, webviewPanel) {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
      ],
    };
    webview.html = this.html(webview);

    webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'ready') {
        try {
          const settings = this.context.globalState.get(SETTINGS_KEY);
          if (settings) await webview.postMessage({ type: 'settings', settings });
          if (document.uri.scheme !== 'file') {
            throw new Error('Range reads require a filesystem file. For remote files, run ffplayer in the remote workspace extension host.');
          }
          const stat = await vscode.workspace.fs.stat(document.uri);
          webview.postMessage({
            type: 'media',
            id: document.uri.toString(),
            uri: document.uri.toString(),
            name: basename(document.uri.path),
            size: stat.size,
          });
        } catch (err) {
          console.error('Failed to stat media document', err);
          webview.postMessage({ type: 'error', message: String(err?.message ?? err) });
        }
      } else if (message?.type === 'settingsChanged') {
        await this.context.globalState.update(SETTINGS_KEY, message.settings);
      } else if (message?.type === 'readRange') {
        let file;
        try {
          const { offset, length } = message;
          if (document.uri.scheme !== 'file' || !Number.isSafeInteger(offset) || offset < 0 ||
              !Number.isSafeInteger(length) || length <= 0 || length > MAX_RANGE_BYTES) {
            throw new Error('Invalid file range request');
          }
          // Only the editor's own document is readable through this bridge.
          file = await fs.open(document.uri.fsPath, 'r');
          const bytes = Buffer.alloc(length);
          let total = 0;
          while (total < length) {
            const { bytesRead } = await file.read(bytes, total, length - total, offset + total);
            if (!bytesRead) break;
            total += bytesRead;
          }
          await webview.postMessage({ type: 'rangeBytes', id: message.id,
            bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + total) });
        } catch (err) {
          await webview.postMessage({ type: 'rangeBytes', id: message.id, error: String(err?.message ?? err) });
        } finally {
          await file?.close();
        }
      }
    });
  }

  html(webview) {
    const asset = (name) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', name));
    const nonce = String(Date.now());
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval' 'unsafe-eval' ${webview.cspSource}; style-src ${webview.cspSource}; connect-src ${webview.cspSource}; img-src ${webview.cspSource} data:; worker-src blob:; media-src blob:;">
  <link rel="stylesheet" href="${asset('viewer.css')}">
  <title>ffplayer</title>
</head>
<body>
  <main id="app"></main>
  <script nonce="${nonce}" type="module" src="${asset('vscode-viewer.js')}"></script>
</body>
</html>`;
  }
}

function basename(path) {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function deactivate() {}

module.exports = { activate, deactivate };
