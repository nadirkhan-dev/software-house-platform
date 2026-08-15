import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds straight into the directory Express already serves, so production is
// still one process and one port — no reverse proxy needed to run this.
export default defineConfig({
  plugins: [react()],
  build: { outDir: '../public', emptyOutDir: true, sourcemap: true },
  server: {
    port: 5173,
    // In development Vite serves the UI and forwards the API to Express, so the
    // session cookie stays same-origin and CSRF keeps working.
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } },
  },
});
