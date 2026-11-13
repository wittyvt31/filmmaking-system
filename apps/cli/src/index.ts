import { createCommand } from 'commander';
import { spawnSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
  approveProductionPackage,
  cleanProductionFiles,
  executeProduction,
  inspectProductionProject,
  prepareProductionPackage,
} from '@filmmaking/orchestrator';
import { FfmpegMediaEngine } from '@filmmaking/media';
import {
  BlenderRendererAdapter,
  buildProceduralAsset,
  convertAssetToGlb,
  publishAsset,
} from '@filmmaking/engine-blender';
import { inspectGlbFile, normalizeGlbFile } from '@filmmaking/assets';

const cli = createCommand('filmie')
  .description(
    'Validate prepared projects, inspect plans, and render a complete local production.',
  )
  .showHelpAfterError();

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

cli
  .command('doctor')
  .description(
    'Inspect local Blender, render devices, CPU, memory and media tools.',
  )
  .option(
    '--blender <path>',
    'Blender executable (defaults to FILMIE_BLENDER or PATH)',
  )
  .action(({ blender }) => {
    const blenderPath = blender ?? process.env['FILMIE_BLENDER'] ?? 'blender';
    const version = spawnSync(blenderPath, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
    });
    const expression =
      "import bpy,json; p=bpy.context.preferences.addons.get('cycles'); d=[]; q=p.preferences if p else None; [(setattr(q,'compute_device_type',t),q.get_devices(),d.extend([{'name':x.name,'type':x.type,'use':x.use} for x in q.devices if x.type==t])) for t in ['OPTIX','CUDA','HIP','METAL','ONEAPI']] if q else None; print('FILMIE_CAPABILITIES='+json.dumps({'version':bpy.app.version_string,'engines':[e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items],'cyclesDevices':d}))";
    const capability =
      version.status === 0
        ? spawnSync(
            blenderPath,
            ['--background', '--factory-startup', '--python-expr', expression],
            { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
          )
        : null;
    const marker = capability?.stdout.match(/FILMIE_CAPABILITIES=(\{.*\})/);
    const ffmpeg = process.env['FILMIE_FFMPEG'] ?? 'ffmpeg';
    const ffprobe = process.env['FILMIE_FFPROBE'] ?? 'ffprobe';
    const report = {
      blender: {
        executable: blenderPath,
        pathAccessible: version.status === 0,
        exitCode: version.status,
        output: version.stdout.trim(),
        error: version.stderr.trim(),
        capabilities: marker?.[1] ? (JSON.parse(marker[1]) as unknown) : null,
        capabilityExitCode: capability?.status ?? null,
        capabilityError: capability?.stderr.trim() ?? '',
      },
      hardware: {
        platform: process.platform,
        cpu: cpus()[0]?.model ?? 'unknown',
        logicalCores: cpus().length,
        ramBytes: totalmem(),
      },
      media: {
        ffmpeg,
        ffmpegAvailable: availableOnPath(ffmpeg),
        ffprobe,
        ffprobeAvailable: availableOnPath(ffprobe),
      },
    };
    printJson(report);
    if (
      version.status !== 0 ||
      capability?.status !== 0 ||
      !report.media.ffmpegAvailable ||
      !report.media.ffprobeAvailable
    )
      process.exitCode = 1;
  });

cli
  .command('inspect-asset')
  .description('Inspect a GLB asset and report verified structural properties.')
  .requiredOption('--file <path>', 'GLB file to inspect')
  .option(
    '--descriptor <path>',
    'Optional authored, versioned asset descriptor JSON',
  )
  .action(async ({ file, descriptor }) => {
    const descriptorInput = descriptor
      ? JSON.parse(await readFile(resolve(descriptor), 'utf8'))
      : undefined;
    printJson(await inspectGlbFile(resolve(file), descriptorInput));
  });

cli
  .command('normalize-asset')
  .description('Normalize a self-contained GLB for Filmie compatibility.')
  .requiredOption('--input <path>', 'Source GLB file')
  .requiredOption('--output <path>', 'Normalized output GLB file')
  .option(
    '--descriptor <path>',
    'Optional authored, versioned asset descriptor JSON',
  )
  .action(async ({ input, output, descriptor }) => {
    const descriptorInput = descriptor
      ? JSON.parse(await readFile(resolve(descriptor), 'utf8'))
      : undefined;
    const report = await normalizeGlbFile(
      resolve(input),
      resolve(output),
      descriptorInput,
    );
    printJson(report);
    if (report.status === 'rejected') process.exitCode = 1;
  });

cli
  .command('convert-asset')
  .description('Convert GLB, glTF, FBX, OBJ, or .blend input into a GLB.')
  .requiredOption('--input <path>', 'Source asset path')
  .requiredOption('--output <path>', 'Self-contained GLB output path')
  .option(
    '--descriptor <path>',
    'Optional authored, versioned asset descriptor JSON',
  )
  .option('--blender <path>', 'Blender executable override')
  .option(
    '--timeout <milliseconds>',
    'Optional Blender conversion timeout',
    (value: string) => Number.parseInt(value, 10),
  )
  .action(async ({ input, output, descriptor, blender, timeout }) => {
    const descriptorInput = descriptor
      ? JSON.parse(await readFile(resolve(descriptor), 'utf8'))
      : undefined;
    const report = await convertAssetToGlb({
      inputPath: input,
      outputPath: output,
      ...(descriptorInput === undefined ? {} : { descriptor: descriptorInput }),
      ...(blender === undefined ? {} : { blenderPath: blender }),
      ...(timeout === undefined ? {} : { timeoutMs: timeout }),
    });
    printJson(report);
    if (report.status === 'rejected') process.exitCode = 1;
  });

cli
  .command('publish-asset')
  .description('Validate, normalize, and publish an immutable model asset.')
  .requiredOption('--input <path>', 'Source asset path')
  .requiredOption('--descriptor <path>', 'Authored asset descriptor JSON')
  .requiredOption('--registry <path>', 'Asset registry JSON path')
  .requiredOption('--license-name <name>', 'License name')
  .option('--license-url <url>', 'License URL')
  .option(
    '--license-restriction <restriction>',
    'License restriction (repeatable)',
    (value: string, previous: string[] = []) => [...previous, value],
    [],
  )
  .option(
    '--artifact-directory <directory>',
    'Content-addressed artifact directory',
  )
  .option('--report-directory <directory>', 'Diagnostic report directory')
  .option(
    '--metadata <json>',
    'Additional JSON object to store in asset metadata',
  )
  .option('--blender <path>', 'Blender executable override')
  .option(
    '--timeout <milliseconds>',
    'Optional Blender conversion timeout',
    (value: string) => Number.parseInt(value, 10),
  )
  .action(
    async ({
      input,
      descriptor,
      registry,
      licenseName,
      licenseUrl,
      licenseRestriction,
      artifactDirectory,
      reportDirectory,
      metadata,
      blender,
      timeout,
    }) => {
      const descriptorInput = JSON.parse(
        await readFile(resolve(descriptor), 'utf8'),
      );

      const metadataInput = metadata ? JSON.parse(metadata) : undefined;
      const report = await publishAsset({
        inputPath: input,
        descriptor: descriptorInput,
        registryPath: registry,
        ...(artifactDirectory === undefined ? {} : { artifactDirectory }),
        ...(reportDirectory === undefined ? {} : { reportDirectory }),
        ...(metadataInput === undefined ? {} : { metadata: metadataInput }),
        ...(blender === undefined ? {} : { blenderPath: blender }),
        ...(timeout === undefined ? {} : { timeoutMs: timeout }),
        license: {
          name: licenseName,
          ...(licenseUrl === undefined ? {} : { url: licenseUrl }),
          restrictions: licenseRestriction,
        },
      });
      printJson(report);
      if (report.status === 'rejected') process.exitCode = 1;
    },
  );

cli
  .command('build-procedural-asset')
  .description('Build, validate, and publish a deterministic procedural asset.')
  .requiredOption('--definition <path>', 'Procedural asset definition JSON')
  .requiredOption('--registry <path>', 'Asset registry JSON path')
  .requiredOption('--license-name <name>', 'License name')
  .option('--license-url <url>', 'License URL')
  .option(
    '--license-restriction <restriction>',
    'License restriction (repeatable)',
    (value: string, previous: string[] = []) => [...previous, value],
    [],
  )
  .option(
    '--artifact-directory <directory>',
    'Content-addressed artifact directory',
  )
  .option('--report-directory <directory>', 'Diagnostic report directory')
  .option('--cache-directory <directory>', 'Procedural GLB cache directory')
  .option(
    '--metadata <json>',
    'Additional JSON object to store in asset metadata',
  )
  .option('--blender <path>', 'Blender executable override')
  .option(
    '--timeout <milliseconds>',
    'Optional Blender build timeout',
    (value: string) => Number.parseInt(value, 10),
  )
  .action(
    async ({
      definition,
      registry,
      licenseName,
      licenseUrl,
      licenseRestriction,
      artifactDirectory,
      reportDirectory,
      cacheDirectory,
      metadata,
      blender,
      timeout,
    }) => {
      const definitionInput = JSON.parse(
        await readFile(resolve(definition), 'utf8'),
      );
      const metadataInput = metadata ? JSON.parse(metadata) : undefined;
      const report = await buildProceduralAsset({
        definition: definitionInput,
        registryPath: registry,
        ...(artifactDirectory === undefined ? {} : { artifactDirectory }),
        ...(reportDirectory === undefined ? {} : { reportDirectory }),
        ...(cacheDirectory === undefined ? {} : { cacheDirectory }),
        ...(blender === undefined ? {} : { blenderPath: blender }),
        ...(timeout === undefined ? {} : { timeoutMs: timeout }),
        ...(metadataInput === undefined ? {} : { metadata: metadataInput }),
        license: {
          name: licenseName,
          ...(licenseUrl === undefined ? {} : { url: licenseUrl }),
          restrictions: licenseRestriction,
        },
      });
      printJson(report);
      if (report.status === 'rejected') process.exitCode = 1;
    },
  );

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
    'Optional timeout per rendering or media process',
    (value: string) => Number.parseInt(value, 10),
  )
  .option(
    '--workers <count>',
    'Parallel Blender frame-range processes',
    (value: string) => Number.parseInt(value, 10),
    1,
  )
  .option(
    '--shot-workers <count>',
    'Concurrent shot jobs',
    (value: string) => Number.parseInt(value, 10),
    1,
  )
  .option(
    '--max-processes <count>',
    'Maximum concurrent Blender render processes',
    (value: string) => Number.parseInt(value, 10),
    16,
  )
  .action(
    async ({
      project,
      output,
      cache,
      seed,
      timeout,
      workers,
      shotWorkers,
      maxProcesses,
    }) => {
      const cancellation = new AbortController();
      const abort = () => cancellation.abort();
      process.once('SIGINT', abort);
      process.once('SIGTERM', abort);
      try {
        const renderer = new BlenderRendererAdapter({ workers });
        const ffmpegPath = process.env['FILMIE_FFMPEG'] ?? 'ffmpeg';
        const ffprobePath = process.env['FILMIE_FFPROBE'] ?? 'ffprobe';
        const result = await executeProduction({
          projectDirectory: project,
          outputDirectory: output,
          cacheDirectory: cache,
          renderer,
          media: new FfmpegMediaEngine({ ffmpegPath, ffprobePath }),
          randomSeed: seed,
          timeoutMs: timeout,
          signal: cancellation.signal,
          shotConcurrency: shotWorkers,
          frameWorkers: workers,
          maxRenderProcesses: maxProcesses,
          onLog: (line) => process.stdout.write(`${line}\n`),
        });
        process.stdout.write(
          `\nProduction successful. Master: ${result.masterPath}\nSummary: ${result.summaryPath}\n`,
        );
      } finally {
        process.removeListener('SIGINT', abort);
        process.removeListener('SIGTERM', abort);
      }
    },
  );

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
