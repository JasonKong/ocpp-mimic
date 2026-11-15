import vue from '@vitejs/plugin-vue';
import { defineProject } from 'vitest/config';

// Component tests render the views to HTML with Vue's server renderer: no DOM is needed.
export default defineProject({
  plugins: [vue()],
  test: { name: 'web', include: ['src/**/*.test.ts'] },
});
