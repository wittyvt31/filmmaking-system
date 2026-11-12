import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  parseProjectManifest,
  resolveShotRenderDimensions,
  ShotSchema,
} from '@filmmaking/contracts';
import { compileScene, filmPlane, projectCameraPoint } from '@filmmaking/scene';
const input = () =>
  JSON.parse(readFileSync('examples/cinematography/manifest.json', 'utf8'));
const rate = { numerator: 30, denominator: 1 };

it('compiles independent cameras, stable seeded motion, and shot-relative cuts', () => {
  const manifest = parseProjectManifest(input());
  const shot = manifest.shots[0]!;
  const result = compileScene(shot, rate);
  expect(compileScene(shot, rate).cinematography).toEqual(
    result.cinematography,
  );
  const cinema = result.cinematography!;
  expect(cinema.rigs.map((r) => r.id)).toEqual(['dolly', 'handheld', 'orbit']);
  expect(cinema.cuts.map((c) => [c.startFrame, c.endFrame])).toEqual([
    [0, 8],
    [8, 16],
    [16, 24],
  ]);
  expect(cinema.rigs.every((r) => r.frames.length === 24)).toBe(true);
  const edited = input();
  edited.shots[0].scene.camera.rigs[2].behaviors[2].seed++;
  const changed = compileScene(ShotSchema.parse(edited.shots[0]), rate);
  expect(changed.sha256).not.toBe(result.sha256);
  expect(changed.world?.sha256).toBe(result.world?.sha256);
  expect(changed.characters).toEqual(result.characters);
  expect(changed.cinematography!.rigs[0]).toEqual(cinema.rigs[0]);
  expect(changed.cinematography!.rigs[1]).not.toEqual(cinema.rigs[1]);
});

it('matches exact optical placement with a vertical sensor, cubic path and rack focus', () => {
  const raw = input().shots[0];
  const target = { kind: 'point', position: [1, 0, 1] };
  raw.scene.camera = {
    type: 'rigs',
    rigs: [
      {
        id: 'test',
        position: [
          { frame: 0, value: [0, -5, 0], outControl: [0, -5, 2] },
          { frame: 10, value: [2, -5, 0], inControl: [2, -5, 2] },
        ],
        framing: { target, x: 0.73, headroom: 0.19 },
        optics: {
          focalLength: 47,
          sensor: { width: 36, height: 21, fit: 'vertical' },
          focus: {
            kind: 'distance',
            distance: 5,
            keys: [
              { frame: 0, value: 3 },
              { frame: 10, value: 7 },
            ],
          },
        },
      },
    ],
    cuts: [{ cameraId: 'test', startFrame: 0, endFrame: 24 }],
  };
  const camera = compileScene(ShotSchema.parse(raw), rate, [], 4 / 3)
    .cinematography!.rigs[0]!;
  expect(camera.frames[5]!.position).toEqual([1, -5, 1.5]);
  expect(camera.frames[5]!.focusDistance).toBe(5);
  expect(camera.frames[10]!.focusDistance).toBe(7);
  for (const sample of camera.frames) {
    const projection = projectCameraPoint(
      sample,
      [1, 0, 1],
      filmPlane(camera.optics.sensor, 4 / 3),
    );
    expect(projection.x).toBeCloseTo(0.73, 10);
    expect(projection.y).toBeCloseTo(0.81, 10);
  }
});

it('rejects gaps, out-of-frame subjects and occlusion by world geometry', () => {
  const bad = input();
  bad.shots[0].scene.camera.cuts[1].startFrame = 9;
  expect(() => parseProjectManifest(bad)).toThrow(/consecutive/);
  const raw = input().shots[0];
  const target = { kind: 'point', position: [0, 0, 1] };
  raw.scene.camera = {
    type: 'rigs',
    rigs: [
      {
        id: 'test',
        position: [{ frame: 0, value: [0, -4, 1] }],
        lookAt: target,
        visibility: [{ target, occlusion: 'proxies' }],
      },
    ],
    cuts: [{ cameraId: 'test', startFrame: 0, endFrame: 24 }],
  };
  raw.scene.world.entities.push({
    id: 'blocker',
    geometry: {
      kind: 'box',
      dimensions: { x: 1, y: 1, z: 1 },
      materialId: 'wall',
    },
    transform: {
      position: { x: 0, y: -2, z: 1 },
      rotationDegrees: { x: 0, y: 0, z: 0 },
      scale: 1,
    },
  });
  expect(() => compileScene(ShotSchema.parse(raw), rate)).toThrow(
    /occluded by a static world proxy/,
  );
  raw.scene.camera.rigs[0].visibility = [
    { target: { kind: 'point', position: [8, 0, 1] } },
  ];
  expect(() => compileScene(ShotSchema.parse(raw), rate)).toThrow(
    /outside the camera frame/,
  );
  const policy = parseProjectManifest(input()).renderPolicy;
  expect(
    resolveShotRenderDimensions(
      { ...policy, qualityProfile: 'preview' },
      { width: 400, height: 300 },
    ),
  ).toEqual({ width: 400, height: 300 });
});
