import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@filmmaking/contracts': resolve('packages/contracts/src/index.ts'),
      '@filmmaking/assets': resolve('packages/assets/src/index.ts'),
      '@filmmaking/manifest': resolve('packages/manifest/src/index.ts'),
      '@filmmaking/timeline': resolve('packages/timeline/src/index.ts'),
      '@filmmaking/planner': resolve('packages/planner/src/index.ts'),
      '@filmmaking/scene': resolve('packages/scene/src/index.ts'),
      '@filmmaking/cache': resolve('packages/cache/src/index.ts'),
      '@filmmaking/engine-remotion': resolve('engines/remotion/src/index.ts'),
      '@filmmaking/engine-blender': resolve('engines/blender/src/index.ts'),
      '@filmmaking/orchestrator': resolve('packages/orchestrator/src/index.ts'),
      '@filmmaking/media': resolve('packages/media/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    passWithNoTests: false,
  },
});
