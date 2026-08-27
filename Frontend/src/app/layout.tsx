import type { Metadata } from 'next';
import { Inter, Geist_Mono } from 'next/font/google';
import './globals.css';

/*
 * Inter is the blueprint's typeface. It is loaded through next/font rather than the
 * @import url(fonts.googleapis.com) the prototype used: next/font self-hosts the file, so
 * there is no render-blocking request to a third party and no layout shift when it lands.
 */
const inter = Inter({ variable: '--font-inter', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Employee Monitor',
  description: 'Workforce productivity and attendance reporting',
};

/**
 * Applies the stored theme before the browser paints.
 *
 * This runs as a blocking inline script on purpose. Resolving the theme in a React effect
 * would render the light palette first and then repaint dark, which is a visible flash on
 * every navigation for anyone using dark mode.
 */
const themeScript = `
(function () {
  try {
    var stored = localStorage.getItem('theme');
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (stored === 'dark' || (stored !== 'light' && prefersDark)) {
      document.documentElement.classList.add('dark');
    }
  } catch (e) {
    /* Private mode can throw on localStorage; the light default is fine. */
  }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /*
     * The font variables go on <html>, not <body>: globals.css resolves the `font-sans`
     * utility on the html element, and a variable defined only on body is out of scope there.
     */
    <html lang="en" className={`${inter.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={`${inter.variable} ${geistMono.variable}`}>
        {/* The ambient ground every surface floats on. Rendered once here so the login screen
            and the dashboard share it, and so it never repaints on navigation. */}
        <div className="spatial-bg" aria-hidden />
        <div className="relative z-10">{children}</div>
      </body>
    </html>
  );
}
