const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function browser(fetch) {
  const nodes = new Map();
  function node(key) {
    if (!nodes.has(key)) nodes.set(key, {
      dataset: {},
      setAttribute() {}, focus() {},
      classList: { toggle() {}, add() {}, remove() {} },
      addEventListener(type, fn) { this[type] = fn; },
      querySelector: node, querySelectorAll: () => [], replaceChildren() {},
    });
    return nodes.get(key);
  }
  const context = vm.createContext({
    URL, AbortController, Uint8Array, Number, fetch,
    localStorage: { getItem: () => null },
    document: { querySelector: node, createElement: () => node(Symbol()) },
    window: node('window'), reportError() {},
    MediaViewer: class {
      ready() { return Promise.resolve(); }
      setStatus() {} showStageNote() {} setBusy() {} async open() {}
    },
  });
  const source = fs.readFileSync('app/browser/browser-viewer.js', 'utf8').replace(/^import .*;\n/, '');
  vm.runInContext(source, context);
  return { context, nodes, remote: (url = 'https://example.com/media') => context.remoteItem({ url }, new AbortController().signal) };
}

test('remote media probes and reads exact ranges including the tail', async () => {
  const calls = [];
  const { remote } = browser(async (url, options) => {
    calls.push(options.headers.Range);
    const [start, end] = options.headers.Range.slice(6).split('-').map(Number);
    return new Response(new Uint8Array(end - start + 1), {
      status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/1000` },
    });
  });
  const item = await remote();
  assert.equal(item.size, 1000);
  assert.equal((await item.readRange(990, 100)).length, 10);
  assert.equal((await item.readRange(1000, 100)).length, 0);
  assert.deepEqual(calls, ['bytes=0-0', 'bytes=990-999']);
});

test('servers ignoring Range fall back to a Blob', async () => {
  const { remote } = browser(async () => new Response('media'));
  const item = await remote();
  assert.equal(item.size, 5);
  assert.equal(await item.file.text(), 'media');
});

test('remote errors explain HTTP and CORS failures', async () => {
  await assert.rejects(browser(async () => new Response('', { status: 404 })).remote(), /HTTP 404/);
  await assert.rejects(browser(async () => { throw new TypeError('Failed to fetch'); }).remote(), /CORS/);
  await assert.rejects(browser(async () => new Response('x', { status: 206 })).remote(), /Content-Range/);
});

test('range reads reject ignored or incorrect ranges', async () => {
  for (const response of [new Response('whole file'), new Response('x', {
    status: 206, headers: { 'Content-Range': 'bytes 0-0/1000' },
  })]) {
    let calls = 0;
    const { remote } = browser(async () => ++calls === 1
      ? new Response('x', { status: 206, headers: { 'Content-Range': 'bytes 0-0/1000' } })
      : response);
    const item = await remote();
    await assert.rejects(item.readRange(100, 10), /range|Content-Range/);
  }
});

test('file drops prevent navigation and populate a playlist; non-HTTP links are rejected', () => {
  const { context, nodes } = browser();
  let prevented = false;
  nodes.get('window').drop({ preventDefault() { prevented = true; }, dataTransfer: {
    types: ['Files'], files: [{ name: 'a.mp4', size: 20 }, { name: 'b.mp4', size: 30 }],
  } });
  assert.equal(prevented, true);
  assert.equal(vm.runInContext('playlist.length', context), 2);
  context.openUrl('javascript:alert(1)');
  assert.equal(vm.runInContext('playlist.length', context), 2);
});

test('URL input toggles on demand and is cleared when opening local media', () => {
  const { context, nodes } = browser();
  const form = nodes.get('#url-form');
  const input = nodes.get('#media-url');
  form.hidden = true;
  nodes.get('#url-toggle').click();
  assert.equal(form.hidden, false);
  input.value = 'https://example.com/old.mp4';
  context.setPlaylist([{ name: 'local.mp4', size: 10 }]);
  assert.equal(form.hidden, true);
  assert.equal(input.value, '');
});
