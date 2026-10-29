import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({ imageService: 'compile' }),
  server: { port: 4321 },
  vite: { build: { assetsInlineLimit: 0 }, server: { watch: { ignored: ['**/.wrangler/**'] } } },
});
