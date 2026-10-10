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
