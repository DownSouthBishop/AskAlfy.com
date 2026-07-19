// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  integrations: [react()],
  server: {
    host: '127.0.0.1'
  },

  vite: {
    plugins: [tailwindcss()],
    server: {
      fs: {
        // node_modules is junctioned to C:\Users\15617\.dev-node-modules to keep it
        // out of the OneDrive-synced tree (OneDrive sync was causing severe dev
        // server I/O contention). Vite resolves the junction to its real path, so
        // that real path must be explicitly allowed here.
        allow: ['.', 'C:/Users/15617/.dev-node-modules/AskAlfy.com']
      }
    }
  }
});