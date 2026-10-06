import './globals.css';

export const metadata = {
  title: {
    default: 'Chevella Farms — Stall Console',
    template: '%s · Chevella Farms',
  },
  description: 'Event stall console: contact QR codes and visiting-card lead capture.',
  robots: { index: false, follow: false },   // internal tool; nothing here should be indexed
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0b3d2e',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
