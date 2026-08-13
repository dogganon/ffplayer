const vscode = require('vscode');
const MAX_READ_BYTES = 256 * 1024 * 1024;

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
      } else if (message?.type === 'readFile') {
        try {
          const uri = vscode.Uri.parse(message.uri);
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.size > MAX_READ_BYTES) {
            throw new Error(`File is ${formatBytes(stat.size)}; this build currently limits VS Code reads to ${formatBytes(MAX_READ_BYTES)} to keep the extension host responsive.`);
          }
          const bytes = await vscode.workspace.fs.readFile(uri);
          const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          webview.postMessage({ type: 'fileBytes', id: message.id, bytes: buffer, size: bytes.byteLength });
        } catch (err) {
          console.error('Failed to read media document', err);
          webview.postMessage({ type: 'error', message: String(err?.message ?? err) });
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

function deactivate() {}

module.exports = { activate, deactivate };
