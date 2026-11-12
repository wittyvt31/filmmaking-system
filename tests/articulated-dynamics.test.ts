import { expect, it } from 'vitest';
import { ArticulatedAssemblySchema } from '@filmmaking/contracts';
import {
  evaluateArticulatedFrame,
  articulatedCollisionAllowed,
} from '../packages/scene/src/articulated-dynamics.js';
const pose = { position: [0, 0, 0], rotation: [1, 0, 0, 0] };
function assembly(kind = 'hinge') {
  return ArticulatedAssemblySchema.parse({
    version: 1,
    settings: { gravity: [0, 0, 0] },
    bodies: [
      { id: 'base', pose, mode: 'static', massKg: 1, inertiaKgM2: 1 },
      { id: 'moving', pose, mode: 'dynamic', massKg: 1, inertiaKgM2: 1 },
    ],
    joints: [
      {
        id: 'joint',
        kind,
        bodyA: 'base',
        bodyB: 'moving',
        minimum: kind === 'hinge' ? -1 : 0,
        maximum: kind === 'fixed' ? 0 : 1,
      },
    ],
  });
}
it('drives hinges and sliders deterministically within limits', () => {
  for (const kind of ['hinge', 'slider']) {
    const a = assembly(kind);
    a.joints[0]!.drive = { target: 0.5, stiffness: 10, maxRate: 1 };
    const result = evaluateArticulatedFrame(a, 30, 30);
    expect(result.success).toBe(true);
    const state = result.states['moving']!;
    expect(
      kind === 'slider'
        ? state.pose.position[0]
        : Math.abs(state.pose.rotation[1]),
    ).toBeGreaterThan(0.1);
    expect(evaluateArticulatedFrame(a, 30, 30)).toEqual(result);
  }
});
it('preserves authored bodies and reports incompatible fixed joints', () => {
  const a = assembly('fixed');
  a.bodies[1]!.mode = 'static';
  a.bodies[1]!.pose.position = [2, 0, 0];
  const result = evaluateArticulatedFrame(a, 1, 30);
  expect(result.success).toBe(false);
  expect(result.residuals[0]!.position).toBe(2);
  expect(result.states['moving']!.pose.position).toEqual([2, 0, 0]);
});
it('transfers kinematic velocity on release and filters connected pairs', () => {
  const a = assembly();
  a.joints = [];
  const b = a.bodies[1]!;
  b.mode = 'kinematic';
  b.authored = [
    {
      frame: 0,
      pose: { ...pose, position: [0, 0, 0], rotation: [1, 0, 0, 0] },
    },
    { frame: 10, pose: { position: [1, 0, 0], rotation: [1, 0, 0, 0] } },
  ];
  b.transitions = [{ frame: 10, mode: 'dynamic' }];
  const result = evaluateArticulatedFrame(a, 20, 30);
  expect(result.states['moving']!.pose.position[0]).toBeCloseTo(2, 6);
  expect(articulatedCollisionAllowed(a, 'base', 'moving')).toBe(true);
  expect(articulatedCollisionAllowed(assembly(), 'base', 'moving')).toBe(false);
});
it('constrains ball rotation and rejects invalid references', () => {
  const a = assembly('ball');
  a.bodies[1]!.loads = [
    { startFrame: 0, endFrame: 30, force: [0, 0, 0], torque: [50, 20, 0] },
  ];
  const result = evaluateArticulatedFrame(a, 15, 30);
  expect(result.success).toBe(true);
  expect(result.residuals[0]!.angle).toBeLessThan(0.001);
  expect(() =>
    ArticulatedAssemblySchema.parse({
      ...a,
      joints: [{ ...a.joints[0], bodyB: 'missing' }],
    }),
  ).toThrow();
});
