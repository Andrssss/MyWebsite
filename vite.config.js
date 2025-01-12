import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite konfiguráció a proxy beállításával
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:5000', // Az Express.js szerver címe
        changeOrigin: true,
        secure: false, // Ha HTTPS-t használnál, akkor is elfogadja a nem biztonságos kapcsolatot
      },
    },
  },
});