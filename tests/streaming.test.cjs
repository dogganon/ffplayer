const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs/promises');
const { MessageChannel } = require('node:worker_threads');
const path = require('node:path');
const os = require('node:os');

async function workerContext(extra = {}) {
  const code = await fs.readFile('app/shared/decode-worker.js', 'utf8');
  const context = vm.createContext({ Uint8Array, ArrayBuffer, Promise, ...extra,
    self: extra.self || { addEventListener() {}, postMessage() {} } });
  vm.runInContext(code, context);
  return context;
}

test('large browser files are read in bounded slices, cached, and seekable', async () => {
  const context = await workerContext();
  const reads = [];
  context.payload = { file: {
    size: 8 * 1024 ** 3,
    arrayBuffer() { throw new Error('Whole-file reads are forbidden'); },
    slice(start, end) {
      reads.push([start, end]);
      return { async arrayBuffer() {
        return Uint8Array.from({ length: end - start }, (_, i) => (start + i) % 251).buffer;
      } };
    },
  } };
  const source = vm.runInContext('rangeSource(payload)', context);
  assert.equal((await source.read(0, 32768))[100], 100);
  await source.read(32768, 32768);
  assert.equal(reads.length, 1);
  const offset = 6 * 1024 ** 3 + 123;
  assert.equal((await source.read(offset, 32768))[0], offset % 251);
  await source.read(0, 1024 * 1024);
  assert.ok(reads.every(([a, b]) => b - a <= 256 * 1024));
  const tail = await source.read(source.size - 7, 32768);
  assert.equal(tail.byteLength, 7);
  source.close();
});

test('range bridge transfers bounded bytes and reports read errors to FFmpeg', async () => {
  const context = await workerContext();
  const { port1, port2 } = new MessageChannel();
  context.payload = { size: 1024 ** 3, port: port1 };
  const source = vm.runInContext('rangeSource(payload)', context);
  let fail = false;
  port2.on('message', ({ id, length }) => {
    assert.ok(length <= 256 * 1024);
    port2.postMessage(fail ? { id, error: 'disk disconnected' } : { id, bytes: new Uint8Array(length).fill(42).buffer });
  });
  try {
    assert.equal((await source.read(0, 100))[0], 42);
    fail = true;
    assert.equal(await source.read(500000, 100), null);
    assert.match(source.error.message, /disk disconnected/);
  } finally { source.close(); port2.close(); }
});

test('worker serializes open, read, seek, and close across suspended I/O', async () => {
  let listener;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const replies = [];
  class DecodeSession {
    async open() { calls.push('opening'); await gate; calls.push('opened'); }
    info() { return {}; }
    async read() { calls.push('read'); return { chunks: [] }; }
    async seek() { calls.push('seek'); }
    delete() { calls.push('close'); }
  }
  const context = await workerContext({
    createFFplayer: async () => ({ DecodeSession, version: () => 'test' }),
    self: { addEventListener(_, fn) { listener = fn; }, postMessage(msg) { replies.push(msg); } },
  });
  const send = (id, type, payload) => listener({ data: { id, type, payload } });
  send(1, 'ready', {});
  await vm.runInContext('commands', context);
  send(2, 'open', { size: 100 });
  send(3, 'read', { sessionId: 1 });
  send(4, 'seek', { sessionId: 1, time: 1 });
  send(5, 'close', { sessionId: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['opening']);
  release();
  await vm.runInContext('commands', context);
  assert.deepEqual(calls, ['opening', 'opened', 'read', 'seek', 'close']);
  assert.ok(replies.every(reply => !reply.error));
});

async function viewerClasses() {
  let code = await fs.readFile('app/shared/media-viewer.js', 'utf8');
  code = code.replace(/export /g, '').replace(/import\.meta\.url/g, "'file:///unused'");
  return vm.runInNewContext(`${code}\n({ StreamingPlayer, TrackView })`, {
    performance: { now: () => 0 }, console,
    ImageData: class {}, Uint8ClampedArray,
  });
}

test('decoding stops at lookahead or memory limits and resumes after consumption', async () => {
  const { StreamingPlayer } = await viewerClasses();
  const player = Object.create(StreamingPlayer.prototype);
  player.offset = 0;
  player.playing = false;
  player.audioSources = [];
  const frame = { time: 3, rgba: { byteLength: 16 } };
  const track = { video: [frame], audio: [], drawn: null };
  player.tracks = new Map([[0, track]]);
  assert.equal(player.bufferFull(), true);
  player.offset = 2;
  assert.equal(player.bufferFull(), false);
  frame.rgba.byteLength = 64 * 1024 ** 2;
  assert.equal(player.bufferFull(), true);
  track.drawn = frame;
  frame.time = 2;
  assert.equal(player.bufferFull(), false, 'displayed frames must not permanently stop decoding');
  track.video = [];
  player.audioSources = [{ buffer: { length: 48000, numberOfChannels: 2 }, mediaEnd: 5 }];
  assert.equal(player.bufferFull(), true);
  player.audioSources = [];
  assert.equal(player.bufferFull(), false);
});

test('rendering releases consumed video frames', async () => {
  const { TrackView } = await viewerClasses();
  const track = Object.create(TrackView.prototype);
  track.video = [0, 1, 2, 3].map(time => ({ time, width: 1, height: 1, rgba: new Uint8Array(4) }));
  track.canvas = { width: 1, height: 1 };
  track.ctx = { putImageData() {} };
  track.drawn = -1;
  track.render(2.5);
  assert.deepEqual(track.video.map(frame => frame.time), [2, 3]);
});

test('VS Code reads sparse files above the old size limit and rejects invalid ranges', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ffplayer-test-'));
  const filename = path.join(directory, 'large.bin');
  const offset = 5 * 1024 ** 3;
  const file = await fs.open(filename, 'w');
  await file.write(Buffer.from('range-data'), 0, 10, offset);
  await file.close();
  let provider;
  let listener;
  const replies = [];
  const vscode = {
    window: { registerCustomEditorProvider(_, value) { provider = value; return {}; } },
    Uri: { joinPath() { return {}; } },
    workspace: { fs: { stat: () => fs.stat(filename), readFile() { throw new Error('Whole-file read'); } } },
  };
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile('app/vscode/extension.js', 'utf8'), {
    require: name => name === 'vscode' ? vscode : require(name), module, Buffer, console,
  });
  module.exports.activate({ subscriptions: [], globalState: { get() {} } });
  const webview = {
    asWebviewUri() { return ''; },
    onDidReceiveMessage(fn) { listener = fn; },
    async postMessage(msg) { replies.push(msg); },
  };
  try {
    await provider.resolveCustomEditor({ uri: { scheme: 'file', fsPath: filename, path: filename } }, { webview });
    await listener({ type: 'ready' });
    assert.equal(replies.at(-1).size, offset + 10);
    await listener({ type: 'readRange', id: 1, offset, length: 100, uri: '/must-be-ignored' });
    assert.equal(Buffer.from(replies.at(-1).bytes).toString(), 'range-data');
    for (const request of [{ offset: -1, length: 1 }, { offset: 0, length: 262145 }, { offset: 0.5, length: 1 }]) {
      await listener({ type: 'readRange', id: 2, ...request });
      assert.match(replies.at(-1).error, /Invalid file range/);
    }
    await listener({ type: 'readRange', id: 3, offset: offset + 10, length: 1 });
    assert.equal(replies.at(-1).bytes.byteLength, 0);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('failed worker opens release the session and allow a subsequent open', async () => {
  let listener;
  let attempts = 0;
  let deleted = 0;
  const replies = [];
  class DecodeSession {
    async open() { if (++attempts === 1) throw new Error('invalid container'); }
    info() { return {}; }
    delete() { deleted++; }
  }
  const context = await workerContext({
    createFFplayer: async () => ({ DecodeSession, version: () => 'test' }),
    self: { addEventListener(_, fn) { listener = fn; }, postMessage(msg) { replies.push(msg); } },
  });
  listener({ data: { id: 1, type: 'ready' } });
  listener({ data: { id: 2, type: 'open', payload: { size: 100 } } });
  listener({ data: { id: 3, type: 'open', payload: { size: 100 } } });
  await vm.runInContext('commands', context);
  assert.match(replies[1].error.message, /invalid container/);
  assert.equal(deleted, 1);
  assert.equal(replies[2].result.sessionId, 1);
});

test('full playback queues do not request further decoding', async () => {
  const { StreamingPlayer } = await viewerClasses();
  const player = Object.create(StreamingPlayer.prototype);
  player.offset = 0;
  player.playing = false;
  player.audioSources = [];
  player.tracks = new Map([[0, { video: [{ time: 10, rgba: { byteLength: 4 } }], audio: [] }]]);
  let reads = 0;
  player.session = { async read() { reads++; return { chunks: [], done: false }; } };
  await player.pump();
  assert.equal(reads, 0);
  player.tracks.clear();
  await player.pump();
  assert.equal(reads, 1);
});
