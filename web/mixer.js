// mixer.js — Pure audio engine, no DOM dependencies.
// Exports a Mixer constructor; attachEvent is called externally by the UI layer.

// ---- Unit conversions ----
function dbToGain(db) { return Math.pow(10, db / 20); }
function gainToDb(g)  { return 20 * Math.log10(Math.max(g, 1e-6)); }

// ---- Impulse responses (procedurally generated reverb tails) ----
function makeIR(ctx, type) {
  const sr = ctx.sampleRate;
  let duration, decayPow, gated = false;
  if (type === 'hall') {
    duration = 2.8; decayPow = 1.4;
  } else if (type === 'nonlin') {
    duration = 1.0; decayPow = 0; gated = true;
  } else {
    duration = 0.65; decayPow = 1.8;
  }
  const len = Math.floor(sr * duration);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      let env;
      if (gated) {
        if (t < 0.78) env = 1 - t * 0.3;
        else if (t < 0.84) env = (1 - 0.78 * 0.3) * (1 - (t - 0.78) / 0.06);
        else env = 0;
      } else {
        env = Math.pow(1 - t, decayPow);
      }
      data[i] = (Math.random() * 2 - 1) * env;
    }
  }
  return buf;
}

// ---- Waveform rendering ----
function renderWaveform(canvas, buffer, sessionDuration) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW <= 0 || cssH <= 0) return;
  // Guard against zero-duration or empty buffers (silent files, decode failures)
  if (!buffer || buffer.duration <= 0 || buffer.length === 0) return;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const w = cssW;
  const h = cssH;
  const mid = h / 2;

  // Each track's waveform spans only the fraction of the canvas matching its
  // duration relative to the longest track in the session. This keeps the
  // playhead (which is positioned by session-time fraction) visually aligned
  // with the audio underneath, regardless of track-length differences.
  const totalDur = sessionDuration && sessionDuration > 0 ? sessionDuration : buffer.duration;
  const trackFrac = Math.min(1, buffer.duration / totalDur);
  const trackW = Math.max(1, Math.floor(w * trackFrac));
  const samplesPerPx = Math.max(1, Math.floor(ch0.length / trackW));

  ctx.strokeStyle = 'rgba(88,166,255,0.95)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < trackW; x++) {
    const start = x * samplesPerPx;
    const end = Math.min(start + samplesPerPx, ch0.length);
    let mn = 0, mx = 0;
    for (let i = start; i < end; i++) {
      let v = ch0[i];
      if (ch1) v = (v + ch1[i]) * 0.5;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const yMin = Math.max(0, mid - mn * mid);
    const yMax = Math.min(h, mid - mx * mid);
    ctx.moveTo(x + 0.5, yMin);
    ctx.lineTo(x + 0.5, yMax);
  }
  ctx.stroke();

  // Center line spans the full lane so empty tail regions still read as audio
  // tracks rather than blanks.
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.beginPath();
  ctx.moveTo(0, mid + 0.5);
  ctx.lineTo(w, mid + 0.5);
  ctx.stroke();
}

// ---- Mixer ----
/**
 * Web Audio API engine that manages playback state, audio graphs, and FX chains.
 * Pure audio logic — zero DOM dependencies. Emits events via on()/emit().
 */
class Mixer {
  /** Creates a new Mixer with an AudioContext, master gain node, and impulse responses for reverb. */
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(this.ctx.destination);
    this.tracks = [];
    this.duration = 0;
    this.isPlaying = false;
    this.startCtxTime = 0;
    this.startOffset = 0;
    this._listeners = new Set();
    this.irs = {
      room: makeIR(this.ctx, 'room'),
      hall: makeIR(this.ctx, 'hall'),
      nonlin: makeIR(this.ctx, 'nonlin'),
    };
  }

  on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  emit(kind, payload) { for (const fn of this._listeners) fn(kind, payload); }

  addTrack(meta) {
    const ctx = this.ctx;

    // Channel-strip FX chain (always present; defaults are neutral).
    const inGain = ctx.createGain(); inGain.gain.value = 1;
    const eqLow = ctx.createBiquadFilter();
    eqLow.type = 'lowshelf'; eqLow.frequency.value = 120; eqLow.gain.value = 0;
    const eqMid = ctx.createBiquadFilter();
    eqMid.type = 'peaking'; eqMid.frequency.value = 1000; eqMid.Q.value = 1; eqMid.gain.value = 0;
    const eqHigh = ctx.createBiquadFilter();
    eqHigh.type = 'highshelf'; eqHigh.frequency.value = 6000; eqHigh.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24; comp.knee.value = 6; comp.ratio.value = 1;
    comp.attack.value = 0.01; comp.release.value = 0.1;
    const compMakeup = ctx.createGain(); compMakeup.gain.value = 1;
    const fxBus = ctx.createGain();
    const dryGain = ctx.createGain(); dryGain.gain.value = 1;
    const delaySend = ctx.createGain(); delaySend.gain.value = 0;
    const delayNode = ctx.createDelay(2.0); delayNode.delayTime.value = 0.25;
    const delayFeedback = ctx.createGain(); delayFeedback.gain.value = 0.3;
    const reverbSend = ctx.createGain(); reverbSend.gain.value = 0;
    const reverb = ctx.createConvolver(); reverb.buffer = this.irs.room;
    const outGain = ctx.createGain(); outGain.gain.value = 1;

    // Track-level fader + pan (downstream of FX chain).
    const gain = ctx.createGain(); gain.gain.value = 1;
    const panner = ctx.createStereoPanner(); panner.pan.value = 0;

    inGain.connect(eqLow);
    eqLow.connect(eqMid);
    eqMid.connect(eqHigh);
    eqHigh.connect(comp);
    comp.connect(compMakeup);
    compMakeup.connect(fxBus);
    fxBus.connect(dryGain); dryGain.connect(outGain);
    fxBus.connect(delaySend); delaySend.connect(delayNode);
    delayNode.connect(delayFeedback); delayFeedback.connect(delayNode);
    delayNode.connect(outGain);
    fxBus.connect(reverbSend); reverbSend.connect(reverb);
    reverb.connect(outGain);
    outGain.connect(gain);
    gain.connect(panner);
    panner.connect(this.master);

    const t = {
      ...meta,
      idx: this.tracks.length,
      buffer: null,
      gain,
      panner,
      source: null,
      volume: 1,
      pan: 0,
      muted: false,
      solo: false,
      loadProgress: 0,
      loaded: false,
      error: null,
      fx: { inGain, eqLow, eqMid, eqHigh, comp, compMakeup, fxBus, dryGain,
            delaySend, delayNode, delayFeedback, reverbSend, reverb, outGain },
      // fxState stores UI-facing values. Unit convention:
      //   dB values:  inGainDb, eqLowGain, eqMidGain, eqHighGain, compThreshold, compMakeupDb, outGainDb
      //   Hz values:  eqMidFreq (200–8000 Hz)
      //   Q factor:   eqMidQ (0.3–5)
      //   ratio:      compRatio (1–20:1)
      //   ms values:  compAttack, compRelease, delayTimeMs (stored as ms; /1000 for Web Audio API)
      //   % values:   delayFeedback, delayMix, reverbMix (stored as 0–100; /100 for gain nodes)
      //   string:     reverbType ('room' | 'hall' | 'nonlin')
      fxState: {
        inGainDb: 0,
        eqLowGain: 0, eqMidFreq: 1000, eqMidGain: 0, eqMidQ: 1, eqHighGain: 0,
        compThreshold: -24, compRatio: 1, compAttack: 10, compRelease: 100, compMakeupDb: 0,
        delayTimeMs: 250, delayFeedback: 30, delayMix: 0,
        reverbType: 'room', reverbMix: 0,
        outGainDb: 0,
      },
    };
    this.tracks.push(t);
    return t;
  }

  async loadTrack(t) {
    try {
      const resp = await fetch(t.url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      t.loadProgress = 0.5;
      this.emit('progress', t);
      t.buffer = await this.ctx.decodeAudioData(buf);
      t.loaded = true;
      t.loadProgress = 1;
      this.duration = Math.max(this.duration, t.buffer.duration);
      this._applyGain(t);
      this.emit('loaded', t);
    } catch (e) {
      t.error = String(e.message || e);
      this.emit('error', t);
    }
  }

  async loadAll(maxConcurrent = 8) {
    for (let i = 0; i < this.tracks.length; i += maxConcurrent) {
      const batch = this.tracks.slice(i, i + maxConcurrent);
      // Load concurrently; failures don't prevent other tracks in batch from completing
      await Promise.allSettled(batch.map(t => this.loadTrack(t)));
    }

    this.emit('all-loaded', null);
  }

  _anySolo() { return this.tracks.some(t => t.solo); }

  _applyGain(t) {
    const anySolo = this._anySolo();
    const soloGate = anySolo ? (t.solo ? 1 : 0) : 1;
    const muteGate = t.muted ? 0 : 1;
    const target = t.volume * soloGate * muteGate;
    t.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.01);
  }

  setVolume(idx, v) { this.tracks[idx].volume = v; this._applyGain(this.tracks[idx]); }
  setMute(idx, m)   { this.tracks[idx].muted  = m; this._applyGain(this.tracks[idx]); }
  setSolo(idx, s)   {
    this.tracks[idx].solo = s;
    for (const t of this.tracks) this._applyGain(t);
    this.emit('solo-changed', null);
  }
  clearSolos() {
    for (const t of this.tracks) t.solo = false;
    for (const t of this.tracks) this._applyGain(t);
    this.emit('solo-changed', null);
  }
  setMasterDb(db) {
    this.master.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.01);
  }

  setPan(idx, p) {
    const t = this.tracks[idx];
    t.pan = p;
    const now = this.ctx.currentTime;
    t.panner.pan.cancelScheduledValues(now);
    t.panner.pan.setValueAtTime(t.panner.pan.value, now);
    t.panner.pan.linearRampToValueAtTime(p, now + 0.015);
  }
  setInGain(idx, db) {
    const t = this.tracks[idx];
    t.fxState.inGainDb = db;
    t.fx.inGain.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.01);
  }
  setEqLow(idx, db) {
    const t = this.tracks[idx];
    t.fxState.eqLowGain = db;
    t.fx.eqLow.gain.setTargetAtTime(db, this.ctx.currentTime, 0.01);
  }
  setEqMidFreq(idx, hz) {
    const t = this.tracks[idx];
    t.fxState.eqMidFreq = hz;
    t.fx.eqMid.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.02);
  }
  setEqMidGain(idx, db) {
    const t = this.tracks[idx];
    t.fxState.eqMidGain = db;
    t.fx.eqMid.gain.setTargetAtTime(db, this.ctx.currentTime, 0.01);
  }
  setEqMidQ(idx, q) {
    const t = this.tracks[idx];
    t.fxState.eqMidQ = q;
    t.fx.eqMid.Q.setTargetAtTime(q, this.ctx.currentTime, 0.02);
  }
  setEqHigh(idx, db) {
    const t = this.tracks[idx];
    t.fxState.eqHighGain = db;
    t.fx.eqHigh.gain.setTargetAtTime(db, this.ctx.currentTime, 0.01);
  }
  setCompThreshold(idx, db) {
    const t = this.tracks[idx];
    t.fxState.compThreshold = db;
    t.fx.comp.threshold.setTargetAtTime(db, this.ctx.currentTime, 0.01);
  }
  setCompRatio(idx, r) {
    const t = this.tracks[idx];
    t.fxState.compRatio = r;
    t.fx.comp.ratio.setTargetAtTime(r, this.ctx.currentTime, 0.01);
  }
  setCompAttack(idx, ms) {
    const t = this.tracks[idx];
    t.fxState.compAttack = ms;
    t.fx.comp.attack.setTargetAtTime(ms / 1000, this.ctx.currentTime, 0.01);
  }
  setCompRelease(idx, ms) {
    const t = this.tracks[idx];
    t.fxState.compRelease = ms;
    t.fx.comp.release.setTargetAtTime(ms / 1000, this.ctx.currentTime, 0.01);
  }
  setCompMakeup(idx, db) {
    const t = this.tracks[idx];
    t.fxState.compMakeupDb = db;
    t.fx.compMakeup.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.01);
  }
  setDelayTime(idx, ms) {
    const t = this.tracks[idx];
    t.fxState.delayTimeMs = ms;
    t.fx.delayNode.delayTime.setTargetAtTime(ms / 1000, this.ctx.currentTime, 0.05);
  }
  setDelayFeedback(idx, pct) {
    const t = this.tracks[idx];
    t.fxState.delayFeedback = pct;
    t.fx.delayFeedback.gain.setTargetAtTime(pct / 100, this.ctx.currentTime, 0.01);
  }
  setDelayMix(idx, pct) {
    const t = this.tracks[idx];
    t.fxState.delayMix = pct;
    t.fx.delaySend.gain.setTargetAtTime(pct / 100, this.ctx.currentTime, 0.01);
  }
  setReverbType(idx, type) {
    const t = this.tracks[idx];
    t.fxState.reverbType = type;
    t.fx.reverb.buffer = this.irs[type];
  }
  setReverbMix(idx, pct) {
    const t = this.tracks[idx];
    t.fxState.reverbMix = pct;
    t.fx.reverbSend.gain.setTargetAtTime(pct / 100, this.ctx.currentTime, 0.01);
  }
  setOutGain(idx, db) {
    const t = this.tracks[idx];
    t.fxState.outGainDb = db;
    t.fx.outGain.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.01);
  }

  /**
    * Centralized FX parameter dispatch. Maps param keys to typed setters,
    * eliminating indirect string-based method lookup in track.js.
    * @param {number} idx - Track index.
    * @param {string} param - Param key matching fxState keys.
    * @param {*} value - Parameter value.
    */
  setFxParam(idx, param, value) {
    const t = this.tracks[idx];
    if (!t) return;
    // Param → setter mapping (type-safe, no string-based lookup)
    const setters = {
      inGainDb:       (v) => { t.fxState.inGainDb = v; t.fx.inGain.gain.setTargetAtTime(dbToGain(v), this.ctx.currentTime, 0.01); },
      eqLowGain:      (v) => { t.fxState.eqLowGain = v; t.fx.eqLow.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01); },
      eqMidFreq:      (v) => { t.fxState.eqMidFreq = v; t.fx.eqMid.frequency.setTargetAtTime(v, this.ctx.currentTime, 0.02); },
      eqMidGain:      (v) => { t.fxState.eqMidGain = v; t.fx.eqMid.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01); },
      eqMidQ:         (v) => { t.fxState.eqMidQ = v; t.fx.eqMid.Q.setTargetAtTime(v, this.ctx.currentTime, 0.02); },
      eqHighGain:     (v) => { t.fxState.eqHighGain = v; t.fx.eqHigh.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01); },
      compThreshold:  (v) => { t.fxState.compThreshold = v; t.fx.comp.threshold.setTargetAtTime(v, this.ctx.currentTime, 0.01); },
      compRatio:      (v) => { t.fxState.compRatio = v; t.fx.comp.ratio.setTargetAtTime(v, this.ctx.currentTime, 0.01); },
      compAttack:     (v) => { t.fxState.compAttack = v; t.fx.comp.attack.setTargetAtTime(v / 1000, this.ctx.currentTime, 0.01); },
      compRelease:    (v) => { t.fxState.compRelease = v; t.fx.comp.release.setTargetAtTime(v / 1000, this.ctx.currentTime, 0.01); },
      compMakeupDb:   (v) => { t.fxState.compMakeupDb = v; t.fx.compMakeup.gain.setTargetAtTime(dbToGain(v), this.ctx.currentTime, 0.01); },
      delayTimeMs:    (v) => { t.fxState.delayTimeMs = v; t.fx.delayNode.delayTime.setTargetAtTime(v / 1000, this.ctx.currentTime, 0.05); },
      delayFeedback:  (v) => { t.fxState.delayFeedback = v; t.fx.delayFeedback.gain.setTargetAtTime(v / 100, this.ctx.currentTime, 0.01); },
      delayMix:       (v) => { t.fxState.delayMix = v; t.fx.delaySend.gain.setTargetAtTime(v / 100, this.ctx.currentTime, 0.01); },
      reverbType:     (v) => { t.fxState.reverbType = v; t.fx.reverb.buffer = this.irs[v]; },
      reverbMix:      (v) => { t.fxState.reverbMix = v; t.fx.reverbSend.gain.setTargetAtTime(v / 100, this.ctx.currentTime, 0.01); },
      outGainDb:      (v) => { t.fxState.outGainDb = v; t.fx.outGain.gain.setTargetAtTime(dbToGain(v), this.ctx.currentTime, 0.01); },
    };
    setters[param]?.(value);
  }

  position() {
    if (this.isPlaying) {
      const elapsed = this.ctx.currentTime - this.startCtxTime;
      const latency = this.ctx.outputLatency != null ? this.ctx.outputLatency
                    : (this.ctx.baseLatency || 0);
      return Math.min(this.startOffset + Math.max(0, elapsed - latency), this.duration);
    }
    return this.startOffset;
  }

  /**
   * Start playback from the current offset. Creates audio sources for all loaded tracks.
   */
  async play() {
    if (this.isPlaying) return;

    if (this.duration <= 0) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (this.startOffset >= this.duration) this.startOffset = 0;
    const startTime = this.ctx.currentTime + 0.06;
    for (const t of this.tracks) {
      if (!t.buffer) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = t.buffer;
      src.connect(t.fx.inGain);
      const offset = Math.min(this.startOffset, t.buffer.duration);
      if (offset < t.buffer.duration - 1e-4) {
        try { src.start(startTime, offset); } catch (e) { /* already started — expected if source auto-finished */ }
      }
      t.source = src;
    }
    this.startCtxTime = startTime;
    this.isPlaying = true;
    this.emit('transport', null);
  }

  /**
   * Pause playback at the current position.
   */
  pause() {

    if (!this.isPlaying) return;
    const elapsed = this.ctx.currentTime - this.startCtxTime;
    this.startOffset = Math.min(
      this.startOffset + Math.max(0, elapsed),
      this.duration
    );
    for (const t of this.tracks) {
      if (t.source) {
        try { t.source.stop(); } catch (e) { /* Node may already be stopped */ }
        try { t.source.disconnect(); } catch (e) { /* Node may already be disconnected */ }
        t.source = null;
      }
    }
    this.isPlaying = false;
    this.emit('transport', null);
  }

  /**
   * Stop playback and reset to the beginning.
   */
  stop() { this.pause(); this.startOffset = 0; this.emit('transport', null); }

  /**
   * Seek to a specific position in seconds. Preserves playing state.
   * @param {number} sec - Target position in seconds.
   */
  seek(sec) {
    sec = Math.max(0, Math.min(sec, this.duration || 0));
    const wasPlaying = this.isPlaying;
    if (wasPlaying) this.pause();
    this.startOffset = sec;
    if (wasPlaying) this.play();
    else this.emit('transport', null);
  }
}

// ---- Time formatting utility ----
function fmtTime(sec) {
  const mins = Math.floor(sec / 60);
  const s = sec - mins * 60;
  return mins + ':' + String(Math.floor(s)).padStart(2, '0') + '.' + String(Math.floor((s % 1) * 1000)).padStart(3, '0');
}

// Export for module usage; also expose as global for inline scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Mixer, dbToGain, gainToDb, makeIR, renderWaveform, fmtTime };
} else {
  window.Mixer = Mixer;
  window.dbToGain = dbToGain;
  window.gainToDb = gainToDb;
  window.makeIR = makeIR;
  window.renderWaveform = renderWaveform;
  window.fmtTime = fmtTime;
}
