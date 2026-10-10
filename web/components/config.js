// config.js — Shared design tokens for all web components.
// Import in player.js, track.js, and fx-strip.js:
//   import { PALETTE, baseStyle, btnStyles, rangeStyles } from './config.js';

export const PALETTE = {
  '--bg':        '#0d1117',
  '--surface':   '#161b22',
  '--surface-2': '#1c2330',
  '--surface-3': '#222b3a',
  '--border':    '#30363d',
  '--border-2':  '#444c56',
  '--text':      '#e6edf3',
  '--muted':     '#8b949e',
  '--accent':    '#58a6ff',
  '--solo':      '#d29922',
  '--mute':      '#f85149',
  '--playhead':  '#f0883e',
  '--wave':      '#58a6ff',
  '--wave-bg':   '#0a1018',
};

const ALL_KEYS = Object.keys(PALETTE);

// Build a `:host { ...vars... }` + reset block.
// Pass an array of keys to limit which variables are emitted (default: all).
// Uses array.join for safer CSS property generation (no string concat issues).
export function baseStyle(keys) {
  const vars = (keys || ALL_KEYS)
    .map(k => `${k}: ${PALETTE[k]}`)
    .join('; ');
  return `:host { display: block; ${vars}; }
* { box-sizing: border-box; }
`;
}

// Shared button styles — used by player.js, track.js, fx-strip.js.
// Components override specific properties as needed.
export const btnStyles = `
  button { cursor: pointer; user-select: none; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; font-size: 13px; font-family: inherit; transition: all 0.1s ease; }
  button:hover:not(:disabled) { background: var(--surface-2); border-color: var(--border-2); }
  button:disabled { opacity: 0.3; cursor: default; }
`;

// Shared range input styles — base rules for all <input type="range">.
// Components add component-specific thumb/track overrides.
export const rangeStyles = `
  input[type="range"] { -webkit-appearance: none; appearance: none; height: 18px; background: transparent; cursor: pointer; }
  input[type="range"]::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: var(--border); }
  input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%; background: var(--accent); margin-top: -4px; }
  input[type="range"]::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: var(--accent); border: none; cursor: pointer; }
`;

// ---- Time formatting utility ----
// Formats seconds as "m:ss.mmm" (e.g. "1:23.456").
export function fmtTime(sec) {
  const mins = Math.floor(sec / 60);
  const s = sec - mins * 60;
  return mins + ':' + String(Math.floor(s)).padStart(2, '0') + '.' + String(Math.floor((s % 1) * 1000)).padStart(3, '0');
}

// ---- Value formatting registry ----
// Maps param keys to format functions for FX knob readouts.
const fmtRegistry = {
  eqMidFreq:       v => v >= 1000 ? (v / 1000).toFixed(1) + ' kHz' : v.toFixed(0) + ' Hz',
  compRatio:       v => v.toFixed(1) + ':1',
  compAttack:      v => v.toFixed(0) + ' ms',
  compRelease:     v => v.toFixed(0) + ' ms',
  delayTimeMs:     v => v.toFixed(0) + ' ms',
  delayFeedback:   v => v.toFixed(0) + ' %',
  delayMix:        v => v.toFixed(0) + ' %',
  reverbMix:       v => v.toFixed(0) + ' %',
  eqMidQ:          v => v.toFixed(2),
  // Default: dB values with sign prefix
  default:         v => (v >= 0 ? '+' : '') + v.toFixed(1) + ' dB',
};

// Format an FX parameter value using the registry. Falls back to dB format.
export function fmtValue(paramKey, v) {
  return (fmtRegistry[paramKey] || fmtRegistry.default)(v);
}
