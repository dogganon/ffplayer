let av = null;
let session = null;
let sessionId = 0;

self.addEventListener('message', async (event) => {
  const { id, type, payload } = event.data;
  try {
    const result = await handle(type, payload || {});
    self.postMessage({ id, result }, transferables(result));
  } catch (err) {
    self.postMessage({
      id,
      error: {
        message: String(err?.message ?? err),
        stack: String(err?.stack ?? ''),
      },
    });
  }
});

async function handle(type, payload) {
  if (type === 'ready') {
    const wasmModule = payload.wasmModule;
    av = await createFFplayer({
      instantiateWasm(imports, receiveInstance) {
        const instance = new WebAssembly.Instance(wasmModule, imports);
        receiveInstance(instance, wasmModule);
        return instance.exports;
      },
    });
    return { version: av.version() };
  }
  if (!av) throw new Error('FFmpeg worker is not ready');

  if (type === 'open') {
    session?.delete();
    session = new av.DecodeSession(new Uint8Array(payload.bytes));
    sessionId += 1;
    return { sessionId, info: session.info() };
  }
  if (payload.sessionId !== sessionId || !session) {
    throw new Error('Decode session is no longer active');
  }
  if (type === 'read') return session.read();
  if (type === 'seek') {
    session.seek(payload.time);
    return null;
  }
  if (type === 'close') {
    session.delete();
    session = null;
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
