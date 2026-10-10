// fx-strip.js — <daw-fx-strip> custom element
// Encapsulates the channel-strip FX panel: Input, EQ, Comp, Delay, Reverb, Output.
// Extracted from <daw-track> as part of Phase 3 (Web Components migration).
//
// Events dispatched upward:
//   fx-param-change  – { idx, section, param, value }
//   fx-reverb-type   – { idx, type }

import { PALETTE, baseStyle, btnStyles, rangeStyles, fmtValue } from './config.js';

const REVERB_TYPES = ['room', 'hall', 'nonlin'];

// Knob definitions: [section, label, min, max, step, defaultVal, paramKey]
const KNOB_DEFS = [
  ['Input', 'Gain',       -24,    24,    0.1,  0,     'inGainDb'],
  ['EQ',    'Low',        -18,    18,    0.1,  0,     'eqLowGain'],
  ['EQ',    'Mid Hz',      200,  8000,   10,  1000,  'eqMidFreq'],
  ['EQ',    'Mid',        -18,    18,    0.1,  0,     'eqMidGain'],
  ['EQ',    'Mid Q',        0.3,    5,  0.05,  1,     'eqMidQ'],
  ['EQ',    'High',       -18,    18,    0.1,  0,     'eqHighGain'],
  ['Comp',  'Thr',        -60,     0,   0.5, -24,    'compThreshold'],
  ['Comp',  'Ratio',        1,    20,   0.1,  1,     'compRatio'],
  ['Comp',  'Atk',          1,  200,     1,  10,     'compAttack'],
  ['Comp',  'Rel',         10, 1000,     5,  100,    'compRelease'],
  ['Comp',  'Makeup',     -12,   24,    0.1,  0,     'compMakeupDb'],
  ['Delay', 'Time',         0, 1500,     1,  250,    'delayTimeMs'],
  ['Delay', 'Fbk',          0,   95,     1,   30,    'delayFeedback'],
  ['Delay', 'Mix',          0,  100,     1,    0,    'delayMix'],
  ['Output','Gain',        -24,   24,    0.1,  0,     'outGainDb'],
];

/* ---- Build a single knob element ---- */
function buildKnob(defArr, ownerElement) {
  const [, label, min, max, step, initial, paramKey] = defArr;
  const section = defArr[0];

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(initial);
  slider.setAttribute('aria-label', `${section} ${label}`);
  slider.setAttribute('aria-valuemin', String(min));
  slider.setAttribute('aria-valuemax', String(max));
  slider.setAttribute('aria-valuenow', String(initial));

  const valSpan = document.createElement('span');
  valSpan.className = 'val';
  valSpan.textContent = fmtValue(paramKey, initial);

  const knobDiv = document.createElement('div');
  knobDiv.className = 'fx-knob';
  const labelEl = document.createElement('label');
  labelEl.textContent = label;
  knobDiv.append(labelEl, slider, valSpan);

  // Store paramKey on the element for sync lookup
  knobDiv.dataset.param = paramKey;

  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    valSpan.textContent = fmtValue(paramKey, v);
    slider.setAttribute('aria-valuenow', String(v));
    ownerElement._emitParamChange(section, paramKey, v);
  });
  slider.addEventListener('dblclick', () => {
    slider.value = String(initial);
    valSpan.textContent = fmtValue(paramKey, initial);
    slider.setAttribute('aria-valuenow', String(initial));
    ownerElement._emitParamChange(section, paramKey, initial);
  });

  return knobDiv;
}

/* ---- Build a section element ---- */
function buildSection(title, defs, ownerElement) {
  const sec = document.createElement('section');
  sec.className = 'fx-section' +
    (title === 'EQ' ? ' eq' : '') +
    (title === 'Comp' ? ' comp' : '');
  const h3 = document.createElement('h3');
  h3.textContent = title;
  sec.appendChild(h3);
  for (const d of defs) {
    sec.appendChild(buildKnob(d, ownerElement));
  }
  return sec;
}

/* ---- Custom Element ---- */

class DawFxStrip extends HTMLElement {
  constructor() {
    super();
    this._shadow = this.attachShadow({ mode: 'open' });
    this._mixer = null;
    this._idx = -1;
    this._fxState = {};
    this._knobMap = new Map();  // paramKey → { slider, valSpan }
    this._reverbType = 'room';  // current reverb type for pill state
  }

  init(mixer, idx) {
    this._mixer = mixer;
    this._idx = idx;
    if (this._mixer && this._mixer.tracks[idx]) {
      this._fxState = Object.assign({}, this._mixer.tracks[idx].fxState || {});
    }
    return this;
  }

  connectedCallback() {
    this._dom = {}; // will be set after _buildDOM
    this._buildDOM();
    const styleEl = document.createElement('style');
    styleEl.textContent = this._getStyle();
    this._shadow.appendChild(styleEl);
    this._registerKnobs();
  }

  _buildDOM() {
    // Build the actual FX panel content
    const container = document.createElement('div');
    container.className = 'fx-strip';

    // Header
    const header = document.createElement('div');
    header.className = 'fx-header';
    header.textContent = 'FX — Track ' + (this._idx + 1);
    container.appendChild(header);

    // Group knobs by section
    const grouped = new Map();
    for (const def of KNOB_DEFS) {
      const section = def[0];
      if (!grouped.has(section)) grouped.set(section, []);
      grouped.get(section).push(def);
    }

    // Build non-Reverb sections
    for (const [title, defs] of grouped) {
      if (title === 'Reverb') continue;
      container.appendChild(buildSection(title, defs, this));
    }

    // Build Reverb section (special: pill buttons + mix knob)
    container.appendChild(this._buildReverbSection());

    this._dom.container = container;
    this._shadow.appendChild(container);
  }

  _buildReverbSection() {
    const section = document.createElement('section');
    section.className = 'fx-section';
    const h3 = document.createElement('h3');
    h3.textContent = 'Reverb';
    section.appendChild(h3);

    const pillRow = document.createElement('div');
    pillRow.className = 'fx-pills';
    pillRow.setAttribute('role', 'radiogroup');
    pillRow.setAttribute('aria-label', 'Reverb type');
    const pills = []; // refs for toggle

    for (const typ of REVERB_TYPES) {
      const btn = document.createElement('button');
      btn.className = 'fx-pill' + (typ === this._reverbType ? ' on' : '');
      btn.dataset.type = typ;
      btn.textContent = typ;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(typ === this._reverbType));
      btn.addEventListener('click', () => {
        // Update instance state (not local closure)
        this._reverbType = typ;
        // Clear all pill highlights, then set this one
        for (let i = 0; i < pills.length; i++) {
          pills[i].classList.remove('on');
          pills[i].setAttribute('aria-checked', 'false');
        }
        btn.classList.add('on');
        btn.setAttribute('aria-checked', 'true');
        // Emit event upward
        this.dispatchEvent(new CustomEvent('fx-reverb-type', {
          detail: { idx: this._idx, type: typ },
          bubbles: true,
          composed: true,
        }));
      });
      pillRow.appendChild(btn);      pills.push(btn);
    }
    section.appendChild(pillRow);
    // Reverb Mix knob
    const mixDef = ['Reverb', 'Mix', 0, 100, 1, 0, 'reverbMix'];
    section.appendChild(buildKnob(mixDef, this));
    return section;
  }

  /* After DOM construction, index all knobs so syncFromMixer can update them */
  _registerKnobs() {
    this._knobMap.clear();
    const kdList = this._dom.container.querySelectorAll('.fx-knob');
    for (let i = 0; i < kdList.length; i++) {
      const kd = kdList[i];
      const pk = kd.dataset.param;
      if (!pk) continue;
      const slider = kd.querySelector('input[type="range"]');
      const valSpan = kd.querySelector('.val');
      if (slider && valSpan) {
        this._knobMap.set(pk, { slider, valSpan });
      }
    }
    // Also handle reverb mix separately since it's built differently
    const reverbMix = this._dom.container.querySelector(
      '.fx-section:nth-child(5) .fx-knob[data-param="reverbMix"]'
    );
    if (reverbMix) {
      const slider = reverbMix.querySelector('input[type="range"]');
      const valSpan = reverbMix.querySelector('.val');
      if (slider && valSpan) {
        this._knobMap.set('reverbMix', { slider, valSpan });
      }
    }
  }

  /* Sync UI state from mixer track data */
  syncFromMixer(trackObj) {
    if (!trackObj || !trackObj.fxState) return;
    this._fxState = Object.assign({}, trackObj.fxState);

    for (const [key, el] of this._knobMap) {
      const rawVal = this._fxState[key];
      if (rawVal !== undefined) {
        el.slider.value = String(rawVal);
        el.valSpan.textContent = fmtValue(key, rawVal);
      }
    }

    // Sync reverb pills
    const ct = this._fxState.reverbType || 'room';
    this._reverbType = ct;
    this._dom.container.querySelectorAll('.fx-pill').forEach(p => {
      p.classList.toggle('on', p.dataset.type === ct);
    });
  }

  _emitParamChange(section, param, value) {
    this.dispatchEvent(new CustomEvent('fx-param-change', {
      detail: { idx: this._idx, section, param, value },
      bubbles: true,
      composed: true,
    }));
  }

  _getStyle() {
    const base = baseStyle([
      '--bg', '--surface', '--surface-2',
      '--border', '--text', '--muted', '--accent',
    ]);
    return `${base}${btnStyles}${rangeStyles}
      .fx-strip { display: none; padding: 14px 18px 16px; background: var(--surface); border-top: 1px solid var(--border); gap: 0; flex-wrap: wrap; }
      :host(.open) .fx-strip { display: flex; }
      .fx-header { flex: 0 0 100%; margin: -4px 0 10px; font-family: ui-monospace, monospace; font-size: 11px; color: var(--accent); letter-spacing: 0.02em; }
      .fx-section { display: flex; flex-direction: column; gap: 6px; padding: 0 18px; border-right: 1px solid var(--border); min-width: 180px; }
      .fx-section:first-child { padding-left: 0; }
      .fx-section:last-child { border-right: none; padding-right: 0; }
      .fx-section.eq { min-width: 280px; }
      .fx-section.comp { min-width: 230px; }
      .fx-section h3 { margin: 0 0 4px; font-size: 10px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
      .fx-knob { display: grid; grid-template-columns: 56px 1fr 60px; align-items: center; gap: 8px; font-family: ui-monospace, monospace; font-size: 11px; }
      .fx-knob > label { color: var(--muted); }
      .fx-knob input[type=range] { width: 100%; height: 4px; border-radius: 2px; outline: none; }
      .fx-knob input[type=range]::-webkit-slider-thumb { width: 10px; height: 10px; border-radius: 50%; }
      .fx-knob input[type=range]::-moz-range-thumb { width: 10px; height: 10px; border-radius: 50%; }
      .fx-knob .val { color: var(--text); text-align: right; }
      .fx-pill { padding: 4px 12px; border-radius: 4px; background: transparent; color: var(--muted); font-family: ui-monospace, monospace; font-size: 10px; text-transform: lowercase; transition: all 120ms; cursor: pointer; }
      .fx-pill:hover { color: var(--text); border-color: var(--muted); }
      .fx-pill.on { background: var(--accent); color: #0d1117; border-color: var(--accent); }
    `;
  }
}

customElements.define('daw-fx-strip', DawFxStrip);
