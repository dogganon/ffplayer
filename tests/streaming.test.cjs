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

async function viewerClasses(extra = {}) {
  let code = await fs.readFile('app/shared/media-viewer.js', 'utf8');
  code = code.replace(/export /g, '').replace(/import\.meta\.url/g, "'file:///unused'");
  return vm.runInNewContext(`${code}\n({ MediaViewer, StreamingPlayer, TrackView, parseTimestamp, formatTimestamp, normalizeSettings, settingsSnapshot })`, {
    performance: { now: () => 0 }, console,
    cancelAnimationFrame() {},
    ImageData: class {}, Uint8ClampedArray,
    document: { activeElement: null }, ...extra,
  });
}

test('decoding stops at lookahead or memory limits and resumes after consumption', async () => {
  const { StreamingPlayer } = await viewerClasses();
  const player = Object.create(StreamingPlayer.prototype);
  player.playbackRate = 1;
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
  player.playbackRate = 1;
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


test('overlapping seeks retain playback intent and explicit pause cancels resume', async () => {
  const { StreamingPlayer } = await viewerClasses();
  for (const action of ['playing', 'paused', 'pause', 'stop']) {
    const pending = [];
    const player = new StreamingPlayer({ settings: { playbackRate: 1 } }, {
      info: () => ({ durationSeconds: 100 }),
      seek: target => new Promise(resolve => pending.push({ target, resolve })),
    }, { name: 'test' });
    player.updateControls = () => {};
    player.pump = () => {};
    let resumes = 0;
    player.play = async () => { resumes++; player.playing = true; };
    player.playing = action !== 'paused';
    const first = player.seek(10);
    const second = player.seek(20);
    if (action === 'pause') player.pause();
    if (action === 'stop') player.stop();
    pending[0].resolve();
    await first;
    assert.equal(resumes, 0);
    pending[1].resolve();
    await second;
    if (action === 'stop') {
      pending[2].resolve();
      await Promise.resolve();
      assert.equal(player.offset, 0);
    } else assert.equal(player.offset, 20);
    assert.equal(resumes, action === 'playing' ? 1 : 0);
  }
});

test('timestamp input accepts supported formats and rejects invalid times', async () => {
  const { parseTimestamp, formatTimestamp } = await viewerClasses();
  for (const [input, expected] of [['0', 0], ['90.5', 90.5], ['1:30', 90], ['1:02:03.5', 3723.5], [' 2:00 ', 120]]) {
    assert.equal(parseTimestamp(input), expected);
  }
  for (const input of ['', '-1', '1:60', '1:99:00', '1:2:3:4', 'abc', 'Infinity']) {
    assert.equal(parseTimestamp(input), null);
  }
  assert.equal(formatTimestamp(0), '0:00.000');
  assert.equal(formatTimestamp(3723), '1:02:03.000');
});


test('playback updates preserve an in-progress speed edit', async () => {
  const document = { activeElement: null };
  const { StreamingPlayer } = await viewerClasses({ document });
  const els = { play: {}, timeline: {}, playbackRate: { value: '1.' }, time: {} };
  const player = new StreamingPlayer({ els, settings: { playbackRate: 1 } }, {
    info: () => ({ durationSeconds: 100 }),
  }, {});
  player.playing = true;
  document.activeElement = els.playbackRate;
  player.updateControls();
  assert.equal(els.playbackRate.value, '1.');
  document.activeElement = null;
  player.updateControls();
  assert.equal(els.playbackRate.value, '1');
});

test('changing speed during playback preserves position and resumes at the new rate', async () => {
  const { StreamingPlayer } = await viewerClasses({ performance: { now: () => 10000 } });
  const seeks = [];
  const player = new StreamingPlayer({ settings: { playbackRate: 1 } }, {
    info: () => ({ durationSeconds: 100 }),
    async seek(time) { seeks.push(time); },
  }, {});
  player.updateControls = () => {};
  player.pump = () => {};
  player.play = async () => { player.playing = true; };
  player.playing = true;
  player.decodedUntil = 100;
  await player.setPlaybackRate(2);
  assert.equal(player.playbackRate, 2);
  assert.equal(player.playing, true);
  assert.equal(player.currentPlaybackTime(), 10);
  assert.deepEqual(seeks, [10]);
  player.pause();
  await player.setPlaybackRate(0.5);
  assert.equal(player.playing, false);
  assert.equal(player.offset, 10);
  assert.deepEqual(seeks, [10]);
});


test('timestamp display uses configurable decimals without limiting seek input', async () => {
  const { parseTimestamp, formatTimestamp, normalizeSettings, settingsSnapshot } = await viewerClasses();
  assert.equal(formatTimestamp(90.123456789), '1:30.123');
  assert.equal(formatTimestamp(90.123456789, 0), '1:30');
  assert.equal(formatTimestamp(90.123456789, 6), '1:30.123457');
  assert.equal(formatTimestamp(59.9999, 3), '1:00.000');
  assert.equal(formatTimestamp(3599.9999, 3), '1:00:00.000');
  assert.equal(parseTimestamp('1:30.123456789'), 90.123456789);
  assert.equal(normalizeSettings({}).timestampPrecision, 3);
  for (const digits of [0, 2, 6]) {
    assert.equal(normalizeSettings(settingsSnapshot(normalizeSettings({ timestampPrecision: digits }))).timestampPrecision, digits);
  }
  for (const digits of [-1, 7, 1.5, null]) {
    assert.equal(normalizeSettings({ timestampPrecision: digits }).timestampPrecision, 3);
  }
});


test('shared viewer enables timestamp controls and restores precision without browser options', async () => {
  const { MediaViewer } = await viewerClasses();
  const nodes = new Map();
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, {
      style: { setProperty() {} }, dataset: {},
      querySelector: node,
      addEventListener(type, handler) { this[type] = handler; },
    });
    return nodes.get(selector);
  }
  let saved;
  const viewer = new MediaViewer(node('root'), { onSettingsChange(settings) { saved = settings; } });
  assert.equal(viewer.els.timestamp.value, '0:00.000');
  viewer.applySettings({ timestampPrecision: 5 });
  assert.equal(viewer.els.timestamp.value, '0:00.00000');
  assert.equal(viewer.els.timestampPrecision.value, '5');
  viewer.els.timestampPrecision.value = '2';
  viewer.els.timestampPrecision.change();
  assert.equal(saved.timestampPrecision, 2);
  assert.equal(viewer.els.timestamp.value, '0:00.00');
});

test('seeking decodes preroll before rendering or resuming, preserving fractional targets', async () => {
  const { StreamingPlayer, TrackView } = await viewerClasses();
  for (const playing of [false, true]) {
    const rendered = [];
    const track = Object.assign(Object.create(TrackView.prototype), {
      stream: { type: 'video', decodable: true }, video: [], audio: [], note: {},
      canvas: { width: 1, height: 1 }, ctx: { clearRect() {}, putImageData() { rendered.push(track.drawn.time); } },
    });
    const times = [8, 8.5, 9, 9.5, 10, 10.5];
    let reads = 0;
    let resumes = 0;
    const player = new StreamingPlayer({ settings: { playbackRate: 1 } }, {
      info: () => ({ durationSeconds: 30 }),
      async seek(time) { assert.equal(time, 10.25); },
      async read() {
        assert.equal(player.playing, false);
        assert.deepEqual(rendered, []);
        return { done: false, chunks: [{ type: 'video', stream: 0, time: times[reads++], width: 1, height: 1, rgba: new Uint8Array(4) }] };
      },
    }, {});
    player.tracks.set(0, track);
    player.playing = playing;
    player.updateControls = () => {};
    player.pump = () => {};
    player.play = async () => { resumes++; player.playing = true; };
    await player.seek(10.25);
    assert.equal(reads, 6);
    assert.equal(player.offset, 10.25);
    assert.deepEqual(rendered, [10]); // Frame covering the requested instant.
    assert.equal(resumes, playing ? 1 : 0);
    assert.equal(track.note.textContent, '');
    assert.equal(track.video.length, 2);
  }
});

test('seek preroll discards expired audio but retains the chunk covering the target', async () => {
  const { TrackView } = await viewerClasses();
  const track = Object.assign(Object.create(TrackView.prototype), { audio: [], note: {}, seekTarget: 10.25 });
  for (const time of [8, 9, 10, 11]) {
    track.push({ type: 'audio', time, samples: new Float32Array(100), channels: 1, sampleRate: 100 });
  }
  assert.deepEqual(track.audio.map(chunk => chunk.time), [10, 11]);
});

test('playback clock starts after seek decoding, without catching up elapsed decode time', async () => {
  let now = 1000;
  const { StreamingPlayer } = await viewerClasses({
    performance: { now: () => now },
    AudioContext: class { constructor() { this.state = 'running'; } },
    requestAnimationFrame() { return 1; },
  });
  const track = {
    stream: { type: 'video', decodable: true }, video: [], audio: [],
    clear() { this.video = []; }, push(chunk) { this.video.push(chunk); }, render() {},
  };
  const player = new StreamingPlayer({ settings: { playbackRate: 1 }, setStatus() {} }, {
    info: () => ({ durationSeconds: 100 }), async seek() {},
    async read() {
      now += 5000;
      return { done: true, chunks: [{ stream: 0, type: 'video', time: 20.25, rgba: new Uint8Array(4) }] };
    },
  }, { name: 'test' });
  player.updateControls = () => {};
  player.tracks.set(0, track);
  player.playing = true;
  await player.seek(20.25);
  assert.equal(player.currentPlaybackTime(), 20.25);
  now += 500;
  assert.equal(player.currentPlaybackTime(), 20.75);
});


test('100x playback waits for decoding and reaches the final frame before ending', async () => {
  let now = 0;
  const { StreamingPlayer } = await viewerClasses({
    performance: { now: () => now }, requestAnimationFrame() { return 1; },
  });
  const player = new StreamingPlayer({ settings: { playbackRate: 100 }, setStatus() {} }, {
    info: () => ({ durationSeconds: 60 }),
  }, { name: 'fast.mp4' });
  player.updateControls = () => {};
  player.scheduleAudio = () => {};
  player.pump = () => {};
  let rendered;
  player.tracks.set(0, { render(time) { rendered = time; } });
  player.playing = true;
  player.recordDecodedTime({ type: 'video', time: 10 });
  now = 1000; // Wall time would have advanced the media clock to 100 seconds.
  player.tick();
  assert.equal(player.playing, true);
  assert.equal(player.offset, 10);
  assert.equal(rendered, 10);
  now = 2000;
  player.tick();
  assert.equal(player.offset, 10, 'stalled decoding must not advance the timeline');
  player.recordDecodedTime({ type: 'video', time: 40 });
  now = 2300;
  player.tick();
  assert.ok(Math.abs(player.offset - 40) < 1e-9);
  assert.equal(player.playing, true);
  player.recordDecodedTime({ type: 'video', time: 59.9 });
  player.done = true;
  now = 2600;
  player.tick();
  assert.equal(player.playing, false);
  assert.equal(player.offset, 60, 'natural EOF must retain the end position');
  assert.ok(rendered >= 59.9, 'the final frame is rendered before stopping');
});

test('lookahead scales with speed while the memory cap remains enforced', async () => {
  const { StreamingPlayer } = await viewerClasses();
  const player = new StreamingPlayer({ settings: { playbackRate: 100 } }, {
    info: () => ({ durationSeconds: 1000 }),
  }, {});
  const frame = { time: 3, rgba: { byteLength: 4 } };
  player.tracks.set(0, { video: [frame], audio: [] });
  assert.equal(player.bufferFull(), false);
  frame.time = 200;
  assert.equal(player.bufferFull(), true);
  frame.time = 3;
  frame.rgba.byteLength = 64 * 1024 * 1024;
  assert.equal(player.bufferFull(), true);
});
