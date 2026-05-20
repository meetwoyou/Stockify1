STOCKIFY PRO ULTRA — v2 (Standalone Build)
==========================================

FILES IN THIS FOLDER:
  index.html        — Main HTML (open this)
  app.js            — Application logic
  manifest.json     — PWA manifest (installable + offline)
  sw.js             — Service Worker (offline cache)
  icon-192.png      — App icon 192x192 (auto-generated)
  icon-512.png      — App icon 512x512 (auto-generated)
  icon-maskable.png — Maskable icon for Android adaptive (auto-generated)
  sabbir.jpg        — Developer photo (REPLACE this with your own photo,
                      same filename: sabbir.jpg). If missing, an "S" badge
                      will show instead.

WHAT'S NEW IN v2:
  1. Category field: tap it (or "Browse") to see ALL existing categories
     in the store with item counts. Pick one or type a new one.
  2. Pieces per Carton is now shown on every product card (e.g. "1 Carton
     = 24 pcs"). Quick buttons let you add +1 Carton, -1 Carton, or +1 Pc
     directly from the card — no need to open the form.
  3. Bi-directional pricing: enter Piece Price → Carton Price updates
     automatically (using Pieces/Carton). Enter Carton Price → Piece
     Price updates the same way.
  4. Image upload auto-compresses any size (even 10 MB) down to ~250 KB
     before uploading to Cloudinary. New "Camera" button opens the device
     camera so you can snap and upload instantly.
  5. Scanner is much more reliable: waits for the library to load, lists
     available cameras, prefers the back camera, falls back gracefully,
     and shows a clear error if something is wrong. HTTPS required
     (GitHub Pages works out of the box).
  6. Settings: Developer card now shows Website, Facebook, Instagram
     links. "Install App" button appears when your browser supports it
     (and a top banner pops up automatically on first eligible visit).

HOW TO RUN:
  1. Keep all files inside ONE folder.
  2. Camera (scanner) requires HTTPS or http://localhost.
     - Local: python -m http.server 8080  →  http://localhost:8080
     - Or push to GitHub Pages (https://USERNAME.github.io/REPO)
  3. First load needs internet (to cache assets). After that, the app
     works fully OFFLINE — products you've loaded stay available, and
     any edits sync automatically when you reconnect (Firestore offline
     persistence + Service Worker).

INSTALL TO HOME SCREEN:
  - On supported browsers (Chrome, Edge, Android), a banner appears on
    eligible visits, or use the "Install" button in Settings.
  - On iOS Safari: Share → Add to Home Screen.

PC + MOBILE:
  - Phone: in-app scanner uses the back camera.
  - PC: connect a USB barcode scanner — most act like a keyboard,
    so scanning into the SKU field works automatically.
