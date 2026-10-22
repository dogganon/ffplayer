const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

// Run after npm run build. This exercises the real FFmpeg/Asyncify binding.
test('Wasm opens, decodes, and seeks a large file with bounded reads', async () => {
  const { default: createFFplayer } = await import(pathToFileURL(path.resolve('app/browser/dist/ffplayer.mjs')));
  const av = await createFFplayer();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ffplayer-wasm-'));
  const file = await fs.open(path.join(directory, 'large.wav'), 'w+');
  const sampleRate = 48000;
  const dataSize = sampleRate * 2 * 3600; // One hour, 329 MiB, stored sparsely.
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  await file.write(header);
  await file.truncate(44 + dataSize);
  const reads = [];
  const source = {
    size: 44 + dataSize,
    async read(offset, length) {
      // Force a real asynchronous suspension on every I/O call.
      await new Promise(resolve => setImmediate(resolve));
      reads.push({ offset, length });
      const bytes = Buffer.alloc(Math.min(length, 256 * 1024));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytesRead);
    },
  };
  const session = new av.DecodeSession(source);
  try {
    await session.open();
    const info = session.info();
    assert.equal(info.streams[0].type, 'audio');
    assert.ok(Math.abs(info.durationSeconds - 3600) < 1);
    const first = await session.read();
    assert.ok(first.chunks.some(chunk => chunk.samples?.length > 0));
    await session.seek(3500);
    const nearEnd = await session.read();
    assert.ok(nearEnd.chunks.some(chunk => chunk.time >= 3499));
    await session.seek(0);
    const start = await session.read();
    assert.ok(start.chunks.some(chunk => chunk.time < 1));
    assert.ok(reads.some(read => read.offset > 300 * 1024 ** 2));
    const totalRead = reads.reduce((total, read) => total + read.length, 0);
    assert.ok(totalRead < 8 * 1024 ** 2, `Read ${totalRead} bytes for three playback positions`);
    assert.ok(reads.every(read => read.length <= 256 * 1024));
    console.log(`Real Wasm: ${source.size} byte file, ${reads.length} reads, ${totalRead} requested bytes`);
  } finally {
    session.delete();
    await file.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('real decode worker reads MP4 through Blob and extension-style range bridges', async () => {
  const { Worker, MessageChannel } = require('node:worker_threads');
  const { execFileSync } = require('node:child_process');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ffplayer-worker-'));
  const filename = path.join(directory, 'video.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '4', '-c:v', 'mpeg4', '-c:a', 'aac', '-y', filename]);
  const runtime = pathToFileURL(path.resolve('app/browser/dist/ffplayer.mjs')).href;
  const workerCode = await fs.readFile('app/shared/decode-worker.js', 'utf8');
  const wasmModule = await WebAssembly.compile(await fs.readFile('app/browser/dist/ffplayer.wasm'));
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    const self = {
      addEventListener(type, fn) { parentPort.on('message', data => fn({ data })); },
      postMessage(data, transfer) { parentPort.postMessage(data, transfer); },
    };
    import(${JSON.stringify(runtime)}).then(({ default: createFFplayer }) => {
      ${workerCode}
      parentPort.postMessage({ initialized: true });
    });
  `, { eval: true });
  await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  let nextId = 0;
  const pending = new Map();
  worker.on('message', message => {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
  });
  const call = (type, payload, transfer = []) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${type} timed out`)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, type, payload }, transfer);
  });
  const file = await fs.open(filename, 'r');
  const { size } = await file.stat();
  const { port1, port2 } = new MessageChannel();
  const ranges = [];
  port1.on('message', async ({ id, offset, length }) => {
    ranges.push({ offset, length });
    const buffer = new Uint8Array(length);
    const { bytesRead } = await file.read(buffer, 0, length, offset);
    port1.postMessage({ id, bytes: buffer.slice(0, bytesRead).buffer });
  });
  try {
    await call('ready', { wasmModule });
    const blob = new Blob([await fs.readFile(filename)]);
    for (const payload of [{ file: blob }, { size, port: port2 }]) {
      const opened = await call('open', payload, payload.port ? [port2] : []);
      assert.ok(opened.info.streams.some(stream => stream.type === 'video'));
      const types = new Set();
      for (let i = 0; i < 30 && types.size < 2; i++) {
        const result = await call('read', { sessionId: opened.sessionId });
        for (const chunk of result.chunks) types.add(chunk.type);
      }
      assert.ok(types.has('audio') && types.has('video'));
      await call('seek', { sessionId: opened.sessionId, time: 3 });
      const result = await call('read', { sessionId: opened.sessionId });
      assert.ok(result.chunks.length);
      await call('close', { sessionId: opened.sessionId });
    }
    assert.ok(ranges.length > 0);
    assert.ok(ranges.every(range => range.length <= 256 * 1024));
  } finally {
    port1.close();
    await worker.terminate();
    await file.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('browser runtime initializes inside a Blob URL worker without resolving relative URLs', async () => {
  const vm = require('node:vm');
  const workerUrl = 'blob:https://example.vscode-webview.net/test-worker';
  const runtime = (await fs.readFile('app/browser/dist/ffplayer.mjs', 'utf8'))
    .replace('export default createFFplayer;', '')
    .replaceAll('import.meta.url', JSON.stringify(workerUrl));
  const workerCode = await fs.readFile('app/shared/decode-worker.js', 'utf8');
  const wasmModule = await WebAssembly.compile(await fs.readFile('app/browser/dist/ffplayer.wasm'));
  let listener;
  const replies = [];
  const context = vm.createContext({
    URL, WebAssembly, console, TextDecoder, TextEncoder, setTimeout, clearTimeout,
    WorkerGlobalScope: class {},
    self: {
      location: { href: workerUrl },
      addEventListener(_, fn) { listener = fn; },
      postMessage(message) { replies.push(message); },
    },
  });
  vm.runInContext(`${runtime}\n${workerCode}`, context);
  listener({ data: { id: 1, type: 'ready', payload: { wasmModule } } });
  await vm.runInContext('commands', context);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].error, undefined, replies[0].error?.message);
  assert.ok(replies[0].result.version);
});

test('Wasm seeking accounts for a nonzero media timeline origin', async () => {
  const { execFileSync } = require('node:child_process');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ffplayer-offset-'));
  let session;
  try {
    const filename = path.join(directory, 'offset.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'testsrc2=size=64x48:rate=10', '-t', '3', '-c:v', 'mpeg4', '-g', '1',
      '-output_ts_offset', '10', '-y', filename]);
    const bytes = await fs.readFile(filename);
    const { default: createFFplayer } = await import(pathToFileURL(path.resolve('app/browser/dist/ffplayer.mjs')));
    const av = await createFFplayer();
    session = new av.DecodeSession({ size: bytes.length, async read(offset, length) {
      return new Uint8Array(bytes.subarray(offset, offset + length));
    } });
    await session.open();
    await session.seek(1.25);
    const batch = await session.read();
    const frame = batch.chunks.find(chunk => chunk.type === 'video');
    assert.ok(frame && Math.abs(frame.time - 1.2) < 0.01, `Expected frame at 1.2, got ${frame?.time}`);
  } finally {
    session?.delete();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
