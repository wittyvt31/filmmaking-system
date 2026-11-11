import type {
  CompiledWorld,
  Locomotion,
  MotionVector,
  PreparedCharacter,
  Rational,
  RigidTransform,
  SampledSkeletalMotion,
  SpatialConstraint,
} from '@filmmaking/contracts';
import { mixVector, quaternion, slerp } from './motion-math.js';
import { composeTransform, blendTransform } from './rigid-transforms.js';
import { forwardKinematics } from './spatial-constraints.js';
import { locomotionTerrain } from './locomotion-terrain.js';

const smooth = (t: number) => t * t * (3 - 2 * t);
const sides = ['L', 'R'] as const;

export function sampleLocomotion(
  character: PreparedCharacter,
  path: Locomotion | undefined,
  motion: SampledSkeletalMotion | undefined,
  frames: number,
  rate: Rational,
  world?: CompiledWorld,
): {
  motion: SampledSkeletalMotion | undefined;
  contacts: SpatialConstraint[];
} {
  if (!path) return { motion, contacts: [] };
  if (character.parentId)
    throw new TypeError(
      'Locomotion requires an unparented character: ' + character.id,
    );
  if (motion?.rootPosition || motion?.rootRotation || motion?.rootScale)
    throw new TypeError(
      'Locomotion conflicts with authored root motion: ' + character.id,
    );
  if (
    path.waypoints.at(-1)!.frame >= frames ||
    frames * (9 + (motion?.joints.length ?? 0)) > 250_000
  )
    throw new TypeError(
      'Locomotion exceeds shot duration or motion sample budget: ' +
        character.id,
    );
  const terrain = locomotionTerrain(
    world,
    path.floorHeight,
    path.maxStepHeight,
  );
  const rest = forwardKinematics(character, new Map());
  const scale = character.transform.scale;
  const height = character.source.body.height * scale;
  const root = (waypoint: Locomotion['waypoints'][number]): RigidTransform => ({
    position: waypoint.position,
    rotation: quaternion([0, 0, waypoint.yawDegrees]),
  });
  const roots: RigidTransform[] = [];
  const crouch: number[] = [];
  const swings: {
    side: (typeof sides)[number];
    start: number;
    end: number;
    landing: number;
  }[] = [];
  let nextSide = 0;
  for (let i = 1; i < path.waypoints.length; i++) {
    const from = path.waypoints[i - 1]!,
      to = path.waypoints[i]!;
    const duration = to.frame - from.frame;
    const distance = Math.hypot(
      ...to.position.map((v, j) => v - from.position[j]!),
    );
    const turn = Math.abs(
      ((to.yawDegrees - from.yawDegrees + 540) % 360) - 180,
    );
    const moving = distance > 1e-8 || turn > 1e-8;
    for (let frame = from.frame; frame <= to.frame; frame++) {
      const u = (frame - from.frame) / duration;
      const t = to.easing === 'smooth' ? smooth(u) : u;
      roots[frame] = blendTransform(root(from), root(to), t);
      crouch[frame] = moving
        ? 0.055 * height * smooth(Math.min(1, 4 * u, 4 * (1 - u)))
        : 0;
    }
    if (!moving) continue;
    const steps = Math.max(
      2,
      Math.ceil(
        (distance / path.strideMeters) * (to.easing === 'smooth' ? 1.5 : 1),
      ),
      Math.ceil(turn / 30),
      Math.round(
        (duration * rate.denominator) / rate.numerator / path.stepSeconds,
      ),
    );
    if (steps * 2 > duration)
      throw new TypeError(
        `Locomotion segment ending at frame ${to.frame} is too fast for the configured gait`,
      );
    for (let step = 0; step < steps; step++) {
      const start = from.frame + Math.round((step * duration) / steps);
      const end = from.frame + Math.round(((step + 1) * duration) / steps);
      swings.push({
        side: sides[nextSide]!,
        start,
        end,
        landing:
          step >= steps - 2
            ? to.frame
            : Math.min(to.frame, end + Math.floor((end - start) / 2)),
      });
      nextSide = 1 - nextSide;
    }
  }
  while (roots.length < frames) {
    roots.push(roots.at(-1)!);
    crouch.push(0);
  }
  for (const [frame, pose] of roots.entries()) {
    const previous = roots[Math.max(0, frame - 1)]!.position;
    const distance = Math.hypot(
      ...pose.position.map((v, j) => v - previous[j]!),
    );
    const checks = Math.max(1, Math.ceil(distance / 0.04));
    if (checks > 100)
      throw new TypeError(
        `Locomotion displacement exceeds collision sampling budget at frame ${frame}`,
      );
    for (let i = 1; i <= checks; i++) {
      const point = mixVector(previous, pose.position, i / checks);
      const ground = terrain.ground(point);
      const obstacle = terrain.obstacle(
        [point[0], point[1], Math.max(point[2], ground)],
        height,
        path.obstacleRadius,
      );
      if (obstacle)
        throw new TypeError(
          `Locomotion path blocked by ${obstacle} at frame ${frame}`,
        );
    }
  }
  const contacts: SpatialConstraint[] = [];
  for (const side of sides) {
    const id = 'foot.' + side;
    const bone = rest.get(id)!;
    const standingFoot = (frame: number): RigidTransform => {
      const pose = composeTransform(roots[frame]!, {
        position: bone.tail.map((v) => v * scale) as MotionVector,
        rotation: bone.rotation,
      });
      const ground = terrain.ground([
        pose.position[0],
        pose.position[1],
        roots[frame]!.position[2],
      ]);
      pose.position[2] = ground + bone.tail[2] * scale;
      return pose;
    };
    const add = (
      startFrame: number,
      endFrame: number,
      pose: RigidTransform,
    ) => {
      if (endFrame < startFrame) return;
      contacts.push({
        id: `locomotion.${side}.${startFrame}`,
        effector: id,
        chainRoot: 'thigh.' + side,
        startFrame,
        endFrame,
        target: pose.position,
        orientation: pose.rotation,
        space: 'world',
        fadeFrames: 0,
        tolerance: 0.007,
        angularTolerance: 0.045,
        priority: 90,
      });
    };
    let planted = standingFoot(0);
    let cursor = 0;
    for (const swing of swings.filter((s) => s.side === side)) {
      const landing = standingFoot(swing.landing);
      add(cursor, swing.start, planted);
      for (let frame = swing.start + 1; frame < swing.end; frame++) {
        const t = (frame - swing.start) / (swing.end - swing.start);
        const pose = blendTransform(planted, landing, smooth(t));
        pose.position[2] += path.swingHeight * Math.sin(Math.PI * t) ** 2;
        const obstacle = terrain.obstacle(pose.position, 0.05, 0.025);
        if (obstacle)
          throw new TypeError(
            `Locomotion foot ${side} blocked by ${obstacle} at frame ${frame}`,
          );
        add(frame, frame, pose);
      }
      cursor = swing.end;
      planted = landing;
    }
    add(cursor, frames - 1, planted);
  }
  const rootRotation = roots.map((p) => p.rotation);
  for (let i = 1; i < rootRotation.length; i++)
    rootRotation[i] = slerp(rootRotation[i - 1]!, rootRotation[i]!, 1);
  return {
    motion: {
      ...(motion ?? { joints: [] }),
      rootRotation,
      rootPosition: roots.map(({ position }, i) => [
        position[0],
        position[1],
        position[2] - crouch[i]!,
      ]),
    },
    contacts,
  };
}
