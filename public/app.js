// UI wiring: read a torrent, pair its audio with local files, verify, play fast.

import { parseTorrent, parseMagnet } from './lib/torrent.js';
import { matchFiles, summariseMatches } from './lib/matcher.js';
import { verifyTorrent, PIECE_OK, PIECE_BAD, PIECE_MISSING } from './lib/verify.js';
import { SpeedPlayer, RATE_PRESETS, MIN_RATE, MAX_RATE } from './lib/player.js';
import { formatBytes, formatTime, formatDate, formatRate, formatSemitones } from './lib/format.js';
import { compareNatural } from './lib/media.js';

const $ = (id) => document.getElementById(id);

const state = {
  torrent: null,
  localFiles: [], // { file, path, name, size }
  sources: new Map(), // torrent file index -> File
  match: null,
  verification: null,
  queue: [], // torrent file entries, in play order
  currentIndex: -1,
  verifyController: null,
  seeking: false,
};

const player = new SpeedPlayer();

// ---------------------------------------------------------------- utilities

let toastTimer = 0;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2600);
}

function showError(message) {
  const el = $('load-error');
  el.textContent = message;
  el.hidden = !message;
}

function badge(text, kind = '') {
  const span = document.createElement('span');
  span.className = kind ? `badge ${kind}` : 'badge';
  span.textContent = text;
  return span;
}

// ------------------------------------------------------------ loading input

async function loadTorrentFile(file) {
  showError('');
  try {
    const torrent = await parseTorrent(await file.arrayBuffer());
    applyTorrent(torrent);
    toast(`Read ${torrent.files.length} file${torrent.files.length === 1 ? '' : 's'} from ${file.name}`);
  } catch (error) {
    showError(`Could not read ${file.name}: ${error.message}`);
  }
}

function loadMagnet(uri) {
  showError('');
  try {
    const magnet = parseMagnet(uri);
    // A magnet has no file list — that only arrives from peers — so present the
    // metadata it does carry and say plainly what is missing.
    applyTorrent({
      name: magnet.name || magnet.infoHash,
      infoHash: magnet.infoHash,
      infoHashV2: magnet.infoHashV2,
      metaVersion: magnet.infoHashV2 && !magnet.infoHash ? 2 : 1,
      isHybrid: Boolean(magnet.infoHash && magnet.infoHashV2),
      pieceLength: 0,
      pieces: new Uint8Array(0),
      pieceCount: 0,
      hasPieceHashes: false,
      files: [],
      audioFiles: [],
      totalLength: magnet.totalLength,
      isSingleFile: false,
      trackers: magnet.trackers,
      webSeeds: magnet.webSeeds,
      comment: '',
      createdBy: '',
      creationDate: 0,
      isPrivate: false,
      source: '',
      magnetURI: magnet.magnetURI,
      fromMagnet: true,
    });
    toast('Magnet read — it carries no file list, only an info hash');
  } catch (error) {
    showError(`Could not read that magnet link: ${error.message}`);
  }
}

function applyTorrent(torrent) {
  state.torrent = torrent;
  state.localFiles = [];
  state.sources = new Map();
  state.match = null;
  state.verification = null;
  state.queue = [];
  state.currentIndex = -1;

  renderMeta();
  renderFiles();
  $('panel-meta').hidden = false;
  $('panel-files').hidden = torrent.fromMagnet;
  $('panel-attach').hidden = torrent.fromMagnet;
  $('match-summary').hidden = true;
  $('verify-row').hidden = true;
  $('verify-progress').hidden = true;
  renderPlaylist();
}

// -------------------------------------------------------------- rendering

function renderMeta() {
  const t = state.torrent;
  $('torrent-name').textContent = t.name;

  const rows = [];
  const add = (label, value, mono = false) => rows.push({ label, value, mono });

  add('Total size', t.totalLength ? formatBytes(t.totalLength) : 'unknown');
  if (!t.fromMagnet) {
    add('Files', String(t.files.filter((f) => !f.isPad).length));
    add('Audio files', String(t.audioFiles.length));
    add('Piece length', t.pieceLength ? formatBytes(t.pieceLength) : '—');
    add('Pieces', t.pieceCount ? String(t.pieceCount) : '—');
  }
  add('Protocol', t.isHybrid ? 'v1 + v2 (hybrid)' : `v${t.metaVersion}`);
  if (t.infoHash) add('Info hash (v1)', t.infoHash, true);
  if (t.infoHashV2) add('Info hash (v2)', t.infoHashV2, true);
  if (t.createdBy) add('Created by', t.createdBy);
  if (t.creationDate) add('Created', formatDate(t.creationDate));
  if (t.source) add('Source', t.source);
  if (t.isPrivate) add('Private', 'yes — trackers only, no DHT');
  if (t.comment) add('Comment', t.comment);

  const grid = $('meta-grid');
  grid.replaceChildren();
  for (const row of rows) {
    // Each label/value pair is wrapped so the grid lays out pairs, not
    // alternating cells.
    const cell = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = row.label;
    const dd = document.createElement('dd');
    dd.textContent = row.value;
    if (row.mono) dd.className = 'mono';
    cell.append(dt, dd);
    grid.append(cell);
  }

  $('tracker-count').textContent = String(t.trackers.length);
  const list = $('tracker-list');
  list.replaceChildren();
  for (const tracker of t.trackers) {
    const li = document.createElement('li');
    li.textContent = tracker;
    list.append(li);
  }
  $('trackers-details').hidden = t.trackers.length === 0;

  $('magnet-output').textContent = t.magnetURI || '—';
  $('copy-magnet').disabled = !t.magnetURI;
}

function fileStatusBadge(file) {
  const verified = state.verification?.files.get(file.index);
  if (verified) {
    if (verified.status === 'complete') return badge('verified', 'ok');
    if (verified.status === 'missing') return badge('not attached');
    if (verified.status === 'partial') {
      return badge(`${verified.ok}/${verified.total} pieces`, 'warn');
    }
    return badge(verified.sharedFailureOnly ? 'boundary mismatch' : 'corrupt', 'bad');
  }
  if (state.sources.has(file.index)) return badge('attached', 'accent');
  if (state.match) return badge('missing', 'warn');
  return badge('—');
}

function renderFiles() {
  const t = state.torrent;
  if (!t || t.fromMagnet) return;

  const audioOnly = $('audio-only').checked;
  const visible = t.files.filter((file) => !file.isPad && (!audioOnly || file.isAudio));

  const tbody = $('file-rows');
  tbody.replaceChildren();

  for (const file of visible) {
    const tr = document.createElement('tr');
    if (file.isAudio) tr.classList.add('is-audio');

    const path = document.createElement('td');
    path.className = 'path';
    path.textContent = file.path;
    if (file.isAudio && !file.isBrowserDecodable) {
      path.append(' ', badge(file.extension || 'unknown', 'warn'));
      path.title = 'Most browsers cannot decode this format; it can still be listed and verified.';
    }

    const size = document.createElement('td');
    size.className = 'numeric';
    size.textContent = formatBytes(file.length);

    const pieces = document.createElement('td');
    pieces.className = 'numeric';
    pieces.textContent =
      file.firstPiece === undefined ? '—' : `${file.firstPiece}–${file.lastPiece}`;

    const status = document.createElement('td');
    status.append(fileStatusBadge(file));

    tr.append(path, size, pieces, status);
    tbody.append(tr);
  }

  const audioBytes = t.audioFiles.reduce((total, file) => total + file.length, 0);
  $('file-summary').textContent =
    `${visible.length} shown · ${t.audioFiles.length} audio (${formatBytes(audioBytes)})`;
}

// --------------------------------------------------------- attach + verify

function collectLocalFiles(fileList) {
  return [...fileList].map((file) => ({
    file,
    path: (file.webkitRelativePath || file.name).replace(/\\/g, '/'),
    name: file.name,
    size: file.size,
  }));
}

function attachLocalFiles(fileList) {
  const t = state.torrent;
  if (!t) return;

  state.localFiles = collectLocalFiles(fileList);
  state.verification = null;
  state.match = matchFiles(t.files, state.localFiles);

  state.sources = new Map();
  for (const [torrentIndex, entry] of state.match.matches) {
    state.sources.set(torrentIndex, state.localFiles[entry.localIndex].file);
  }

  const summary = summariseMatches(t.files, state.match);
  const mismatches = [...state.match.matches.values()].filter((m) => m.sizeMismatch).length;

  const parts = [
    `Matched ${summary.matched} of ${summary.total} files (${formatBytes(summary.matchedBytes)} of ${formatBytes(summary.totalBytes)}).`,
  ];
  if (summary.missing) parts.push(`${summary.missing} not found.`);
  if (mismatches) parts.push(`${mismatches} matched by name but the size differs.`);
  if (state.match.ambiguous.length) parts.push(`${state.match.ambiguous.length} ambiguous.`);

  const el = $('match-summary');
  el.textContent = parts.join(' ');
  el.hidden = false;

  $('verify-row').hidden = !t.hasPieceHashes || summary.matched === 0;
  $('verify-progress').hidden = true;

  renderFiles();
  rebuildQueue();
  toast(`${summary.matched} file${summary.matched === 1 ? '' : 's'} attached`);
}

async function runVerification() {
  const t = state.torrent;
  if (!t?.hasPieceHashes) return;

  const controller = new AbortController();
  state.verifyController = controller;
  $('verify-button').disabled = true;
  $('verify-cancel').hidden = false;
  $('verify-progress').hidden = false;

  const fill = $('verify-fill');
  const status = $('verify-status');
  fill.style.width = '0%';
  status.textContent = 'Hashing…';

  try {
    const result = await verifyTorrent(t, state.sources, {
      signal: controller.signal,
      onProgress: ({ piece, pieceCount, ok, bad, missing }) => {
        fill.style.width = `${(piece / pieceCount) * 100}%`;
        status.textContent =
          `Piece ${piece} of ${pieceCount} — ${ok} ok, ${bad} failed, ${missing} unavailable`;
      },
    });
    state.verification = result;

    const checked = result.ok + result.bad;
    const summary = [
      `${result.ok} of ${checked || 0} checked pieces match (${formatBytes(result.verifiedBytes)} verified).`,
    ];
    if (result.bad) summary.push(`${result.bad} failed.`);
    if (result.missing) summary.push(`${result.missing} could not be checked — files not attached.`);
    status.textContent = summary.join(' ');

    renderFiles();
    rebuildQueue();
    toast(result.bad === 0 ? 'All checked pieces match the torrent' : `${result.bad} pieces failed`);
  } catch (error) {
    if (error.name === 'AbortError') {
      status.textContent = 'Verification cancelled.';
    } else {
      status.textContent = `Verification failed: ${error.message}`;
    }
  } finally {
    state.verifyController = null;
    $('verify-button').disabled = false;
    $('verify-cancel').hidden = true;
  }
}

// ------------------------------------------------------------------ queue

function rebuildQueue() {
  const t = state.torrent;
  if (!t) return;

  state.queue = t.audioFiles
    .filter((file) => state.sources.has(file.index))
    .sort((a, b) => compareNatural(a.path, b.path));

  $('panel-player').hidden = state.queue.length === 0;
  renderPlaylist();

  if (state.queue.length && state.currentIndex === -1) {
    void selectTrack(0, false);
  }
}

function renderPlaylist() {
  const list = $('playlist');
  list.replaceChildren();

  state.queue.forEach((file, index) => {
    const li = document.createElement('li');
    li.setAttribute('aria-current', String(index === state.currentIndex));

    const number = document.createElement('span');
    number.className = 'track-index';
    number.textContent = String(index + 1);

    const name = document.createElement('span');
    name.className = 'track-name';
    name.textContent = file.name;
    name.title = file.path;

    const size = document.createElement('span');
    size.className = 'track-size';
    size.textContent = formatBytes(file.length);

    li.append(number, name, size);

    const verified = state.verification?.files.get(file.index);
    if (verified?.status === 'complete') li.append(badge('✓', 'ok'));
    else if (verified && verified.status !== 'missing') li.append(badge('!', 'bad'));
    if (!file.isBrowserDecodable) li.append(badge('may not decode', 'warn'));

    li.addEventListener('click', () => void selectTrack(index, true));
    list.append(li);
  });
}

async function selectTrack(index, autoplay) {
  const file = state.queue[index];
  if (!file) return;
  const source = state.sources.get(file.index);
  if (!source) return;

  state.currentIndex = index;
  await player.loadFile(source, { name: file.name, path: file.path });

  $('track-title').textContent = file.name;
  $('track-sub').textContent = `${file.path} · ${formatBytes(file.length)}`;
  renderPlaylist();
  updateDecodeNote();

  if (autoplay) await player.play();
}

// ----------------------------------------------------------------- player

function renderTransport() {
  $('play-toggle').textContent = player.playing ? 'Pause' : 'Play';
  $('play-toggle').setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
}

function renderTime() {
  const duration = player.duration || 0;
  const current = player.currentTime || 0;
  $('time-current').textContent = formatTime(current);
  $('time-total').textContent = formatTime(duration);
  if (!state.seeking) {
    $('seek').value = String(duration > 0 ? Math.round((current / duration) * 1000) : 0);
  }
}

function renderEngine() {
  const el = $('engine-badge');
  el.textContent = player.engine === 'native' ? 'native' : 'time-stretch';
  el.className = player.engine === 'native' ? 'badge' : 'badge accent';
  el.title = player.engineReason();
}

function renderRate() {
  $('rate-value').textContent = formatRate(player.rate);
  $('rate').value = String(player.rate);
  for (const button of $('rate-presets').children) {
    button.setAttribute('aria-pressed', String(Math.abs(Number(button.dataset.rate) - player.rate) < 1e-6));
  }
  renderEngine();
}

function renderPitch() {
  const value = player.pitch;
  $('pitch-value').textContent = value === 0 ? 'original' : `${formatSemitones(value)} semitones`;
  $('pitch').value = String(value);
  renderEngine();
}

function updateDecodeNote() {
  const bytes = player.estimateDecodedBytes();
  if (!bytes) {
    $('decode-note').textContent = '';
    return;
  }
  $('decode-note').textContent =
    `Time-stretching decodes the whole track into memory — roughly ${formatBytes(bytes)} for this one.`;
}

function buildPresets() {
  const wrap = $('rate-presets');
  wrap.replaceChildren();
  for (const rate of RATE_PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = rate === 10 ? 'preset top' : 'preset';
    button.dataset.rate = String(rate);
    button.textContent = formatRate(rate);
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => void player.setRate(rate));
    wrap.append(button);
  }
}

// ------------------------------------------------------------------ events

function wireLoading() {
  const dropzone = $('dropzone');
  const input = $('torrent-input');

  dropzone.addEventListener('click', () => input.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    if (input.files?.[0]) void loadTorrentFile(input.files[0]);
    input.value = '';
  });

  for (const type of ['dragenter', 'dragover']) {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('dragging');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    dropzone.addEventListener(type, () => dropzone.classList.remove('dragging'));
  }
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) void loadTorrentFile(file);
  });

  $('magnet-button').addEventListener('click', () => {
    const value = $('magnet-input').value.trim();
    if (value) loadMagnet(value);
  });
  $('magnet-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('magnet-button').click();
  });

  $('copy-magnet').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(state.torrent?.magnetURI ?? '');
      toast('Magnet link copied');
    } catch {
      toast('Could not access the clipboard');
    }
  });

  $('audio-only').addEventListener('change', renderFiles);
}

function wireAttach() {
  $('pick-folder').addEventListener('click', () => $('folder-input').click());
  $('pick-files').addEventListener('click', () => $('files-input').click());

  for (const id of ['folder-input', 'files-input']) {
    $(id).addEventListener('change', (event) => {
      const files = event.target.files;
      if (files?.length) attachLocalFiles(files);
      event.target.value = '';
    });
  }

  $('verify-button').addEventListener('click', () => void runVerification());
  $('verify-cancel').addEventListener('click', () => state.verifyController?.abort());
}

function wirePlayer() {
  $('play-toggle').addEventListener('click', () => void player.toggle());
  $('skip-back').addEventListener('click', () => player.skip(-10));
  $('skip-forward').addEventListener('click', () => player.skip(10));

  const seek = $('seek');
  seek.addEventListener('input', () => {
    state.seeking = true;
    const duration = player.duration || 0;
    $('time-current').textContent = formatTime((Number(seek.value) / 1000) * duration);
  });
  seek.addEventListener('change', () => {
    player.seek((Number(seek.value) / 1000) * (player.duration || 0));
    state.seeking = false;
  });

  $('volume').addEventListener('input', (event) => player.setVolume(Number(event.target.value)));
  $('rate').addEventListener('input', (event) => void player.setRate(Number(event.target.value)));
  $('pitch').addEventListener('input', (event) => void player.setPitch(Number(event.target.value)));
  $('engine-mode').addEventListener('change', (event) => void player.setMode(event.target.value));
  $('frame-size').addEventListener('input', (event) => {
    const value = Number(event.target.value);
    $('frame-value').textContent = String(value);
    void player.setFrameSize(value);
  });

  player.addEventListener('time', renderTime);
  player.addEventListener('state', renderTransport);
  player.addEventListener('params', () => {
    renderRate();
    renderPitch();
  });
  player.addEventListener('engine', renderEngine);
  player.addEventListener('load', () => {
    renderTime();
    updateDecodeNote();
  });
  player.addEventListener('decoding', (event) => {
    if (event.detail.active) toast('Decoding for time-stretching…');
  });
  player.addEventListener('error', (event) => toast(event.detail.message));
  player.addEventListener('ended', () => {
    if (state.currentIndex + 1 < state.queue.length) void selectTrack(state.currentIndex + 1, true);
    else renderTransport();
  });
}

function wireKeyboard() {
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing =
      target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    if ($('panel-player').hidden) return;

    switch (event.key) {
      case ' ':
      case 'k':
        event.preventDefault();
        void player.toggle();
        break;
      case 'j':
        player.skip(-10);
        break;
      case 'l':
        player.skip(10);
        break;
      case 'ArrowLeft':
        player.skip(-5);
        break;
      case 'ArrowRight':
        player.skip(5);
        break;
      case '[':
        void player.setRate(Math.max(MIN_RATE, player.rate - 0.25));
        break;
      case ']':
        void player.setRate(Math.min(MAX_RATE, player.rate + 0.25));
        break;
      case '0':
        void player.setRate(1);
        break;
      default:
        break;
    }
  });
}

// -------------------------------------------------------------------- boot

buildPresets();
wireLoading();
wireAttach();
wirePlayer();
wireKeyboard();
renderRate();
renderPitch();
renderTransport();
renderTime();

if (player.nativeMaxRate < 4) {
  // Worth surfacing: it changes where the automatic engine switch happens.
  $('decode-note').textContent =
    `This browser only honours playbackRate up to ${player.nativeMaxRate}x, so time-stretching takes over above that.`;
}
