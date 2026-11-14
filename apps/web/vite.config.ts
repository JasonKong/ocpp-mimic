import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// Where the dev server proxies /api; matches the engine's default address.
const engineUrl = process.env.OCPP_MIMIC_ENGINE_URL ?? 'http://127.0.0.1:7300';

export default defineConfig({
  plugins: [vue()],
  server: {
    // ws: true also proxies the /api/events WebSocket.
    proxy: { '/api': { target: engineUrl, ws: true } },
  },
});
