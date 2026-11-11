import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MotionLayerSchema,
  ProjectManifestSchema,
  RiggedCharacterSchema,
  SkeletalClipSchema,
} from '@filmmaking/contracts';
import {
  compileScene,
  motionLibrary,
  prepareCharacter,
  sampleCharacterMotion,
} from '@filmmaking/scene';
import { ease, quaternion, slerp } from '../packages/scene/src/motion-math.js';

const rig = { profile: 'FilmieHumanoid', version: 1 };
const fps = { numerator: 30, denominator: 1 };
const reference = ProjectManifestSchema.parse(
  JSON.parse(readFileSync('examples/humanoid-animation/manifest.json', 'utf8')),
);
const actor = () =>
  RiggedCharacterSchema.parse(reference.shots[0]!.scene!.characters[0]);
const clip = (id: string, degrees: number) =>
  SkeletalClipSchema.parse({
    id,
    rig,
    duration: 1,
    joints: [
      {
        joint: 'head',
        keys: [
          { time: 0, value: [0, 0, 0] },
          { time: 1, value: [0, degrees, 0] },
        ],
      },
    ],
  });
const layer = (clipId: string, extra: Record<string, unknown> = {}) =>
  MotionLayerSchema.parse({
    id: clipId,
    startFrame: 0,
    endFrame: 60,
    source: { kind: 'clip', clipId },
    ...extra,
  });
const angle = (rotation: readonly number[]) =>
  (2 * Math.atan2(rotation[2]!, rotation[0]!) * 180) / Math.PI;

describe('skeletal motion sampling', () => {
  it('takes the shortest quaternion arc and applies configured easing', () => {
    const middle = slerp(
      quaternion([0, 170, 0]),
      quaternion([0, -170, 0]),
      0.5,
    );
    expect(Math.abs(angle(middle))).toBeCloseTo(180);
    expect(Math.hypot(...middle)).toBeCloseTo(1);
    expect(ease(0.25, 'ease-in')).toBeCloseTo(0.0625);
    expect(ease(0.25, 'hold')).toBe(0);
    expect(ease(0.5, 'linear', [0.25, 0.1, 0.25, 1])).toBeCloseTo(0.8024, 3);
  });

  it('uses elapsed seconds for speed and agrees at shared times across frame rates', () => {
    const prepared = prepareCharacter(actor(), 61);
    const clips = motionLibrary([clip('turn', 60)]);
    const at30 = sampleCharacterMotion(
      prepared,
      [layer('turn', { speed: 2 })],
      clips,
      61,
      fps,
    )!;
    const at60 = sampleCharacterMotion(
      prepared,
      [layer('turn', { speed: 2, endFrame: 120 })],
      clips,
      121,
      { numerator: 60, denominator: 1 },
    )!;
    expect(at30.joints[0]!.rotations[6]).toEqual(at60.joints[0]!.rotations[12]);
    expect(angle(at30.joints[0]!.rotations[6]!)).toBeCloseTo(24);
    expect(angle(at30.joints[0]!.rotations[30]!)).toBeCloseTo(60);
  });

  it('crossfades compatible layers, applies masks, and gives authored tracks precedence', () => {
    const source = actor();
    const clips = motionLibrary([clip('left', 60), clip('right', -60)]);
    const layers = [
      layer('left', { fadeOut: 1, mask: ['head'] }),
      layer('right', { startFrame: 30, fadeIn: 1 }),
    ];
    const prepared = prepareCharacter(source, 61);
    const sampled = sampleCharacterMotion(prepared, layers, clips, 61, fps)!;
    expect(
      sampleCharacterMotion(prepared, [...layers].reverse(), clips, 61, fps),
    ).toEqual(sampled);
    expect(angle(sampled.joints[0]!.rotations[30]!)).toBeCloseTo(60);
    expect(angle(sampled.joints[0]!.rotations[45]!)).toBeCloseTo(15);
    expect(angle(sampled.joints[0]!.rotations[60]!)).toBeCloseTo(-60);
    source.poses.joints.push({
      joint: 'head',
      keys: [{ frame: 0, rotationDegrees: [0, 12, 0], interpolation: 'hold' }],
    });
    const override = sampleCharacterMotion(
      prepareCharacter(source, 61),
      layers,
      clips,
      61,
      fps,
    )!;
    expect(angle(override.joints[0]!.rotations[45]!)).toBeCloseTo(12);
    expect(() =>
      sampleCharacterMotion(
        prepared,
        [layer('left', { mask: ['chest'] })],
        clips,
        61,
        fps,
      ),
    ).toThrow(/mask/);
  });

  it('rejects conflicts, out-of-range fades, open loop seams and invalid composed limits', () => {
    const prepared = prepareCharacter(actor(), 61);
    const clips = motionLibrary([clip('one', 55), clip('two', 55)]);
    const run = (layers: ReturnType<typeof layer>[]) =>
      sampleCharacterMotion(prepared, layers, clips, 61, fps);
    expect(() => run([layer('one'), layer('two')])).toThrow(
      /Conflicting replacement/,
    );
    expect(() => run([layer('one', { fadeOut: 3 })])).toThrow(/fades/);
    expect(() => run([layer('one', { loop: true })])).toThrow(
      /matching first and last/,
    );
    expect(() =>
      run([layer('one'), layer('two', { blend: 'additive' })]),
    ).toThrow(/joint limits/);
    expect(() => run([layer('missing')])).toThrow(/unknown clip/);
  });

  it('samples closed loops repeatedly and compiles the reference deterministically', () => {
    const looping = clip('loop', 48);
    looping.joints[0]!.keys[1]!.time = 0.5;
    looping.joints[0]!.keys.push({
      time: 1,
      value: [0, 0, 0],
      interpolation: 'linear',
    });
    const sampled = sampleCharacterMotion(
      prepareCharacter(actor(), 61),
      [layer('loop', { loop: true })],
      motionLibrary([looping]),
      61,
      fps,
    )!;
    expect(sampled.joints[0]!.rotations[15]).toEqual(
      sampled.joints[0]!.rotations[45],
    );
    const result = compileScene(reference.shots[0]!, fps);
    expect(result).toEqual(compileScene(reference.shots[0]!, fps));
    expect(result.characters[0]).toMatchObject({
      sampledMotion: {
        joints: expect.arrayContaining([
          expect.objectContaining({ joint: 'head' }),
          expect.objectContaining({ joint: 'chest' }),
          expect.objectContaining({ joint: 'upper_arm.L' }),
        ]),
      },
    });
  });
});
