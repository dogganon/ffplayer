let audioContext = null;

export class MediaViewer {
  constructor(root, options = {}) {
    this.root = root;
    this.player = null;
    this.av = null;
    this.settings = normalizeSettings(options.settings);
    this.onSettingsChange = typeof options.onSettingsChange === 'function' ? options.onSettingsChange : null;
    this.root.innerHTML = `
      <div class="viewer-bar">
        <button class="play" type="button" disabled title="Play or pause">Play</button>
        <button class="stop" type="button" disabled title="Stop">Stop</button>
        <button class="step-back" type="button" disabled title="Back 5 seconds">-5s</button>
        <input class="timeline" type="range" min="0" max="0" step="0.01" value="0" disabled aria-label="Playback position">
        <button class="step-forward" type="button" disabled title="Forward 5 seconds">+5s</button>
        <div class="time">0:00 / unknown</div>
        <label class="input-control speed-control">
          <span>Speed</span>
          <input class="playback-rate" type="number" step="0.05" value="1" disabled inputmode="decimal" aria-label="Playback speed">
          <span aria-hidden="true">x</span>
        </label>
        <label class="checkbox-control autoplay-control">
          <input class="autoplay" type="checkbox">
          <span>Autoplay</span>
        </label>
        <label class="checkbox-control autoloop-control">
          <input class="autoloop" type="checkbox">
          <span>Loop</span>
        </label>
        <label class="select-control view-mode-control">
          <span>View</span>
          <select class="view-mode" aria-label="Video sizing mode">
            <option value="width">Fit width</option>
            <option value="page">Fit page</option>
            <option value="actual">Actual size</option>
          </select>
        </label>
        <label class="range-control tile-control" title="Tile size">
          <span>Tiles</span>
          <input class="tile-scale" type="range" min="180" max="640" step="20" value="180" aria-label="Tile size">
        </label>
        <div class="status" aria-live="polite"></div>
      </div>
      <div class="viewer-shell">
        <section class="stage"><div class="note">Open a media file.</div></section>
        <aside class="details"></aside>
      </div>
      <div class="loading-overlay" role="status" aria-live="polite" hidden>
        <div class="spinner" aria-hidden="true"></div>
        <div class="loading-text">Loading...</div>
      </div>
    `;
    this.els = {
      play: this.root.querySelector('.play'),
      stop: this.root.querySelector('.stop'),
      stepBack: this.root.querySelector('.step-back'),
      timeline: this.root.querySelector('.timeline'),
      stepForward: this.root.querySelector('.step-forward'),
      time: this.root.querySelector('.time'),
      playbackRate: this.root.querySelector('.playback-rate'),
      autoplay: this.root.querySelector('.autoplay'),
      autoloop: this.root.querySelector('.autoloop'),
      viewMode: this.root.querySelector('.view-mode'),
      tileScale: this.root.querySelector('.tile-scale'),
      status: this.root.querySelector('.status'),
      shell: this.root.querySelector('.viewer-shell'),
      stage: this.root.querySelector('.stage'),
      details: this.root.querySelector('.details'),
      overlay: this.root.querySelector('.loading-overlay'),
      overlayText: this.root.querySelector('.loading-text'),
    };
    this.els.play.addEventListener('click', () => {
      if (!this.player) return;
      this.player.playing ? this.player.pause() : this.player.play();
    });
    this.els.stop.addEventListener('click', () => this.player?.stop());
    this.els.stepBack.addEventListener('click', () => this.player?.seekBy(-5));
    this.els.stepForward.addEventListener('click', () => this.player?.seekBy(5));
    this.els.timeline.addEventListener('input', () => this.player?.seek(Number(this.els.timeline.value)));
    this.els.playbackRate.addEventListener('change', () => {
      const rate = Number(this.els.playbackRate.value);
      if (!Number.isFinite(rate) || rate <= 0) {
        this.els.playbackRate.value = String(this.settings.playbackRate);
        return;
      }
      this.settings.playbackRate = rate;
      this.persistSettings();
      this.player?.setPlaybackRate(rate);
    });
    this.els.autoplay.addEventListener('change', () => {
      this.settings.autoplay = this.els.autoplay.checked;
      this.persistSettings();
    });
    this.els.autoloop.addEventListener('change', () => {
      this.settings.autoloop = this.els.autoloop.checked;
      this.persistSettings();
    });
    this.els.viewMode.addEventListener('change', () => {
      this.settings.viewMode = normalizeViewMode(this.els.viewMode.value);
      this.applyViewMode();
      this.persistSettings();
    });
    this.els.tileScale.addEventListener('input', () => {
      this.settings.tileScale = clamp(
        Number(this.els.tileScale.value),
        Number(this.els.tileScale.min),
        Number(this.els.tileScale.max),
      );
      this.applyTileScale();
      this.persistSettings();
    });
    this.resumeAudio = () => this.player?.resumeAudio();
    this.root.addEventListener('pointerdown', this.resumeAudio, true);
    this.root.addEventListener('keydown', this.resumeAudio, true);
    this.els.playbackRate.value = String(this.settings.playbackRate);
    this.els.autoplay.checked = this.settings.autoplay;
    this.els.autoloop.checked = this.settings.autoloop;
    this.els.viewMode.value = this.settings.viewMode;
    this.els.tileScale.value = String(this.settings.tileScale);
    this.applyViewMode();
    this.applyTileScale();
  }

  applySettings(settings) {
    this.settings = normalizeSettings(settings);
    this.els.playbackRate.value = String(this.settings.playbackRate);
    this.els.autoplay.checked = this.settings.autoplay;
    this.els.autoloop.checked = this.settings.autoloop;
    this.els.viewMode.value = this.settings.viewMode;
    this.els.tileScale.value = String(this.settings.tileScale);
    this.applyViewMode();
    this.applyTileScale();
    this.player?.setPlaybackRate(this.settings.playbackRate);
  }

  applyTileScale() {
    const size = this.settings.tileScale;
    this.root.style.setProperty('--tile-min', `${size}px`);
    this.root.style.setProperty('--tile-max', `${Math.max(size, Math.round(size * 1.75))}px`);
  }

  applyViewMode() {
    this.root.dataset.videoFit = this.settings.viewMode;
  }

  persistSettings() {
    this.onSettingsChange?.(settingsSnapshot(this.settings));
  }

  async ready() {
    this.setBusy(true, 'Loading FFmpeg...');
    try {
      await nextPaint();
      this.av = await DecoderClient.create();
      this.setStatus(`FFmpeg ${this.av.version()}`);
      return this.av;
    } finally {
      this.setBusy(false);
    }
  }

  async open(item) {
    if (!this.av || (!item.file && !item.readRange)) return;
    const opening = this.opening = (this.opening || 0) + 1;
    this.player?.destroy();
    this.player = null;
    this.setBusy(true, `Opening ${item.name}...`);
    try {
      await nextPaint();
      if (opening !== this.opening) return;
      const session = await this.av.open(item);
      if (opening !== this.opening) { session.delete(); return; }
      this.player = new StreamingPlayer(this, session, item);
      this.player.mount();
      this.setControlsEnabled(true);
      if (this.settings.autoplay) {
        try {
          await this.player.play();
        } catch (err) {
          reportError('Autoplay failed', err);
          this.setStatus('Autoplay was blocked. Press Play to start.', true);
        }
      }
    } catch (err) {
      if (opening !== this.opening) return;
      reportError('Failed to open media', err);
      this.setStatus(String(err?.message ?? err), true);
      this.showStageNote(String(err?.message ?? err), true);
    } finally {
      if (opening === this.opening) this.setBusy(false);
    }
  }

  setStatus(text, error = false) {
    this.els.status.textContent = text;
    this.els.status.classList.toggle('error', error);
  }

  setBusy(busy, text = 'Loading...') {
    this.root.classList.toggle('busy', busy);
    this.els.overlay.hidden = !busy;
    if (busy) this.els.overlayText.textContent = text;
  }

  showStageNote(text, error = false) {
    this.els.stage.replaceChildren(el('div', `empty-state${error ? ' error' : ''}`, [el('div', 'empty-title', text)]));
  }

  destroy() {
    this.root.removeEventListener('pointerdown', this.resumeAudio, true);
    this.root.removeEventListener('keydown', this.resumeAudio, true);
    this.player?.destroy();
    this.av?.delete();
  }

  setControlsEnabled(enabled) {
    for (const control of [
      this.els.play,
      this.els.stop,
      this.els.stepBack,
      this.els.timeline,
      this.els.stepForward,
      this.els.playbackRate,
    ]) {
      control.disabled = !enabled;
    }
  }
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

export function reportError(message, err) {
  console.error(message, err);
}

class DecoderClient {
  static async create() {
    const [runtimeSource, workerSource, wasmBinary] = await Promise.all([
      fetchSource(new URL('./ffplayer.mjs', import.meta.url), 'FFmpeg runtime'),
      fetchSource(new URL('./decode-worker.js', import.meta.url), 'decode worker'),
      fetchBinary(new URL('./ffplayer.wasm', import.meta.url), 'FFmpeg WebAssembly'),
    ]);
    const wasmModule = await WebAssembly.compile(wasmBinary);
    const workerUrl = URL.createObjectURL(new Blob([
      workerRuntimeSource(runtimeSource),
      '\n',
      workerSource,
    ], { type: 'text/javascript' }));
    const client = new DecoderClient(new Worker(workerUrl, { type: 'module' }), workerUrl);
    const ready = await client.call('ready', { wasmModule });
    client.ffmpegVersion = ready.version;
    return client;
  }

  constructor(worker, workerUrl) {
    this.worker = worker;
    this.workerUrl = workerUrl;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.worker.addEventListener('message', (event) => this.handleMessage(event.data));
    this.worker.addEventListener('error', (event) => this.failAll(new Error(event.message || 'Decode worker failed')));
  }

  version() {
    return this.ffmpegVersion;
  }

  async open(item) {
    const channel = new MessageChannel();
    channel.port1.onmessage = async ({ data }) => {
      try {
        const bytes = await item.readRange(data.offset, data.length);
        const buffer = transferableBuffer(bytes);
        channel.port1.postMessage({ id: data.id, bytes: buffer }, [buffer]);
      } catch (err) {
        channel.port1.postMessage({ id: data.id, error: String(err?.message ?? err) });
      }
    };
    try {
      const result = await this.call('open', {
        file: item.file, size: item.size, port: item.file ? undefined : channel.port2,
      }, item.file ? [] : [channel.port2]);
      return new WorkerDecodeSession(this, result.sessionId, result.info, channel.port1);
    } catch (err) {
      channel.port1.close();
      throw err;
    } finally {
      if (item.file) { channel.port1.close(); channel.port2.close(); }
    }
  }

  call(type, payload = {}, transfer = []) {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload }, transfer);
    });
  }

  handleMessage(message) {
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);
    if (message.error) {
      const err = new Error(message.error.message);
      err.stack = message.error.stack || err.stack;
      request.reject(err);
    } else {
      request.resolve(message.result);
    }
  }

  failAll(err) {
    for (const request of this.pending.values()) request.reject(err);
    this.pending.clear();
  }

  delete() {
    this.failAll(new Error('Decode worker was closed'));
    this.worker.terminate();
    URL.revokeObjectURL(this.workerUrl);
  }
}

async function fetchSource(url, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${label}: ${response.status}`);
  return response.text();
}

async function fetchBinary(url, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${label}: ${response.status}`);
  return response.arrayBuffer();
}

function workerRuntimeSource(source) {
  const exportStatement = 'export default createFFplayer;';
  const exportIndex = source.lastIndexOf(exportStatement);
  if (exportIndex < 0) throw new Error('FFmpeg runtime has an unexpected module format');
  return source.slice(0, exportIndex) + source.slice(exportIndex + exportStatement.length);
}

class WorkerDecodeSession {
  constructor(client, id, info, port) {
    this.port = port;
    this.client = client;
    this.id = id;
    this.streamInfo = info;
  }

  info() {
    return this.streamInfo;
  }

  read() {
    return this.client.call('read', { sessionId: this.id });
  }

  seek(time) {
    return this.client.call('seek', { sessionId: this.id, time });
  }

  delete() {
    this.client.call('close', { sessionId: this.id }).catch(() => {}).finally(() => this.port.close());
  }
}

function transferableBuffer(bytes) {
  if (bytes instanceof Uint8Array && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }
  if (ArrayBuffer.isView(bytes)) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  if (bytes instanceof ArrayBuffer) return bytes;
  return new Uint8Array(bytes).buffer;
}

class StreamingPlayer {
  constructor(viewer, session, item) {
    this.viewer = viewer;
    this.session = session;
    this.item = item;
    this.info = session.info();
    this.tracks = new Map();
    this.playing = false;
    this.done = false;
    this.startWall = 0;
    this.offset = 0;
    this.raf = 0;
    this.pumpPending = false;
    this.generation = 0;
    this.audioSources = [];
    this.duration = Number.isFinite(this.info.durationSeconds) && this.info.durationSeconds > 0 ? this.info.durationSeconds : 0;
    this.playbackRate = viewer.settings.playbackRate;
  }

  mount() {
    this.updateControls();
    this.viewer.els.timeline.max = String(this.duration || 0);
    this.viewer.setBusy(true, 'Preparing tracks...');
    renderDetails(this.viewer, this.item, this.info);
    const ordered = [...this.info.streams].sort((a, b) => scoreTrack(b) - scoreTrack(a) || a.index - b.index);
    const videoGrid = document.createElement('div');
    videoGrid.className = 'tracks video-tracks';
    const secondaryGrid = document.createElement('div');
    secondaryGrid.className = 'tracks secondary-tracks';
    for (const stream of ordered) {
      const view = new TrackView(stream);
      this.tracks.set(stream.index, view);
      (stream.type === 'video' ? videoGrid : secondaryGrid).append(view.el);
    }
    this.viewer.els.stage.replaceChildren(videoGrid, secondaryGrid);
    this.pump();
    this.viewer.setStatus(`${this.info.streams.length} track${this.info.streams.length === 1 ? '' : 's'} opened.`);
    this.viewer.setBusy(false);
  }

  destroy() {
    this.destroyed = true;
    this.generation += 1;
    this.pause();
    for (const track of this.tracks.values()) track.destroy();
    this.session?.delete?.();
  }

  bufferFull() {
    const now = this.currentPlaybackTime();
    let bytes = 0;
    let ahead = 0;
    for (const track of this.tracks.values()) {
      for (const frame of track.video) {
        // The displayed frame cannot be released until its successor arrives.
        if (frame !== track.drawn) bytes += frame.rgba.byteLength;
        ahead = Math.max(ahead, frame.time - now);
      }
      for (const chunk of track.audio) {
        bytes += chunk.samples.byteLength;
        ahead = Math.max(ahead, chunk.time + chunk.samples.length / chunk.channels / chunk.sampleRate - now);
      }
    }
    for (const source of this.audioSources) {
      bytes += source.buffer.length * source.buffer.numberOfChannels * 4;
      ahead = Math.max(ahead, source.mediaEnd - now);
    }
    return bytes >= 64 * 1024 * 1024 || ahead >= 2;
  }

  async pump() {
    if (this.destroyed || this.done || this.pumpPending || this.bufferFull()) return;
    const generation = this.generation;
    this.pumpPending = true;
    try {
      const batch = await this.session.read();
      if (generation !== this.generation) return;
      this.done = batch.done;
      for (const chunk of batch.chunks) {
        this.tracks.get(chunk.stream)?.push(chunk);
      }
      if (this.playing) this.scheduleAudio();
    } catch (err) {
      if (generation !== this.generation) return;
      reportError('Failed while decoding media', err);
      this.viewer.setStatus(String(err?.message ?? err), true);
      this.done = true;
    } finally {
      this.pumpPending = false;
    }
    if (generation === this.generation && this.playing && !this.done) {
      this.pump();
    }
  }

  async play() {
    if (this.needsSeek) {
      await this.seek(this.offset);
      if (this.needsSeek) return;
    }
    if (this.destroyed) return;
    audioContext ||= new AudioContext();
    this.playing = true;
    this.startWall = performance.now() / 1000 - this.offset / this.playbackRate;
    this.resumeAudio();
    this.scheduleAudio();
    this.pump();
    this.tick();
    this.updateControls();
  }

  resumeAudio() {
    if (!audioContext || audioContext.state === 'running' || audioContext.state === 'closed') return;
    audioContext.resume()
      .then(() => {
        if (this.playing) this.scheduleAudio();
      })
      .catch((err) => reportError('Failed to resume audio', err));
  }

  pause() {
    if (this.playing) {
      this.offset = this.currentPlaybackTime();
      this.needsSeek = true;
    }
    this.playing = false;
    cancelAnimationFrame(this.raf);
    for (const source of this.audioSources) source.stop();
    this.audioSources = [];
    this.updateControls();
  }

  stop() {
    this.pause();
    this.seek(0);
  }

  seekBy(delta) {
    this.seek(this.currentPlaybackTime() + delta);
  }

  async seek(time) {
    const max = this.duration || Math.max(this.offset, 0);
    const target = clamp(time, 0, max);
    const wasPlaying = this.playing;
    this.pause();
    const generation = ++this.generation;
    for (const track of this.tracks.values()) track.clear();
    this.offset = target;
    this.startWall = performance.now() / 1000 - this.offset / this.playbackRate;
    this.updateControls();
    try {
      await this.session.seek(target);
      if (generation !== this.generation) return;
      this.done = false;
      this.needsSeek = false;
    } catch (err) {
      if (generation !== this.generation) return;
      reportError(`Failed to seek ${this.item.name}`, err);
      this.viewer.setStatus(String(err?.message ?? err), true);
      return;
    }
    this.pump();
    if (wasPlaying) await this.play();
  }

  async setPlaybackRate(rate) {
    if (!Number.isFinite(rate) || rate <= 0) {
      this.updateControls();
      return;
    }
    if (rate === this.playbackRate) return;
    const target = this.currentPlaybackTime();
    const wasPlaying = this.playing;
    this.playbackRate = rate;
    this.updateControls();
    if (wasPlaying) await this.seek(target);
  }

  currentPlaybackTime() {
    if (!this.playing) return this.offset;
    return (performance.now() / 1000 - this.startWall) * this.playbackRate;
  }

  tick() {
    if (!this.playing) return;
    const t = this.currentPlaybackTime();
    this.offset = this.duration ? Math.min(t, this.duration) : t;
    this.viewer.setStatus(`${this.item.name}  ${formatDuration(t)}${this.done ? '' : '  decoding...'}`);
    for (const track of this.tracks.values()) track.render(t);
    this.scheduleAudio();
    this.pump();
    this.updateControls();
    if (this.duration && this.offset >= this.duration) {
      if (this.viewer.settings.autoloop) this.seek(0);
      else this.stop();
      return;
    }
    this.raf = requestAnimationFrame(() => this.tick());
  }

  scheduleAudio() {
    if (!audioContext || audioContext.state !== 'running') return;
    const playbackTime = this.currentPlaybackTime();
    for (const track of this.tracks.values()) {
      if (track.stream.type !== 'audio') continue;
      const chunks = track.audio.splice(0);
      let sequentialWhen = audioContext.currentTime + 0.04;
      for (const chunk of chunks) {
        const channels = Math.max(1, chunk.channels || 1);
        const frames = Math.floor(chunk.samples.length / channels);
        if (!frames) continue;
        const buffer = audioContext.createBuffer(channels, frames, chunk.sampleRate || audioContext.sampleRate);
        for (let channel = 0; channel < channels; channel += 1) {
          const dst = buffer.getChannelData(channel);
          for (let i = 0; i < frames; i += 1) dst[i] = chunk.samples[i * channels + channel] || 0;
        }
        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = this.playbackRate;
        source.connect(track.audioOutput(audioContext));
        source.onended = () => {
          const index = this.audioSources.indexOf(source);
          if (index >= 0) this.audioSources.splice(index, 1);
        };
        const mediaTime = Number.isFinite(chunk.time) ? chunk.time : null;
        const when = mediaTime == null ? sequentialWhen : audioContext.currentTime + (mediaTime - playbackTime) / this.playbackRate;
        const offset = Math.max(0, (audioContext.currentTime - when) * this.playbackRate);
        if (offset >= buffer.duration) continue;
        source.start(Math.max(when, audioContext.currentTime), offset);
        sequentialWhen = when + buffer.duration / this.playbackRate;
        source.mediaEnd = (mediaTime ?? playbackTime) + buffer.duration;
        this.audioSources.push(source);
      }
    }
  }

  updateControls() {
    this.viewer.els.play.textContent = this.playing ? 'Pause' : 'Play';
    this.viewer.els.timeline.max = String(this.duration || Math.max(this.offset, 0));
    this.viewer.els.timeline.value = String(this.offset);
    this.viewer.els.playbackRate.value = String(this.playbackRate);
    this.viewer.els.time.textContent = `${formatDuration(this.offset)} / ${formatDuration(this.duration)}`;
  }
}

class TrackView {
  constructor(stream) {
    this.stream = stream;
    this.video = [];
    this.audio = [];
    this.drawn = -1;
    this.el = streamCard(stream);
    this.canvas = this.el.querySelector('canvas');
    this.ctx = this.canvas?.getContext('2d');
    this.note = this.el.querySelector('.note');
    this.volume = 1;
    this.muted = false;
    this.gain = null;
    this.muteButton = this.el.querySelector('.track-mute');
    this.volumeInput = this.el.querySelector('.track-volume');
    this.muteButton?.addEventListener('click', () => this.toggleMute());
    this.volumeInput?.addEventListener('input', () => this.setVolume(Number(this.volumeInput.value)));
    this.updateAudioControls();
  }

  push(chunk) {
    if (chunk.type === 'video') {
      this.video.push(chunk);
      this.note.textContent = `${formatDuration(chunk.time)}`;
      if (this.video.length === 1) this.render(0);
    } else if (chunk.type === 'audio') {
      this.audio.push(chunk);
      this.note.textContent = `${this.audio.length} chunk${this.audio.length === 1 ? '' : 's'}`;
    }
  }

  render(time) {
    if (!this.ctx || !this.video.length) return;
    let index = 0;
    while (index + 1 < this.video.length && this.video[index + 1].time <= time) index += 1;
    if (index > 0) this.video.splice(0, index);
    const frame = this.video[0];
    if (this.drawn === frame) return;
    this.drawn = frame;
    if (this.canvas.width !== frame.width || this.canvas.height !== frame.height) {
      this.canvas.width = frame.width;
      this.canvas.height = frame.height;
    }
    this.ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.rgba), frame.width, frame.height), 0, 0);
  }

  audioOutput(context) {
    if (!this.gain) {
      this.gain = context.createGain();
      this.gain.connect(context.destination);
      this.updateGain();
    }
    return this.gain;
  }

  toggleMute() {
    if (this.muted && this.volume === 0) this.volume = 1;
    this.muted = !this.muted;
    this.updateGain();
    this.updateAudioControls();
  }

  setVolume(volume) {
    this.volume = clamp(volume, 0, 1);
    this.muted = this.volume === 0;
    this.updateGain();
    this.updateAudioControls();
  }

  updateGain() {
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
  }

  updateAudioControls() {
    if (this.muteButton) this.muteButton.textContent = this.muted ? 'Unmute' : 'Mute';
    if (this.volumeInput) this.volumeInput.value = String(this.volume);
  }

  destroy() {
    this.gain?.disconnect();
    this.gain = null;
  }

  clear() {
    this.video = [];
    this.audio = [];
    this.drawn = -1;
    if (this.ctx && this.canvas) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    this.note.textContent = this.stream.decodable ? 'Waiting for decoded chunks' : (this.stream.decodeError || 'Metadata only');
  }
}

function streamCard(stream) {
  const card = document.createElement('article');
  card.className = `track ${stream.type || 'unknown'}`;
  let media;
  if (stream.type === 'video') {
    media = document.createElement('div');
    media.className = 'video-frame';
    const canvas = document.createElement('canvas');
    media.append(canvas);
  } else {
    media = document.createElement('div');
  }
  if (stream.type === 'audio') {
    media.className = 'audio-controls';
    const mute = el('button', 'track-mute', 'Mute');
    mute.type = 'button';
    mute.title = `Mute audio stream ${stream.index}`;
    mute.disabled = !stream.decodable;
    const volume = document.createElement('input');
    volume.className = 'track-volume';
    volume.type = 'range';
    volume.min = '0';
    volume.max = '1';
    volume.step = '0.01';
    volume.value = '1';
    volume.disabled = !stream.decodable;
    volume.setAttribute('aria-label', `Volume for audio stream ${stream.index}`);
    const volumeControl = el('label', 'range-control track-volume-control', [el('span', '', 'Volume'), volume]);
    media.append(mute, volumeControl);
  }
  if (stream.type !== 'video' && stream.type !== 'audio') {
    media.className = 'audio-meter';
    media.textContent = stream.type || 'metadata';
  }
  card.append(
    el('div', 'track-head', [
      el('div', 'track-title', `${stream.type || 'unknown'} / ${stream.codec || 'unknown'}`),
      el('div', 'track-id', `stream ${stream.index}${stream.id != null ? ` / id ${stream.id}` : ''}`),
    ]),
    media,
    disclosure('Metadata', metadataList(streamFields(stream))),
    el('div', 'note', stream.decodable ? 'Waiting for decoded chunks' : (stream.decodeError || 'Metadata only')),
  );
  card.title = streamTooltip(stream);
  return card;
}

function renderDetails(viewer, item, info) {
  const container = [
    ['file', item.name],
    ['size', formatBytes(item.size ?? item.bytes?.byteLength ?? 0)],
    ['format', info.format || 'unknown'],
    ['duration', formatDuration(info.durationSeconds)],
    ['ffmpeg', info.ffmpegVersion || viewer.av.version()],
  ];
  const meta = objectEntries(info.metadata);
  const sections = [
    disclosure('Container', metadataList(container)),
    disclosure('Container metadata', meta.length ? metadataList(meta) : el('div', 'note', 'No container metadata')),
    disclosure('Tracks', metadataList(info.streams.map((s) => [`#${s.index}${s.id != null ? ` id ${s.id}` : ''}`, `${s.type || 'unknown'} / ${s.codec || 'unknown'}`]))),
  ];
  viewer.els.shell.classList.add('has-details');
  viewer.els.details.replaceChildren(...sections);
}

function streamFields(stream) {
  const rows = [
    ['index', stream.index],
    ['id', stream.id ?? 'n/a'],
    ['type', stream.type || 'unknown'],
    ['codec', stream.codec || 'unknown'],
  ];
  if (stream.width || stream.height) rows.push(['size', `${stream.width || '?'} x ${stream.height || '?'}`]);
  if (stream.sampleRate) rows.push(['sample rate', `${stream.sampleRate} Hz`]);
  if (stream.channels) rows.push(['channels', stream.channels]);
  for (const [key, value] of objectEntries(stream.metadata)) rows.push([`meta:${key}`, value]);
  if (stream.decodeError) rows.push(['decode', stream.decodeError]);
  return rows;
}

function scoreTrack(stream) {
  if (stream.type === 'video') return 30 + ((stream.width || 0) * (stream.height || 0)) / 1_000_000;
  if (stream.type === 'audio') return 20;
  if (stream.type === 'subtitle') return 10;
  return 0;
}

function metadataList(rows) {
  const dl = document.createElement('dl');
  dl.className = 'kv';
  for (const [key, value] of rows) {
    dl.append(el('dt', '', String(key)), el('dd', '', String(value)));
  }
  return dl;
}

function section(title, body) {
  const node = document.createElement('section');
  node.className = 'section';
  node.append(el('h2', '', title), body);
  return node;
}

function disclosure(title, body) {
  const node = document.createElement('details');
  node.className = 'section';
  node.append(el('summary', '', title), body);
  return node;
}

function streamTooltip(stream) {
  const bits = [
    `stream ${stream.index}${stream.id != null ? ` / id ${stream.id}` : ''}`,
    `${stream.type || 'unknown'} / ${stream.codec || 'unknown'}`,
  ];
  if (stream.width || stream.height) bits.push(`${stream.width || '?'} x ${stream.height || '?'}`);
  if (stream.sampleRate) bits.push(`${stream.sampleRate} Hz`);
  if (stream.channels) bits.push(`${stream.channels} ch`);
  return bits.join('\n');
}

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (Array.isArray(content)) node.append(...content);
  else if (content != null) node.textContent = content;
  return node;
}

function objectEntries(value) {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).filter(([, v]) => v != null && v !== '');
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'unknown';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
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

function pad(value) {
  return String(value).padStart(2, '0');
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function normalizeSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const playbackRate = Number(source.playbackRate);
  const tileScale = Number(source.tileScale);
  return {
    version: 1,
    playbackRate: Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1,
    autoplay: Boolean(source.autoplay),
    autoloop: Boolean(source.autoloop),
    viewMode: normalizeViewMode(source.viewMode),
    tileScale: Number.isFinite(tileScale) ? clamp(tileScale, 180, 640) : 180,
  };
}

function settingsSnapshot(settings) {
  return {
    version: 1,
    playbackRate: settings.playbackRate,
    autoplay: settings.autoplay,
    autoloop: settings.autoloop,
    viewMode: settings.viewMode,
    tileScale: settings.tileScale,
  };
}

function normalizeViewMode(value) {
  return ['width', 'page', 'actual'].includes(value) ? value : 'width';
}
