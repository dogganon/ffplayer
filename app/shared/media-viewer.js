import createFFplayer from './ffplayer.mjs';

let avModulePromise = null;
let audioContext = null;
const PAUSED_DECODE_CHUNK_LIMIT = 12;

export class MediaViewer {
  constructor(root) {
    this.root = root;
    this.player = null;
    this.av = null;
    this.root.innerHTML = `
      <div class="viewer-bar">
        <button class="play" type="button" disabled title="Play or pause">Play</button>
        <button class="stop" type="button" disabled title="Stop">Stop</button>
        <button class="step-back" type="button" disabled title="Back 5 seconds">-5s</button>
        <input class="timeline" type="range" min="0" max="0" step="0.01" value="0" disabled aria-label="Playback position">
        <button class="step-forward" type="button" disabled title="Forward 5 seconds">+5s</button>
        <div class="time">0:00 / unknown</div>
        <button class="mute" type="button" disabled title="Mute">Mute</button>
        <input class="volume" type="range" min="0" max="1" step="0.01" value="1" disabled aria-label="Volume">
        <input class="tile-scale" type="range" min="180" max="640" step="20" value="260" title="Tile size" aria-label="Tile size">
        <div class="status">Loading FFmpeg...</div>
      </div>
      <div class="viewer-shell">
        <section class="stage"><div class="note">Open a media file.</div></section>
        <aside class="details"></aside>
      </div>
      <div class="loading-overlay" hidden>
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
      mute: this.root.querySelector('.mute'),
      volume: this.root.querySelector('.volume'),
      tileScale: this.root.querySelector('.tile-scale'),
      status: this.root.querySelector('.status'),
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
    this.els.mute.addEventListener('click', () => this.player?.toggleMute());
    this.els.volume.addEventListener('input', () => this.player?.setVolume(Number(this.els.volume.value)));
    this.els.tileScale.addEventListener('input', () => {
      const size = Number(this.els.tileScale.value);
      this.root.style.setProperty('--tile-min', `${size}px`);
      this.root.style.setProperty('--tile-max', `${Math.max(size, Math.round(size * 1.75))}px`);
    });
  }

  async ready() {
    this.setBusy(true, 'Loading FFmpeg...');
    try {
      await nextPaint();
      this.av = await loadAV();
      this.setStatus(`FFmpeg ${this.av.version()}`);
      return this.av;
    } finally {
      this.setBusy(false);
    }
  }

  async open(item) {
    if (!this.av || !item.bytes) return;
    this.player?.destroy();
    this.setBusy(true, `Opening ${item.name}...`);
    this.showStageNote(`Opening ${item.name}...`);
    try {
      await nextPaint();
      this.player = new StreamingPlayer(this, new this.av.DecodeSession(item.bytes), item);
      this.player.mount();
      this.setControlsEnabled(true);
    } catch (err) {
      reportError('Failed to open media', err);
      this.setStatus(String(err?.message ?? err), true);
      this.showStageNote(String(err?.message ?? err), true);
    } finally {
      this.setBusy(false);
    }
  }

  setStatus(text, error = false) {
    this.els.status.textContent = text;
    this.els.status.classList.toggle('error', error);
  }

  setBusy(busy, text = 'Loading...') {
    this.root.classList.toggle('busy', busy);
    this.els.overlay.hidden = !busy;
    this.els.overlayText.textContent = text;
    this.setStatus(text);
  }

  showStageNote(text, error = false) {
    this.els.stage.replaceChildren(el('div', `empty-state${error ? ' error' : ''}`, [
      el('div', 'spinner', ''),
      el('div', 'empty-title', text),
    ]));
  }

  destroy() {
    this.player?.destroy();
  }

  setControlsEnabled(enabled) {
    for (const control of [
      this.els.play,
      this.els.stop,
      this.els.stepBack,
      this.els.timeline,
      this.els.stepForward,
      this.els.mute,
      this.els.volume,
    ]) {
      control.disabled = !enabled;
    }
  }
}

function loadAV() {
  avModulePromise ||= createFFplayer({ locateFile: (path) => new URL(path, import.meta.url).href });
  return avModulePromise;
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

export function reportError(message, err) {
  console.error(message, err);
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
    this.pumpTimer = 0;
    this.audioSources = [];
    this.pausedDecodeChunks = 0;
    this.duration = Number.isFinite(this.info.durationSeconds) && this.info.durationSeconds > 0 ? this.info.durationSeconds : 0;
    this.volume = 1;
    this.muted = false;
    this.gain = null;
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
    this.pause();
    clearTimeout(this.pumpTimer);
    this.session?.delete?.();
  }

  pump() {
    if (this.done) return;
    try {
      const batch = this.session.read(this.playing ? 12 : 6);
      this.done = batch.done;
      if (!this.playing) this.pausedDecodeChunks += batch.chunks.length;
      for (const chunk of batch.chunks) {
        this.tracks.get(chunk.stream)?.push(chunk);
      }
      if (this.playing) this.scheduleAudio();
      if (!this.done && (this.playing || this.pausedDecodeChunks < PAUSED_DECODE_CHUNK_LIMIT)) {
        this.pumpTimer = setTimeout(() => this.pump(), this.playing ? 0 : 16);
      }
    } catch (err) {
      reportError('Failed while decoding media', err);
      this.viewer.setStatus(String(err?.message ?? err), true);
      this.done = true;
    }
  }

  async play() {
    audioContext ||= new AudioContext();
    await audioContext.resume();
    if (!this.gain) {
      this.gain = audioContext.createGain();
      this.gain.connect(audioContext.destination);
      this.updateGain();
    }
    this.playing = true;
    this.pausedDecodeChunks = 0;
    this.startWall = performance.now() / 1000 - this.offset;
    this.scheduleAudio();
    this.pump();
    this.tick();
    this.updateControls();
  }

  pause() {
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
    this.seek(this.offset + delta);
  }

  seek(time) {
    const max = this.duration || Math.max(this.offset, 0);
    const target = clamp(time, 0, max);
    const wasPlaying = this.playing;
    this.pause();
    clearTimeout(this.pumpTimer);
    try {
      this.session.seek(target);
      this.done = false;
      this.pausedDecodeChunks = 0;
      for (const track of this.tracks.values()) track.clear();
    } catch (err) {
      reportError(`Failed to seek ${this.item.name}`, err);
      this.viewer.setStatus(String(err?.message ?? err), true);
    }
    this.offset = target;
    this.startWall = performance.now() / 1000 - this.offset;
    this.updateControls();
    this.pump();
    if (wasPlaying) this.play();
  }

  toggleMute() {
    this.muted = !this.muted;
    this.updateGain();
    this.updateControls();
  }

  setVolume(volume) {
    this.volume = clamp(volume, 0, 1);
    this.muted = this.volume === 0;
    this.updateGain();
    this.updateControls();
  }

  updateGain() {
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
  }

  tick() {
    if (!this.playing) return;
    const t = performance.now() / 1000 - this.startWall;
    this.offset = this.duration ? Math.min(t, this.duration) : t;
    this.viewer.setStatus(`${this.item.name}  ${formatDuration(t)}${this.done ? '' : '  decoding...'}`);
    for (const track of this.tracks.values()) track.render(t);
    this.updateControls();
    if (this.duration && this.offset >= this.duration) {
      this.stop();
      return;
    }
    this.raf = requestAnimationFrame(() => this.tick());
  }

  scheduleAudio() {
    for (const track of this.tracks.values()) {
      if (track.stream.type !== 'audio') continue;
      const chunks = track.audio.splice(0);
      let when = audioContext.currentTime + 0.04;
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
        source.connect(this.gain || audioContext.destination);
        source.start(when);
        when += buffer.duration;
        this.audioSources.push(source);
      }
    }
  }

  updateControls() {
    this.viewer.els.play.textContent = this.playing ? 'Pause' : 'Play';
    this.viewer.els.mute.textContent = this.muted ? 'Unmute' : 'Mute';
    this.viewer.els.volume.value = String(this.volume);
    this.viewer.els.timeline.max = String(this.duration || Math.max(this.offset, 0));
    this.viewer.els.timeline.value = String(this.offset);
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
    let index = this.drawn < 0 ? 0 : this.drawn;
    while (index + 1 < this.video.length && this.video[index + 1].time <= time) index += 1;
    if (index === this.drawn) return;
    if (index > 4) {
      this.video.splice(0, index - 2);
      index = 2;
    }
    this.drawn = index;
    const frame = this.video[index];
    if (this.canvas.width !== frame.width || this.canvas.height !== frame.height) {
      this.canvas.width = frame.width;
      this.canvas.height = frame.height;
    }
    this.ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.rgba), frame.width, frame.height), 0, 0);
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
    if (stream.width && stream.height) {
      media.style.aspectRatio = `${stream.width} / ${stream.height}`;
    }
    media.append(canvas);
  } else {
    media = document.createElement('div');
  }
  if (stream.type === 'audio') {
    media.className = 'audio-meter';
    media.textContent = 'audio';
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
