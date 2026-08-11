import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  build: {
    outDir: 'dist-lib',
    emptyOutDir: true,
    lib: { entry: path.resolve(__dirname, 'src/web-core.tsx'), formats: ['es'], fileName: 'web-core', cssFileName: 'style' },
    rollupOptions: { external: ['react', 'react-dom', 'react/jsx-runtime'] },
  },
});
