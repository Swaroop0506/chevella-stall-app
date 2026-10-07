export const metadata = {
  title: 'Scanner — Chevella Farms',
  description: 'Photograph visiting cards at the stall. No login, works offline.',
  manifest: '/manifest.webmanifest',
  robots: { index: false, follow: false },
  appleWebApp: {
    capable: true,
    title: 'Scanner',
    statusBarStyle: 'black-translucent',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  // The camera guide and the shutter must not move when someone double-taps by accident.
  maximumScale: 1,
  userScalable: false,
  themeColor: '#0b3d2e',
  viewportFit: 'cover',
};

export default function ScanLayout({ children }) {
  return children;
}
