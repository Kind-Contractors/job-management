import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// PWA/offline scope, deliberately narrow — see the Technician App offline
// audit/plan: this exists ONLY to make the app installable and let its
// static shell load offline. Every Supabase request (API/Auth/Storage) is
// explicitly excluded from the service worker's cache via NetworkOnly, so
// Manager's live-data behavior, the technician RPCs, and the just-fixed
// tab-focus auth handling are all completely unaffected — actual offline
// DATA availability comes entirely from the TanStack Query persister
// (main.tsx) and the IndexedDB write queue (src/technician/offline/),
// never from this service worker.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: {
        name: 'Kind Contractors',
        short_name: 'Kind Contractors',
        description: 'Kind Contractors job management — technician app',
        start_url: '/technician',
        display: 'standalone',
        background_color: '#f5f6f3',
        theme_color: '#1e544b',
        icons: [{ src: '/favicon.png', sizes: '256x256', type: 'image/png' }],
      },
      // Confirmed live in the built dist/sw.js: `generateSW` mode already
      // registers a NavigationRoute bound to index.html for every
      // navigation NOT matching navigateFallbackDenylist — production's
      // offline-shell fallback was already correct. `devOptions` is the
      // separate, real gap: it defaults to `enabled: false`, so under
      // `npm run dev` no service worker exists AT ALL, which is the actual
      // cause of the "Chrome shows its own offline page" failure — not a
      // NavigationRoute bug. Its own `navigateFallbackAllowlist` ALSO
      // defaults to only `/^\/$/` (the bare root) in dev mode specifically
      // — a second, separate default that would still block offline
      // reload of any non-root route (e.g. /technician/visits/:id/report)
      // even with the service worker enabled, so it's widened explicitly
      // below to match everything except the same excluded API prefixes.
      devOptions: {
        enabled: true,
        type: 'module',
        navigateFallbackAllowlist: [/^\/(?!(rest|auth|storage|functions)\/v1\/).*$/],
      },
      workbox: {
        // Raised from the 2 MiB default: jsPDF (Ready for Client's PDF
        // generation, src/lib/clientReportPdf.ts) pushed the main bundle
        // past it. Only changes the precache SIZE limit, not what's
        // cached or how — Supabase traffic is still never precached (see
        // navigateFallbackDenylist/runtimeCaching below), unchanged.
        maximumFileSizeToCacheInBytes: 3.5 * 1024 * 1024,
        // Never cache Supabase traffic — the one rule that keeps this PWA
        // shell change from altering any live-data/auth behavior anywhere
        // in the app.
        navigateFallbackDenylist: [/^\/(rest|auth|storage|functions)\/v1\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }: { url: URL }) => url.hostname.endsWith('.supabase.co'),
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
});