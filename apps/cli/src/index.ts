import { createCommand } from 'commander';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { RendererSelectionSchema } from '@filmmaking/contracts';
import {
  approveProductionPackage,
  cleanProductionFiles,
  executeProduction,
  inspectProductionProject,
  prepareProductionPackage,
} from '@filmmaking/orchestrator';
import {
  RemotionRendererAdapter,
  getBundledMediaExecutables,
} from '@filmmaking/engine-remotion';
import { FfmpegMediaEngine } from '@filmmaking/media';
import { BlenderRendererAdapter } from '@filmmaking/engine-blender';
import { buildProceduralAssets } from '@filmmaking/engine-blender/authoring';
import { prepareLayeredArtwork } from '@filmmaking/engine-blender/artwork';
import { compilePreparedScreenplay } from '@filmmaking/manifest';

const cli = createCommand('filmie')
  .description(
    'Validate prepared projects, inspect plans, and render a complete local production.',
  )
  .showHelpAfterError();

cli
  .command('compile-screenplay')
  .description(
    'Compile a prepared scene and shot breakdown into a deterministic manifest without inventing instructions.',
  )
  .requiredOption('-i, --input <file>', 'Prepared screenplay JSON')
  .requiredOption('-p, --project <directory>', 'Destination project directory')
  .option('--replace', 'Replace an existing manifest')
  .action(async ({ input, project, replace }) => {
    const destination = resolve(project, 'manifest.json');
    const screenplay = JSON.parse(
      await readFile(resolve(input), 'utf8'),
    ) as unknown;
    const result = compilePreparedScreenplay(screenplay);
    await mkdir(resolve(project), { recursive: true });
    await writeFile(
      destination,
      `${JSON.stringify(result.manifest, null, 2)}\n`,
      {
        flag: replace ? 'w' : 'wx',
      },
    );
    process.stdout.write(
      `Compiled ${result.manifest.shots.length} prepared shots (${result.manifest.timeline.durationFrames} frames).\n` +
        `Source fingerprint: ${result.sourceFingerprint}\nManifest: ${destination}\n`,
    );
  });

const packageCommand = cli
  .command('package')
  .description(
    'Prepare and record human approval for deterministic production packages.',
  );

packageCommand
  .command('prepare')
  .description(
    'Validate the project and seal its exact manifest and asset dependencies for review.',
  )
  .requiredOption('-p, --project <directory>', 'Prepared project directory')
  .option(
    '--replace',
    'Replace an existing package lock and revoke its approval',
  )
  .action(async ({ project, replace }) => {
    const result = await prepareProductionPackage({
      projectDirectory: project,
      replace,
    });
    process.stdout.write(
      `Prepared package ${result.fingerprint} with ${result.dependencyCount} dependencies.\nReview and approve: ${result.path}\n`,
    );
  });

packageCommand
  .command('approve')
  .description('Record human approval of an unchanged production package.')
  .requiredOption('-p, --project <directory>', 'Prepared project directory')
  .requiredOption('--by <name>', 'Approver name or identifier')
  .action(async ({ project, by }) => {
    const result = await approveProductionPackage({
      projectDirectory: project,
      approvedBy: by,
    });
    process.stdout.write(
      `Approved package ${result.fingerprint}.\nPackage: ${result.path}\n`,
    );
  });

cli
  .command('prepare')
  .description(
    'Create and register deterministic Blender assets from asset-spec.json.',
  )
  .requiredOption(
    '-p, --project <directory>',
    'Project directory containing asset-spec.json',
  )
  .option(
    '--timeout <milliseconds>',
    'Asset build timeout',
    (value: string) => Number.parseInt(value, 10),
    600_000,
  )
  .action(async ({ project, timeout }) => {
    const result = await buildProceduralAssets({
      projectDirectory: project,
      timeoutMs: timeout,
    });
    process.stdout.write(
      `Prepared ${result.createdAssetIds.length} new assets; reused ${result.reusedAssetIds.length}.\n` +
        `Registry: ${resolve(project, 'assets.json')}\nReceipt: ${result.receiptPath}\n`,
    );
  });

cli
  .command('artwork')
  .description(
    'Prepare layered 2.5D artwork into reusable Blender asset packages.',
  )
  .command('prepare')
  .description(
    'Build and register versioned character, environment, and prop packages from registered PNG artwork.',
  )
  .requiredOption(
    '-p, --project <directory>',
    'Project directory containing artwork-spec.json and assets.json',
  )
  .option(
    '--timeout <milliseconds>',
    'Blender preparation timeout',
    (value: string) => Number.parseInt(value, 10),
    600_000,
  )
  .action(async ({ project, timeout }) => {
    const result = await prepareLayeredArtwork({
      projectDirectory: project,
      timeoutMs: timeout,
    });
    process.stdout.write(
      `Prepared ${result.createdAssetIds.length} new artwork packages; reused ${result.reusedAssetIds.length}.\n` +
        `Registry: ${resolve(project, 'assets.json')}\nReceipt: ${result.receiptPath}\n`,
    );
  });

function projectOptions(command: ReturnType<typeof cli.command>) {
  return command
    .requiredOption(
      '-p, --project <directory>',
      'Project directory containing manifest.json and assets.json',
    )
    .option('-o, --output <directory>', 'Generated output directory', 'dist')
    .option(
      '-c, --cache <directory>',
      'Local cache directory',
      '.cache/production',
    );
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function availableOnPath(executable: string): boolean {
  return (
    spawnSync(executable, ['-version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    }).status === 0
  );
}

projectOptions(
  cli
    .command('validate')
    .description(
      'Validate the manifest and resolve every exact asset version.',
    ),
).action(async ({ project, output, cache }) => {
  const { loaded } = await inspectProductionProject({
    projectDirectory: project,
    outputDirectory: output,
    cacheDirectory: cache,
  });
  const { prepared } = loaded;
  process.stdout.write(
    `Valid: ${prepared.manifest.projectId}@${prepared.manifest.version}\nShots: ${prepared.manifest.shots.length}\nAssets resolved: ${prepared.assets.length}\nTimeline frames: ${prepared.timeline.durationFrames}\nTimeline SHA-256: ${prepared.timeline.sha256}\n`,
  );
});

projectOptions(
  cli
    .command('timeline')
    .description('Compile and inspect the integer-frame timeline.'),
).action(async ({ project, output, cache }) => {
  const { loaded } = await inspectProductionProject({
    projectDirectory: project,
    outputDirectory: output,
    cacheDirectory: cache,
  });
  const timeline = loaded.prepared.timeline;
  printJson({
    projectId: timeline.projectId,
    durationFrames: timeline.durationFrames,
    frameRate: timeline.frameRate,
    durationSeconds:
      (timeline.durationFrames * timeline.frameRate.denominator) /
      timeline.frameRate.numerator,
    sha256: timeline.sha256,
    videoTracks: timeline.videoTracks,
    audioTracks: timeline.audioTracks,
  });
});

projectOptions(
  cli
    .command('plan')
    .description('Generate and display the deterministic render plan.'),
).action(async ({ project, output, cache }) => {
  const { loaded } = await inspectProductionProject({
    projectDirectory: project,
    outputDirectory: output,
    cacheDirectory: cache,
  });
  printJson(loaded.prepared.renderPlan);
});

projectOptions(
  cli
    .command('render')
    .description(
      'Run the complete shot-render, assembly, and verification pipeline.',
    ),
)
  .option(
    '--seed <integer>',
    'Deterministic rendering seed',
    (value: string) => Number.parseInt(value, 10),
    0,
  )
  .option(
    '--timeout <milliseconds>',
    'Timeout per rendering or media process',
    (value: string) => Number.parseInt(value, 10),
    600_000,
  )
  .action(async ({ project, output, cache, seed, timeout }) => {
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    try {
      const manifest = JSON.parse(
        await readFile(resolve(project, 'manifest.json'), 'utf8'),
      ) as unknown;
      if (!manifest || typeof manifest !== 'object')
        throw new Error('Project manifest must be a JSON object.');
      const renderPolicy = (manifest as Record<string, unknown>)[
        'renderPolicy'
      ];
      if (!renderPolicy || typeof renderPolicy !== 'object')
        throw new Error('Project manifest needs a renderPolicy.');
      const rendererSelection = RendererSelectionSchema.parse(
        (renderPolicy as Record<string, unknown>)['renderer'],
      );
      const renderer =
        rendererSelection.id === 'remotion'
          ? new RemotionRendererAdapter()
          : new BlenderRendererAdapter(rendererSelection.config);
      const bundledExecutables = getBundledMediaExecutables();
      const ffmpegPath =
        process.env['FILMIE_FFMPEG'] ??
        (availableOnPath('ffmpeg') ? 'ffmpeg' : bundledExecutables.ffmpegPath);
      const ffprobePath =
        process.env['FILMIE_FFPROBE'] ??
        (availableOnPath('ffprobe')
          ? 'ffprobe'
          : bundledExecutables.ffprobePath);
      const result = await executeProduction({
        projectDirectory: project,
        outputDirectory: output,
        cacheDirectory: cache,
        renderer,
        media: new FfmpegMediaEngine({ ffmpegPath, ffprobePath }),
        randomSeed: seed,
        timeoutMs: timeout,
        signal: cancellation.signal,
        onLog: (line) => process.stdout.write(`${line}\n`),
      });
      process.stdout.write(
        `\nProduction successful. Master: ${result.masterPath}\nSummary: ${result.summaryPath}\n`,
      );
    } finally {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    }
  });

projectOptions(
  cli
    .command('cache')
    .description('Inspect cached shot and assembly artifacts.'),
).action(async ({ project, output, cache }) => {
  const { loaded, cacheDirectory } = await inspectProductionProject({
    projectDirectory: project,
    outputDirectory: output,
    cacheDirectory: cache,
  });
  const entries: { group: string; fingerprint: string; bytes: number }[] = [];
  for (const group of ['shots', 'assembly']) {
    const directory = join(cacheDirectory, group);
    const fingerprints = await readdir(directory).catch(() => []);
    for (const fingerprint of fingerprints) {
      const entryPath = join(directory, fingerprint);
      const info = await stat(entryPath).catch(() => null);
      if (!info?.isDirectory()) continue;
      const metadataPath = join(entryPath, 'metadata.json');
      const metadata: { files?: { bytes?: number }[] } = await readFile(
        metadataPath,
        'utf8',
      )
        .then((value) => JSON.parse(value) as { files?: { bytes?: number }[] })
        .catch((): { files?: { bytes?: number }[] } => ({}));
      entries.push({
        group,
        fingerprint,
        bytes:
          metadata.files?.reduce((sum, file) => sum + (file.bytes ?? 0), 0) ??
          0,
      });
    }
  }
  printJson({
    projectId: loaded.prepared.manifest.projectId,
    cacheDirectory,
    entryCount: entries.length,
    entries,
  });
});

cli
  .command('clean')
  .description('Remove generated output and cache files for a project.')
  .requiredOption(
    '-p, --project <directory>',
    'Project directory containing manifest.json',
  )
  .option('-o, --output <directory>', 'Generated output directory', 'dist')
  .option(
    '-c, --cache <directory>',
    'Local cache directory',
    '.cache/production',
  )
  .action(async ({ project, output, cache }) => {
    const manifest = JSON.parse(
      await readFile(resolve(project, 'manifest.json'), 'utf8'),
    ) as { projectId?: unknown };
    if (typeof manifest.projectId !== 'string')
      throw new Error(
        'Project manifest needs a projectId before generated files can be cleaned.',
      );
    await cleanProductionFiles(output, cache, manifest.projectId);
    process.stdout.write(
      `Cleaned generated output and cache for ${manifest.projectId}.\n`,
    );
  });

try {
  await cli.parseAsync(process.argv);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
