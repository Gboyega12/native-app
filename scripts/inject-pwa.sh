#!/bin/sh
# Inject PWA meta tags and manifest link into the static export HTML.
# Expo's static export doesn't use +html.tsx, so we patch dist/index.html
# after the build.

HTML="dist/index.html"

# PWA meta tags to inject into <head>
PWA_HEAD='<link rel="manifest" href="/manifest.json" /><meta name="apple-mobile-web-app-capable" content="yes" /><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" /><meta name="apple-mobile-web-app-title" content="Bocy" /><link rel="apple-touch-icon" href="/assets/images/icon.png" /><meta name="mobile-web-app-capable" content="yes" />'

# Inject before </head>
sed -i "s|</head>|${PWA_HEAD}</head>|" "$HTML"

# Inject background-color on body and html (existing behavior, moved here)
sed -i 's/<body>/<body style="background-color:#050505">/' "$HTML"
sed -i 's/<html lang="en">/<html lang="en" style="background-color:#050505">/' "$HTML"

echo "PWA tags injected into $HTML"
