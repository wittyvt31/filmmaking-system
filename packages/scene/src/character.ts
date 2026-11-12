import {
  compareStrings,
  findRigProfile,
  type PreparedCharacter,
  type RiggedCharacter,
} from '@filmmaking/contracts';

type Point = PreparedCharacter['bones'][number]['head'];

export function prepareCharacter(
  character: RiggedCharacter,
  durationFrames: number,
): PreparedCharacter {
  const profile = findRigProfile(character.rig.profile, character.rig.version);
  if (!profile) throw new TypeError('Unsupported character rig');
  if (
    character.morphs?.some(
      (track) => track.keys.at(-1)!.frame >= durationFrames,
    )
  )
    throw new TypeError(
      'Morph keyframe is outside the shot for character ' + character.id,
    );
  const { height, shoulderWidth, hipWidth, legLength, armLength } =
    character.source.body;
  const withBaseline = <T extends { frame: number }>(
    keys: T[],
    initial: NoInfer<T>,
  ): T[] => {
    if ((keys.at(-1)?.frame ?? 0) >= durationFrames)
      throw new TypeError(
        'Pose keyframe is outside the shot for character ' + character.id,
      );
    return keys[0] && keys[0].frame > 0 ? [initial, ...keys] : keys;
  };
  const point = (x: number, y: number, z: number): Point => [
    x * height,
    y * height,
    z * height,
  ];
  const pelvis = point(0, 0, legLength);
  const spine = point(0, 0, legLength + (0.82 - legLength) * 0.28);
  const chest = point(0, 0, legLength + (0.82 - legLength) * 0.61);
  const neck = point(0, 0, 0.82);
  const head = point(0, 0, 0.875);
  const rest = new Map<string, [Point, Point]>([
    ['pelvis', [pelvis, spine]],
    ['spine', [spine, chest]],
    ['chest', [chest, neck]],
    ['neck', [neck, head]],
    ['head', [head, point(0, 0, 1)]],
  ]);
  for (const side of ['L', 'R'] as const) {
    const sign = side === 'L' ? 1 : -1;
    const shoulder = (distance: number) =>
      point(
        sign * (shoulderWidth / 2 + distance * 0.42),
        0,
        0.81 - distance * Math.sqrt(1 - 0.42 ** 2),
      );
    const elbow = shoulder(armLength * 0.43);
    const wrist = shoulder(armLength * 0.82);
    const hip = point((sign * hipWidth) / 2, 0, legLength);
    const knee = point((sign * hipWidth) / 2, -0.014, (legLength + 0.065) / 2);
    const ankle = point((sign * hipWidth) / 2, 0, 0.065);
    rest.set('upper_arm.' + side, [shoulder(0), elbow]);
    rest.set('forearm.' + side, [elbow, wrist]);
    rest.set('hand.' + side, [wrist, shoulder(armLength)]);
    rest.set('thigh.' + side, [hip, knee]);
    rest.set('shin.' + side, [knee, ankle]);
    rest.set('foot.' + side, [
      ankle,
      point((sign * hipWidth) / 2, -0.105, 0.025),
    ]);
  }
  return {
    id: character.id,
    ...(character.parentId ? { parentId: character.parentId } : {}),
    transform: character.transform,
    rig: character.rig,
    source: character.source,
    ...(character.deformation ? { deformation: character.deformation } : {}),
    ...(character.morphs?.length
      ? {
          morphs: [...character.morphs].sort(
            (a, b) =>
              compareStrings(a.mesh, b.mesh) ||
              compareStrings(a.target, b.target),
          ),
        }
      : {}),
    bones: profile.joints.map((joint) => {
      const authored =
        character.source.kind === 'imported'
          ? character.source.restSkeleton?.[joint.id]
          : undefined;
      if (authored) return { ...joint, ...authored };
      const segment = rest.get(joint.id);
      if (!segment) throw new Error('No rest definition for joint ' + joint.id);
      return { ...joint, head: segment[0], tail: segment[1] };
    }),
    poses: {
      root: withBaseline(character.poses.root, {
        frame: 0,
        transform: character.transform,
        interpolation: 'hold',
      }),
      joints: character.poses.joints
        .map((track) => ({
          joint: track.joint,
          keys: withBaseline(track.keys, {
            frame: 0,
            rotationDegrees: [0, 0, 0],
            interpolation: 'hold',
          }),
        }))
        .sort((a, b) => compareStrings(a.joint, b.joint)),
    },
  };
}
