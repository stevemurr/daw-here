// track.js — <daw-track> custom element
// Encapsulates one track row: controls column + waveform lane + FX panel.

import { PALETTE, baseStyle, btnStyles, rangeStyles } from './config.js';

/**
 * <daw-track> — Per-track Web Component.
 * Manages local state (mute/solo/volume/pan), waveform rendering, and relays
 * events to the parent <daw-player> for mixer-level actions.
 */
class DawTrack extends HTMLElement {
  constructor() {
    super();
    this._shadow = this.attachShadow({ mode: 'open' });
    this._mixer = null;
    this._listeners = new Set();
    // Per-track state (mirrors mixer.tracks[idx])
    this.muted = false;
    this.solo = false;
    this.volumeDb = 0;
    this.panVal = 0;
    this.fxFxOpen = false;
    this.errorText = null;
  }

  init(mixer) {
    this._mixer = mixer;
    // Subscribe to cross-track events; dispatch upward for parent player
    mixer.on((kind, t) => this._onMixerEvent(kind, t));
    return this;
  }

  _onMixerEvent(kind, trackObj) {
    switch (kind) {
      case 'transport':
        this.renderPlayhead(0);
        break;
      case 'loaded':
      case 'error':
        this.syncFromMixer(trackObj);
        if (trackObj.error) this._dom.row.classList.add('error');
        break;
      case 'solo-changed':
        // null means "clear all solos" — sync from own track object
        this.syncFromMixer(trackObj || this._mixer.tracks[this.idx]);
        break;
      case 'progress':
        this.renderPlayhead(this._mixer.position() / (this._mixer.duration || 1));
        break;
    }
  }

  _getStyle() {
    const base = baseStyle([
      '--bg', '--surface', '--surface-2', '--surface-3',
      '--border', '--border-2', '--text', '--muted',
      '--accent', '--solo', '--mute', '--wave-bg', '--playhead',
    ]);
    return `${base}${btnStyles}${rangeStyles}
      /* Track wrapper */
      .track {
        display: flex;
        flex-direction: column;
        border-bottom: 1px solid var(--border);
        transition: opacity 120ms;
      }
      .track.dimmed { opacity: 0.45; }
      .track.error { opacity: 0.6; }

      /* Main row (controls + waveform) */
      .track-main {
        display: grid;
        grid-template-columns: 280px 1fr;
        gap: 0;
        height: 64px;
      }

      /* Controls column */
      .track-controls {
        display: flex;
        flex-direction: column;
        justify-content: center;
        padding: 8px 12px;
        border-right: 1px solid var(--border);
        background: var(--surface);
        gap: 4px;
        overflow: hidden;
      }
      .track-name {
        font-size: 12px;
        color: var(--text);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .track-row {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      /* Mute / Solo / FX buttons — overrides base button */
      .btn-ms {
        width: 22px;
        height: 22px;
        border-radius: 4px;
        background: var(--surface-2);
        color: var(--muted);
        font-size: 11px;
        font-weight: 600;
        transition: background 120ms, color 120ms, border-color 120ms;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .btn-ms:hover {
        background: var(--surface-3);
        color: var(--text);
      }
      .btn-ms.mute.on {
        background: var(--mute);
        color: #0d1117;
        border-color: var(--mute);
      }
      .btn-ms.solo.on {
        background: var(--solo);
        color: #0d1117;
        border-color: var(--solo);
      }
      .btn-ms.fx {
        font-size: 10px;
        letter-spacing: 0.04em;
      }
      .btn-ms.fx.on {
        background: var(--accent);
        color: #0d1117;
        border-color: var(--accent);
      }

      /* Volume slider — overrides base range */
      input.vol {
        --fill-pct: 90.9%;
        flex: 1 1 0;
        min-width: 0;
        height: 10px;
        background: linear-gradient(90deg,
          var(--playhead) 0%, var(--playhead) var(--fill-pct),
          var(--border) var(--fill-pct), var(--border) 100%);
        border-radius: 2px;
        outline: none;
      }
      input.vol::-webkit-slider-thumb {
        width: 4px;
        height: 20px;
        border-radius: 1px;
        background: var(--text);
      }
      input.vol::-moz-range-thumb {
        width: 4px;
        height: 20px;
        border-radius: 1px;
        background: var(--text);
      }
      .vol-readout {
        font-family: ui-monospace, monospace;
        color: var(--muted);
        font-size: 10px;
        min-width: 12px;
        text-align: right;
      }

      /* Pan slider — overrides base range */
      input.pan {
        flex: none;
        width: 60px;
        height: 10px;
        background: linear-gradient(90deg,
          var(--solo) 0%, var(--solo) 50%,
          var(--accent) 50%, var(--accent) 100%);
        border-radius: 2px;
        outline: none;
      }
      input.pan::-webkit-slider-thumb {
        width: 4px;
        height: 20px;
        border-radius: 1px;
        background: var(--text);
      }
      input.pan::-moz-range-thumb {
        width: 4px;
        height: 20px;
        border-radius: 1px;
        background: var(--text);
      }

      /* Waveform lane */
      .waveform {
        position: relative;
        background: var(--wave-bg);
        cursor: pointer;
        overflow: hidden;
      }
      .waveform canvas {
        display: block;
        width: 100%;
        height: 100%;
      }
      .waveform .lane-head {
        position: absolute;
        top: 0; bottom: 0;
        width: 1px;
        background: var(--playhead);
        pointer-events: none;
        left: 0;
        box-shadow: 0 0 6px rgba(240, 136, 62, 0.6);
      }
      .waveform .progress {
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--muted);
        font-family: ui-monospace, monospace;
        font-size: 11px;
        pointer-events: none;
      }
      .waveform .progress-bar {
        position: absolute;
        left: 0; bottom: 0;
        height: 2px;
        background: var(--accent);
        width: 0;
        transition: width 80ms linear;
      }
      .waveform.error .progress { color: var(--mute); }
    `;
  }

  connectedCallback() {
    const idx = parseInt(this.getAttribute('data-idx')) || 0;
    const name = this.getAttribute('data-name') || '';
    const url = this.getAttribute('data-url') || '';

    this.idx = idx;
    this.trackName = name;
    this.trackUrl = url;

    // Build shadow DOM
    this._buildDOM(idx, name);

    // Inject CSS into shadow DOM
    const styleEl = document.createElement('style');
    styleEl.textContent = this._getStyle();
    this._shadow.appendChild(styleEl);

    // Wire up local event listeners (these dispatch upward via custom events)
    this._wireControls();

    // Request initial state from mixer
    if (this._mixer && this._mixer.tracks[idx]) {
      this.syncFromMixer(this._mixer.tracks[idx]);
    }
  }

  _buildDOM(idx, name) {
    // Mute button
    const muteBtn = document.createElement('button');
    muteBtn.className = 'btn-ms mute';
    muteBtn.title = 'Mute';
    muteBtn.textContent = 'M';

    // Solo button
    const soloBtn = document.createElement('button');
    soloBtn.className = 'btn-ms solo';
    soloBtn.title = 'Solo';
    soloBtn.textContent = 'S';

    // FX button
    const fxBtn = document.createElement('button');
    fxBtn.className = 'btn-ms fx';
    fxBtn.title = 'Show/hide channel strip';
    fxBtn.textContent = 'FX';

    // Pan slider
    const panSlider = document.createElement('input');
    panSlider.className = 'pan';
    panSlider.type = 'range';
    panSlider.min = '-100';
    panSlider.max = '100';
    panSlider.value = '0';
    panSlider.step = '1';
    panSlider.title = 'Pan: C (double-click to center)';

    // Volume slider + readout
    const volSlider = document.createElement('input');
    volSlider.className = 'vol';
    volSlider.type = 'range';
    volSlider.min = '-60';
    volSlider.max = '6';
    volSlider.value = '0';
    volSlider.step = '0.1';
    const volReadout = document.createElement('span');
    volReadout.className = 'vol-readout';
    volReadout.textContent = '0.0';

    // Track name
    const nameEl = document.createElement('div');
    nameEl.className = 'track-name';
    nameEl.title = name;
    nameEl.textContent = (idx + 1) + '. ' + name;

    // Controls container
    const controlsRow = document.createElement('div');
    controlsRow.className = 'track-row';
    controlsRow.append(muteBtn, soloBtn, fxBtn, panSlider, volSlider, volReadout);

    const controlsCol = document.createElement('div');
    controlsCol.className = 'track-controls';
    controlsCol.append(nameEl, controlsRow);

    // Waveform lane
    const canvas = document.createElement('canvas');
    const head = document.createElement('div');
    head.className = 'lane-head';
    const progBar = document.createElement('div');
    progBar.className = 'progress-bar';
    const progLabel = document.createElement('div');
    progLabel.className = 'progress';
    progLabel.textContent = 'queued';
    const waveDiv = document.createElement('div');
    waveDiv.className = 'waveform';
    waveDiv.append(canvas, head, progBar, progLabel);

    const mainDiv = document.createElement('div');
    mainDiv.className = 'track-main';
    mainDiv.append(controlsCol, waveDiv);

    // FX panel — delegated to <daw-fx-strip>
    const fxStrip = document.createElement('daw-fx-strip');
    fxStrip.setAttribute('data-idx', String(this.idx));
    fxStrip.setAttribute('data-name', this.trackName || '');
    // Initialize fx-strip with mixer and idx so it can build its DOM
    fxStrip.init(this._mixer, this.idx);

    // Row div
    const rowDiv = document.createElement('div');
    rowDiv.className = 'track';
    rowDiv.append(mainDiv, fxStrip);

    this._shadow.appendChild(rowDiv);

    // Store references
    this._dom = {
      row: rowDiv,
      muteBtn, soloBtn, fxBtn,
      panSlider, volSlider, volReadout,
      canvas, head, progBar, progLabel, waveDiv,
      mainDiv, fxPanel: fxStrip,
    };
  }

  // Handle FX changes dispatched from <daw-fx-strip>
  _applyFx(section, paramKey, value) {
    if (!this._mixer) return;
    this._mixer.setFxParam(this.idx, paramKey, value);
  }

  _wireControls() {
    const d = this._dom;

    // Mute toggle
    d.muteBtn.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('track-mute-toggle', {
        detail: { idx: this.idx },
        bubbles: true,
        composed: true,
      }));
    });

    // Solo toggle
    d.soloBtn.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('track-solo-toggle', {
        detail: { idx: this.idx },
        bubbles: true,
        composed: true,
      }));
    });

    // FX panel toggle — FIX: toggle 'open' class on the fx-strip host element
    // so that :host(.open) .fx-strip { display: flex; } in fx-strip.css works
    d.fxBtn.addEventListener('click', () => {
      this.fxFxOpen = !this.fxFxOpen;
      d.fxPanel.classList.toggle('open', this.fxFxOpen);
      d.row.classList.toggle('fx-open', this.fxFxOpen);
      d.fxBtn.classList.toggle('on', this.fxFxOpen);
    });

    // Listen for FX changes from <daw-fx-strip>
    d.fxPanel.addEventListener('fx-param-change', e => {
      const { section, param, value } = e.detail;
      this._applyFx(section, param, value);
    });
    d.fxPanel.addEventListener('fx-reverb-type', e => {
      this._applyFx('Reverb', 'reverbType', e.detail.type);
    });

    // Pan slider
    this._bindSlider(d.panSlider, {
      event: 'track-pan-change',
      key: 'pan',
      parse: v => parseInt(v, 10) / 100,
      updateReadout: (slider, v) => {
        const lbl = v === 0 ? 'C' : (v < 0 ? 'L' + (-v * 100) : 'R' + (v * 100));
        slider.title = 'Pan: ' + lbl;
      },
      resetValue: '0',
    });

    // Volume slider
    this._bindSlider(d.volSlider, {
      event: 'track-volume-change',
      key: 'db',
      parse: v => parseFloat(v),
      updateReadout: (slider, v) => {
        d.volReadout.textContent = (v > 0 ? '+' : '') + v.toFixed(1);
        this._updateVolFill();
      },
      resetValue: '0',
      resetReadout: () => { d.volReadout.textContent = '0.0'; },
    });

    // Seekbar click on waveform
    d.waveDiv.addEventListener('click', e => {
      const rect = d.waveDiv.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      this.dispatchEvent(new CustomEvent('track-seek', {
        detail: { pct },
        bubbles: true,
        composed: true,
      }));
    });
  }

  /**
   * Bind input + dblclick handlers to a range slider.
   * @param {HTMLInputElement} slider
   * @param {object} cfg
   * @param {string} cfg.event - Custom event name to dispatch
   * @param {string} cfg.key - Detail key name (e.g. 'pan', 'db')
   * @param {function} cfg.parse - Convert slider value to event detail value
   * @param {function} cfg.updateReadout - (slider, value) => void
   * @param {string} cfg.resetValue - Slider value on double-click
   * @param {function?} cfg.resetReadout - Extra cleanup on double-click
   */
  _bindSlider(slider, cfg) {
    slider.addEventListener('input', () => {
      const raw = slider.value;
      const val = cfg.parse(raw);
      cfg.updateReadout(slider, val);
      this.dispatchEvent(new CustomEvent(cfg.event, {
        detail: { idx: this.idx, [cfg.key]: val },
        bubbles: true,
        composed: true,
      }));
    });
    slider.addEventListener('dblclick', () => {
      slider.value = cfg.resetValue;
      if (cfg.resetReadout) cfg.resetReadout();
      this.dispatchEvent(new CustomEvent(cfg.event, {
        detail: { idx: this.idx, [cfg.key]: cfg.parse(cfg.resetValue) },
        bubbles: true,
        composed: true,
      }));
    });
  }

  syncFromMixer(trackObj) {
    if (!trackObj) return;
    const d = this._dom;
    if (d) {
      const mute = trackObj.mute;
      const solo = trackObj.solo;
      const db = trackObj.volume;
      const pan = trackObj.pan;

      this.muted = mute;
      this.solo = solo;
      this.volumeDb = db;
      this.panVal = pan;

      d.muteBtn.classList.toggle('on', mute);
      d.soloBtn.classList.toggle('on', solo);
      d.volSlider.value = db;
      d.volReadout.textContent = (db > 0 ? '+' : '') + db.toFixed(1);
      this._updateVolFill();
      d.panSlider.value = pan * 100;
      d.panSlider.title = 'Pan: ' + (pan === 0 ? 'C' : (pan < 0 ? 'L' + (-pan * 100) : 'R' + (pan * 100)));
    }
  }

  renderPlayhead(pct) {
    if (!this._dom?.head) return;
    this._dom.head.style.left = (pct * 100) + '%';
  }

  rerenderWaveforms() {
    if (!this._dom?.canvas) return;
    if (this._mixer && this._mixer.tracks[this.idx] && this._mixer.tracks[this.idx].buffer) {
      const rf = (typeof window !== 'undefined' && window.renderWaveform);
      if (rf) rf(this._dom.canvas, this._mixer.tracks[this.idx].buffer, this._mixer.duration);
    }
  }

  updateProgress(pct) {
    if (!this._dom?.progBar) return;
    this._dom.progBar.style.width = (pct * 100) + '%';
  }

  setError(text) {
    this.errorText = text;
    if (this._dom?.waveDiv) {
      this._dom.waveDiv.classList.add('error');
      if (this._dom?.progLabel) this._dom.progLabel.textContent = text || 'error';
    }
  }

  setDim(dim) {
    this._dom.row.classList.toggle('dimmed', dim);
  }

  setLoaded(isLoaded) {
    if (isLoaded) {
      this._dom.progLabel.textContent = '';
      this._dom.progBar.style.width = '0';
      this.rerenderWaveforms();
    }
  }

  setStatus(okCount, errCount, totalDuration) {
    // This is actually handled by player, but we could show per-track status
  }

  _updateVolFill() {
    const db = parseFloat(this._dom?.volSlider?.value || 0);
    if (this._dom?.volSlider) {
      const pct = Math.max(0, Math.min(100, ((db + 60) / 66 * 100)));
      this._dom.volSlider.style.setProperty('--fill-pct', pct.toFixed(2) + '%');
    }
  }
}

customElements.define('daw-track', DawTrack);

// Also export renderWaveform for use elsewhere
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DawTrack };
}