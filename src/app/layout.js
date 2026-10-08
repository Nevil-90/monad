// Fonts are self-hosted from npm (Fontsource): no request to Google from the build or the visitor
import '@fontsource/unbounded/latin-400.css';
import '@fontsource/unbounded/latin-500.css';
import '@fontsource/unbounded/latin-600.css';
import '@fontsource/unbounded/latin-700.css';
import '@fontsource/manrope/latin-400.css';
import '@fontsource/manrope/latin-500.css';
import '@fontsource/manrope/latin-600.css';
import '@fontsource/manrope/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import '@fontsource/jetbrains-mono/latin-700.css';
import '../style.css';

export const metadata = {
  title: 'Pulse · Rise or Fall',
  description: 'Predict whether a price closes above or below the strike. Pari-mutuel rounds on Monad, settled with RedStone oracle prices.',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg', apple: '/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'Pulse', statusBarStyle: 'black-translucent' }
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#06050b'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
