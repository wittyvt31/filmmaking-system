import type {
  MotionLayer,
  MotionVector,
  SkeletalClip,
} from '@filmmaking/contracts';

export function primitiveClip(
  layer: MotionLayer,
  rig: SkeletalClip['rig'],
): SkeletalClip {
  const source = layer.source;
  if (source.kind !== 'primitive')
    throw new TypeError('Expected a procedural motion source');
  const { primitive, duration } = source;
  const keys = (value: MotionVector) => [
    {
      time: 0,
      value: [0, 0, 0] as MotionVector,
      interpolation: 'ease-in-out' as const,
    },
    { time: duration, value, interpolation: 'linear' as const },
  ];
  const clip: SkeletalClip = {
    id: layer.id,
    rig,
    duration,
    rootPosition: [],
    joints: [],
  };
  switch (primitive.kind) {
    case 'head-turn':
      clip.joints.push({
        joint: 'head',
        keys: keys([0, primitive.degrees, 0]),
      });
      break;
    case 'torso-turn':
      clip.joints.push({
        joint: 'chest',
        keys: keys([0, primitive.degrees, 0]),
      });
      break;
    case 'arm-gesture': {
      const side = primitive.side === 'left' ? 'L' : 'R';
      clip.joints.push(
        { joint: 'upper_arm.' + side, keys: keys(primitive.upperArm) },
        { joint: 'forearm.' + side, keys: keys(primitive.forearm) },
      );
      break;
    }
    case 'body-position':
      clip.rootPosition = keys(primitive.offset);
      break;
  }
  return clip;
}
