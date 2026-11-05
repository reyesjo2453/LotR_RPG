import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'three', test: /node_modules[\\/]three/ },
            { name: 'vendor', test: /node_modules[\\/](gsap|meshoptimizer)/ },
          ],
        },
      },
    },
  },
  server: { host: true },
});
