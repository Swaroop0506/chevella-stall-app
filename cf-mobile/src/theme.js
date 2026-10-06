// Shared tokens, mirroring cf-admin's palette so the two feel like one product.
export const T = {
  green900: '#072a20',
  green800: '#0b3d2e',
  green700: '#125441',
  leaf: '#2e7d52',
  leafSoft: '#e7f2ea',
  sand: '#f3ede2',
  cream: '#fbf8f2',
  white: '#ffffff',
  ink: '#17201c',
  inkSoft: '#46514b',
  muted: '#7b847f',
  line: '#e3ddd1',
  amber: '#b7791f',
  amberSoft: '#fdf3e0',
  red: '#b3261e',
  redSoft: '#fdecea',
  radius: 14,
  radiusSm: 10,
};

export const text = {
  h1: { fontSize: 24, fontWeight: '700', color: T.ink, letterSpacing: -0.4 },
  h2: { fontSize: 18, fontWeight: '700', color: T.ink },
  body: { fontSize: 15, color: T.ink, lineHeight: 21 },
  hint: { fontSize: 13, color: T.muted, lineHeight: 18 },
  label: { fontSize: 12, fontWeight: '700', color: T.inkSoft, letterSpacing: 0.4, textTransform: 'uppercase' },
  mono: { fontFamily: 'monospace', fontSize: 13, color: T.ink },
};
