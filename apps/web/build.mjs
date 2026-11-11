import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const directory = fileURLToPath(new URL('.', import.meta.url));
await build({
  absWorkingDir: directory,
  entryPoints: [
    { in: 'src/main.tsx', out: 'app' },
    { in: 'src/app.css', out: 'app' },
  ],
  entryNames: '[name]',
  outdir: 'dist',
  bundle: true,
  minify: true,
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
});
await copyFile(
  new URL('index.html', import.meta.url),
  new URL('dist/index.html', import.meta.url),
);
