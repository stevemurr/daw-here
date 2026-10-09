// config.js — Shared design tokens for all web components.
// Import in player.js, track.js, and fx-strip.js:
//   import { PALETTE, baseStyle } from './config.js';

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
