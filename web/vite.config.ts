import { defineConfig } from 'vite';

// `npm run dev` serves the client with hot reload. The SIP WebSocket and the
// config API are proxied to the running stack (docker compose up).
export default defineConfig({
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8088', ws: true },
      '/api': { target: 'https://127.0.0.1:8443', secure: false },
    },
  },
});
