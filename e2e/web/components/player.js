// player.js — <daw-player> custom element
// Root component: transport, seekbar, master volume, track container.

import { PALETTE, baseStyle, btnStyles, rangeStyles, fmtTime } from './config.js';

/**
 * <daw-player> — Root Web Component for the DAW session view.
 * Manages transport controls, rAF tick loop, mixer lifecycle, and child <daw-track> elements.
 */
class DawPlayer extends HTMLElement {
  constructor() {
    super();
    this._shadow = this.attachShadow({ mode: 'open' });
    this._mixer = null;
    this._rafId = null;
    this._resizeT = null;
    this._lastRenderedDuration = 0;
    // Deferred waveform render queue
    this._waveformQ = new Set();
    this._waveformTimer = null;
    // Fast track lookup: idx → daw-track element (replaces O(n) querySelectorAll)
    this._trackMap = new Map();
  }

  connectedCallback() {
    this._buildDOM();
    this._wireUI();
    this._startTick();
    // Boot: fetch session data and create tracks
    this.boot();
  }

  _buildDOM() {
    // Build shadow DOM via template string (avoids wasted createElement → overwrite cycle)
    this._shadow.innerHTML = `
      <style>${this._getStyle()}</style>
      <div class="layout">
        <header>
          <a class="title" href="/">${document.title.replace(' · Audition', '')}</a>
          <div class="time-wrap">
            <span id="t-now" class="time" aria-live="polite">0:00.000</span>
            <span> / </span>
            <span id="t-total" class="time total">0:00.000</span>
          </div>
          <div class="btns">
            <button id="btn-play" class="btn-ms" disabled aria-label="Play/Pause">\u25B6</button>
            <button id="btn-stop" class="btn-ms" disabled aria-label="Stop">\u25A0</button>
            <button id="btn-soloclear" class="btn-ms" disabled aria-label="Clear solo">Clear solo</button>
          </div>
        </header>
        <div id="seekbar" class="seekbar" role="slider" aria-label="Playback position" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0">
          <div id="seek-fill" class="fill"></div>
          <div id="seek-head" class="head"></div>
        </div>
        <div id="status" class="status" role="status">booting...</div>
        <div class="master-vol-wrap">
          <label for="master-vol">Master volume</label>
          <input id="master-vol" type="range" min="-60" max="6" value="0" step="0.1" role="slider" aria-label="Master volume" aria-valuemin="-60" aria-valuemax="6" aria-valuenow="0" aria-valuetext="0.0 dB">
          <span id="master-vol-val" class="val">0.0 dB</span>
        </div>
        <div id="tracks" class="tracks-container"></div>
      </div>
    `;

    // Cache DOM refs from shadow root
    this._dom = {
      btnPlay: this._shadow.querySelector('#btn-play'),
      btnStop: this._shadow.querySelector('#btn-stop'),
      btnSoloClear: this._shadow.querySelector('#btn-soloclear'),
      tNow: this._shadow.querySelector('#t-now'),
      tTotal: this._shadow.querySelector('#t-total'),
      seekbar: this._shadow.querySelector('#seekbar'),
      seekFill: this._shadow.querySelector('#seek-fill'),
      seekHead: this._shadow.querySelector('#seek-head'),
      status: this._shadow.querySelector('#status'),
      masterVol: this._shadow.querySelector('#master-vol'),
      masterVolVal: this._shadow.querySelector('#master-vol-val'),
      tracksContainer: this._shadow.querySelector('#tracks'),
    };
  }

  _getStyle() {
    const base = baseStyle([
      '--bg', '--surface', '--surface-2', '--surface-3',
      '--border', '--border-2', '--text', '--muted',
      '--accent', '--solo', '--mute', '--playhead', '--wave', '--wave-bg',
    ]);
    return `${base}${btnStyles}${rangeStyles}
      .layout { height: 100%; display: flex; flex-direction: column; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; font-size: 13px; overflow: hidden; }
      header { flex: 0 0 auto; padding: 12px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 14px; }
      .title { color: var(--muted); text-decoration: none; font-size: 16px; font-weight: 600; white-space: nowrap; }
      .time-wrap { margin-left: auto; font-family: ui-monospace, monospace; font-size: 15px; color: var(--accent); letter-spacing: 0.05em; }
      .time.total { color: var(--muted); font-size: 14px; }
      .btns { display: flex; gap: 6px; align-items: center; }
      button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
      button.playing { background: rgba(88,166,255,0.15); border-color: var(--accent); color: var(--accent); }
      .seekbar { height: 36px; flex-shrink: 0; position: relative; background: var(--surface); cursor: pointer; }
      .seekbar .fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: var(--playhead); }
      .seekbar .head { position: absolute; left: 0; top: -3px; bottom: -3px; width: 3px; background: var(--playhead); }
      .status { padding: 6px 20px; font-size: 12px; font-family: ui-monospace, monospace; color: var(--muted); border-top: 1px solid var(--border); background: var(--surface); }
      .status.warn { color: var(--solo); }
      .status.err { color: var(--mute); }
      .master-vol-wrap { display: flex; align-items: center; gap: 8px; padding: 0 20px; height: 36px; flex-shrink: 0; background: var(--surface); border-top: 1px solid var(--border); }
      .master-vol-wrap label { font-size: 12px; color: var(--muted); white-space: nowrap; }
      .master-vol-wrap input[type="range"] { width: 80px; }
      .master-vol-wrap .val { font-size: 12px; font-family: ui-monospace, monospace; min-width: 50px; }
      .tracks-container { flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; }
    `;
  }

  _wireUI() {
    const d = this._dom;

    // Play/Pause toggle
    d.btnPlay.addEventListener('click', () => {
      if (!this._mixer) return;
      this._mixer.isPlaying ? this._mixer.pause() : this._mixer.play();
    });

    // Stop
    d.btnStop.addEventListener('click', () => {
      if (!this._mixer) return;
      this._mixer.stop();
      this.refreshTransport();
    });

    // Solo clear
    d.btnSoloClear.addEventListener('click', () => {
      if (!this._mixer) return;
      this._mixer.clearSolos();
      // Clear solo state on all daw-track children
      this._shadow.querySelectorAll('daw-track').forEach(tr => {
        tr.setAttribute('data-solo-active', 'false');
      });
      this.refreshDimming();
    });

    // Seekbar click
    d.seekbar.addEventListener('click', (e) => {
      const rect = d.seekbar.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      if (this._mixer && this._mixer.duration) {
        this._mixer.seek(x * this._mixer.duration);
      }
    });

    // Master volume
    d.masterVol.addEventListener('input', () => {
      const db = parseFloat(d.masterVol.value);
      d.masterVolVal.textContent = (db >= 0 ? '+' : '') + db.toFixed(1) + ' dB';
      d.masterVol.setAttribute('aria-valuenow', String(db));
      if (this._mixer) {
        this._mixer.setMasterDb(db);
      }
    });

    // Global keyboard shortcuts (handled by browser, bubbled to us)
    window.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (!d.btnPlay.disabled && this._mixer) {
          this._mixer.isPlaying ? this._mixer.pause() : this._mixer.play();
        }
      } else if (e.code === 'Home' || e.code === 'Digit0' || e.code === 'Numpad0') {
        if (!d.btnStop.disabled && this._mixer) {
          this._mixer.stop();
          this.refreshTransport();
        }
      }
    });

    // Resize handler for waveforms
    window.addEventListener('resize', () => {
      if (this._resizeT) clearTimeout(this._resizeT);
      this._resizeT = setTimeout(() => {
        this.rerenderWaveforms();
      }, 120);
    });

    // Intercept cross-component events (bubbling from <daw-track>)
    this.addEventListener('track-mute-toggle', e => this._onTrackMuteToggle(e.detail));
    this.addEventListener('track-solo-toggle', e => this._onTrackSoloToggle(e.detail));
    this.addEventListener('track-volume-change', e => this._onTrackVolumeChange(e.detail));
    this.addEventListener('track-pan-change', e => this._onTrackPanChange(e.detail));
  }

  // ---- Event handlers for track actions ----

  _onTrackMuteToggle({ idx }) {
    if (!this._mixer) return;
    const current = this._mixer.tracks[idx]?.muted ?? false;
    const newVal = !current;
    this._mixer.setMute(idx, newVal);
    // Update the track element's visual state
    this._updateTrackVisual(idx, 'mute', newVal);
    this.refreshDimming();
  }

  _onTrackSoloToggle({ idx }) {
    if (!this._mixer) return;
    const current = this._mixer.tracks[idx]?.solo ?? false;
    const newVal = !current;
    this._mixer.setSolo(idx, newVal);
    this._updateTrackVisual(idx, 'solo', newVal);
    this.refreshDimming();
    this.refreshSoloClear();
  }

  _onTrackVolumeChange({ idx, db }) {
    if (!this._mixer) return;
    this._mixer.setVolume(idx, dbToGain(db));
  }

  _onTrackPanChange({ idx, pan }) {
    if (!this._mixer) return;
    this._mixer.setPan(idx, pan);
  }

  _updateTrackVisual(idx, prop, value) {
    // Fast lookup via trackMap instead of querySelectorAll
    const el = this._trackMap.get(idx);
    if (!el) return;
    const btn = el.shadowRoot?.querySelector(`.${prop}`);
    if (btn) btn.classList.toggle('on', value);
  }

  // ---- Mixer event subscription ----

  onMixerEvent(kind, trackObj) {
    switch (kind) {
      case 'transport':
        this.refreshTransport();
        break;
      case 'loaded':
        // Defer waveform render — batches with other queued renders
        if (trackObj) {
          const ref = this._getTrackDomRef(trackObj.idx);
          if (ref) ref.setLoaded(true);
          this.queueDeferredWaveform(trackObj.idx);
        }
        // Full re-render only when session duration changes (longer track loaded)
        if (this._mixer && this._mixer.duration > this._lastRenderedDuration) {
          this.rerenderWaveforms();
        }
        this.refreshTransport();
        break;
      case 'progress':
        if (trackObj) this._updateTrackProgress(trackObj);
        break;
      case 'error':
        if (trackObj) this._updateTrackError(trackObj);
        break;
      case 'all-loaded': {
        const okCount = this._mixer ? this._mixer.tracks.filter(t => t.loaded).length : 0;
        const errCount = this._mixer ? this._mixer.tracks.filter(t => t.error).length : 0;
        const hasChanges = errCount > 0 ||
          (this._mixer && this._mixer.duration > this._lastRenderedDuration);
        if (hasChanges) {
          for (const ref of this._trackMap.values()) {
            this.queueDeferredWaveform(ref.idx);
          }
        }
        this.setStatus(
          `${okCount} loaded${errCount ? ' · ' + errCount + ' failed' : ''} · ${fmtTime(this._mixer?.duration || 0)}`,
          errCount ? 'warn' : ''
        );
        this.refreshTransport();
        break;
      }
      case 'solo-changed':
        this.refreshSoloClear();
        break;
    }
  }

  _updateTrackProgress(trackObj) {
    const domRef = this._getTrackDomRef(trackObj.idx);
    if (domRef) domRef.updateProgress(trackObj.loadProgress);
  }

  _updateTrackError(trackObj) {
    const domRef = this._getTrackDomRef(trackObj.idx);
    if (domRef) domRef.setError(trackObj.error);
  }

  _getTrackDomRef(idx) {
    return this._trackMap.get(idx) || null;
  }

  // ---- Transport & UI refresh ----

  /**
   * Refresh transport button states, play/pause text, and total time display.
   */
  refreshTransport() {
    const d = this._dom;
    if (!this._mixer) return;
    const canPlay = this._mixer.tracks.some(t => t.loaded);
    d.btnPlay.disabled = !canPlay;
    d.btnStop.disabled = !canPlay;
    d.btnPlay.textContent = this._mixer.isPlaying ? '\u25A0\u25A0' : '\u25B6';
    d.btnPlay.classList.toggle('playing', this._mixer.isPlaying);
    d.tTotal.textContent = fmtTime(this._mixer.duration);
  }

  refreshDimming() {
    if (!this._mixer) return;
    const anySolo = this._mixer.tracks.some(t => t.solo);
    for (const [idx, ref] of this._trackMap) {
      const t = this._mixer.tracks[idx];
      if (!t) continue;
      const dim = t.muted || (anySolo && !t.solo);
      ref.setDimmed(dim);
    }
  }

  refreshSoloClear() {
    if (!this._mixer) return;
    this._dom.btnSoloClear.disabled = !this._mixer.tracks.some(t => t.solo);
  }

  // ---- rAF tick loop ----

  _startTick() {
    const trackCache = [...this._trackMap.values()];

    const tick = () => {
      if (!this._mixer) {
        // Pre-boot: idle poll (once every ~60 frames max via simple counter)
        this._rafId = requestAnimationFrame(tick);
        return;
      }
      const pos = this._mixer.position();
      this._dom.tNow.textContent = fmtTime(pos);
      const frac = this._mixer.duration ? Math.min(pos / this._mixer.duration, 1) : 0;
      this._dom.seekFill.style.width = (frac * 100) + '%';
      this._dom.seekHead.style.left = (frac * 100) + '%';
      // Update aria-valuenow for screen readers
      this._dom.seekbar?.setAttribute('aria-valuenow', Math.round(frac * 100));

      // Update playhead on all tracks (pre-built cache, O(1) per track)
      for (const ref of trackCache) {
        ref.renderPlayhead(frac);
      }

      // Auto-stop at end
      if (this._mixer.isPlaying && pos >= this._mixer.duration && this._mixer.duration > 0) {
        this._mixer.stop();
        this.refreshTransport();
      }

      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  /**
   * Re-render waveform canvases for all tracks after session duration changes.
   */
  rerenderWaveforms() {
    for (const ref of this._trackMap.values()) {
      ref.rerenderWaveforms();
    }
    this._lastRenderedDuration = this._mixer?.duration || 0;
  }

  // ---- Deferred waveform render queue ----
  // Coalesces multiple queuedWaveform calls into a single rAF batch.
  // This prevents blocking the main thread when many tracks load rapidly.

  queueDeferredWaveform(idx) {
    this._waveformQ.add(idx);
    if (this._waveformTimer) clearTimeout(this._waveformTimer);
    // Start processing after a short debounce so rapid calls coalesce
    this._waveformTimer = setTimeout(() => this._processWaveformQueue(), 16);
  }

  _processWaveformQueue() {
    if (this._waveformQ.size === 0) return;
    const items = [...this._waveformQ];
    this._waveformQ.clear();

    let i = 0;
    const MAX_PER_BATCH = 3; // Render N tracks, then yield to browser paint
    const processNext = () => {
      const batchEnd = Math.min(i + MAX_PER_BATCH, items.length);
      while (i < batchEnd) {
        const ref = this._getTrackDomRef(items[i]);
        if (ref) ref.rerenderWaveforms();
        i++;
      }
      if (i < items.length) {
        // Yield to browser paint cycle, then continue with next batch
        requestAnimationFrame(processNext);
      }
    };
    // Kick off async processing (non-blocking, yields to paint)
    requestAnimationFrame(processNext);
    // Reset timer reference
    this._waveformTimer = null;
  }

  // ---- Boot ----

  async boot() {
    // Extract session name from page title (e.g. "my-session · Audition" → "my-session")
    const name = document.title.replace(/ · Audition$/, '');
    const resp = await fetch('/api/session/' + encodeURIComponent(name));
    if (!resp.ok) {
      this.setStatus('failed to load session', 'err');
      return;
    }
    const data = await resp.json();
    if (!data.tracks || data.tracks.length === 0) {
      this.setStatus('empty session', 'warn');
      return;
    }
    this.setStatus('loading ' + data.tracks.length + ' tracks...');

    // Initialize mixer
    this._mixer = new Mixer();

    // Subscribe to mixer events
    this._mixer.on((kind, t) => this.onMixerEvent(kind, t));

    // Create track elements and attach to shadow DOM
    const container = this._dom.tracksContainer;
    for (const meta of data.tracks) {
      const t = this._mixer.addTrack(meta);
      const dawTrack = document.createElement('daw-track');
      dawTrack.setAttribute('data-idx', String(t.idx));
      dawTrack.setAttribute('data-name', meta.name);
      dawTrack.setAttribute('data-url', meta.url);
      dawTrack.init(this._mixer);
      container.appendChild(dawTrack);
      this._trackMap.set(t.idx, dawTrack);
    }

    // Start loading audio
    await this._mixer.loadAll();
  }

  setStatus(msg, kind) {
    const d = this._dom.status;
    d.textContent = msg;
    d.className = 'status' + (kind ? ' ' + kind : '');
  }
}

customElements.define('daw-player', DawPlayer);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DawPlayer };
}
