let av = null;
let session = null;
let sessionId = 0;

// Asyncify permits one suspended Wasm call at a time. Range replies use a
// separate MessagePort so they can arrive while this command queue is waiting.
let commands = Promise.resolve();
self.addEventListener('message', (event) => {
  commands = commands.then(async () => {
    const { id, type, payload } = event.data;
    try {
      const result = await handle(type, payload || {});
      self.postMessage({ id, result }, transferables(result));
    } catch (err) {
      self.postMessage({ id, error: {
        message: String(err?.message ?? err), stack: String(err?.stack ?? ''),
      } });
    }
  });
});

let source = null;
function rangeSource(payload) {
  let cache = new Uint8Array();
  let cacheOffset = 0;
  let nextId = 0;
  const pending = new Map();
  if (payload.port) {
    payload.port.onmessage = ({ data }) => {
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      data.error ? request.reject(new Error(data.error)) : request.resolve(new Uint8Array(data.bytes));
    };
  }
  const result = {
    size: payload.file?.size ?? payload.size,
    error: null,
    async read(offset, length) {
      try {
        if (offset < cacheOffset || offset + length > cacheOffset + cache.byteLength) {
          const count = Math.min(256 * 1024, result.size - offset);
          cache = payload.file
            ? new Uint8Array(await payload.file.slice(offset, offset + count).arrayBuffer())
            : await new Promise((resolve, reject) => {
              const id = ++nextId;
              pending.set(id, { resolve, reject });
              payload.port.postMessage({ id, offset, length: count });
            });
          cacheOffset = offset;
          if (!cache.byteLength || cache.byteLength > count) throw new Error('Invalid file range response');
        }
        return cache.subarray(offset - cacheOffset, offset - cacheOffset + length);
      } catch (err) {
        result.error = err;
        return null; // Return an I/O error through FFmpeg, not a rejected Asyncify await.
      }
    },
    close() { cache = new Uint8Array(); payload.port?.close(); },
  };
  return result;
}

async function handle(type, payload) {
  if (type === 'ready') {
    const wasmModule = payload.wasmModule;
    av = await createFFplayer({
      // The compiled module is supplied below; no Wasm URL needs resolving.
      // Emscripten otherwise resolves against import.meta.url, which is a blob URL.
      locateFile: (name) => name,
      instantiateWasm(imports, receiveInstance) {
        const instance = new WebAssembly.Instance(wasmModule, imports);
        // Preserve Emscripten's Asyncify wrappers around the raw exports.
        return receiveInstance(instance, wasmModule);
      },
    });
    return { version: av.version() };
  }
  if (!av) throw new Error('FFmpeg worker is not ready');

  if (type === 'open') {
    session?.delete();
    session = null;
    source?.close();
    source = rangeSource(payload);
    try {
      session = new av.DecodeSession(source);
      await session.open();
    } catch (err) {
      session?.delete();
      session = null;
      source.close();
      throw source.error || err;
    }
    sessionId += 1;
    return { sessionId, info: session.info() };
  }
  if (payload.sessionId !== sessionId || !session) {
    throw new Error('Decode session is no longer active');
  }
  if (type === 'read') {
    const result = await session.read();
    if (source.error) throw source.error;
    return result;
  }
  if (type === 'seek') {
    await session.seek(payload.time);
    if (source.error) throw source.error;
    return null;
  }
  if (type === 'close') {
    session.delete();
    session = null;
    source?.close();
    source = null;
    return null;
  }
  throw new Error(`Unknown worker request: ${type}`);
}

function transferables(result) {
  const buffers = [];
  for (const chunk of result?.chunks || []) {
    const data = chunk.rgba || chunk.samples;
    if (data?.buffer instanceof ArrayBuffer) buffers.push(data.buffer);
  }
  return buffers;
}
