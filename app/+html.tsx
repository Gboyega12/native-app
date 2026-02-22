import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

/**
 * Root HTML template for the web build.
 *
 * Adds PWA meta tags so the app launches in standalone mode
 * (fullscreen, no browser chrome) when added to the home screen
 * on iOS Safari or Android Chrome.
 */
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
        <title>Bocy</title>

        {/* ── PWA manifest ── */}
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#000000" />
        <meta name="background-color" content="#000000" />

        {/* ── iOS standalone mode ── */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Bocy" />
        <link rel="apple-touch-icon" href="/assets/images/icon.png" />

        {/* ── Android Chrome ── */}
        <meta name="mobile-web-app-capable" content="yes" />

        {/* Prevent text size adjustment on orientation change */}
        <meta name="format-detection" content="telephone=no" />

        <ScrollViewStyleReset />

        {/* Body scrolling disabled for RN ScrollView */}
        <style dangerouslySetInnerHTML={{ __html: `
          html, body { height: 100%; }
          body { overflow: hidden; -webkit-touch-callout: none; }
          #root { display: flex; height: 100%; flex: 1; }
        ` }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
