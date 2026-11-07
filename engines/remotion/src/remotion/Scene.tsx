import React from 'react';
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type { Shot } from '@filmmaking/contracts';

export interface SceneElement {
  id: string;
  role: 'background' | 'character' | 'prop';
  src: string;
  position: { x: number; y: number };
  scale: number;
  zIndex: number;
  animation: NonNullable<Shot['visualElements']>[number]['animation'];
}

export interface FontResource {
  family: string;
  src: string;
}

export interface PreparedShotProps {
  shot: Shot;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
  elements: SceneElement[];
  fonts: FontResource[];
  randomSeed: number;
}

function clampProgress(
  frame: number,
  startFrame: number,
  durationFrames: number,
): number {
  return interpolate(frame, [startFrame, startFrame + durationFrames], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.ease),
  });
}

function stableNumber(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function PlaceholderArt({ seed }: { seed: number }) {
  const palette = [
    ['#101d35', '#224b61', '#7caa9c'],
    ['#1c1734', '#534376', '#df9a71'],
    ['#112d2b', '#30756a', '#d2b778'],
    ['#352329', '#784d4d', '#dfb787'],
  ] as const;
  const colors = palette[seed % palette.length] ?? palette[0];
  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(145deg, ${colors[0]}, ${colors[1]})`,
      }}
    >
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 1920 1080"
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          <radialGradient id="placeholder-glow">
            <stop offset="0%" stopColor={colors[2]} stopOpacity="0.8" />
            <stop offset="100%" stopColor={colors[2]} stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle
          cx={450 + (seed % 700)}
          cy="330"
          r="480"
          fill="url(#placeholder-glow)"
        />
        <path
          d="M0 820 Q480 650 930 830 T1920 780 V1080 H0Z"
          fill="#101a26"
          fillOpacity="0.58"
        />
        <path
          d="M0 930 Q500 820 1000 940 T1920 900 V1080 H0Z"
          fill="#071016"
          fillOpacity="0.65"
        />
        <circle cx="1500" cy="250" r="7" fill={colors[2]} fillOpacity="0.8" />
        <circle cx="1260" cy="420" r="4" fill={colors[2]} fillOpacity="0.65" />
        <circle cx="350" cy="530" r="5" fill={colors[2]} fillOpacity="0.5" />
      </svg>
    </AbsoluteFill>
  );
}

function visualElementStyle(
  element: SceneElement,
  frame: number,
  width: number,
  height: number,
): React.CSSProperties {
  let opacity = 1;
  let xOffset = 0;
  let yOffset = 0;
  let animationScale = 1;
  const animation = element.animation;

  if (animation.type === 'fade-in') {
    opacity = clampProgress(
      frame,
      animation.startFrame,
      animation.durationFrames,
    );
  } else if (animation.type === 'slide-in') {
    const progress = clampProgress(
      frame,
      animation.startFrame,
      animation.durationFrames,
    );
    opacity = progress;
    const distance = Math.max(width, height) * 0.18 * (1 - progress);
    if (animation.direction === 'left') xOffset = -distance;
    if (animation.direction === 'right') xOffset = distance;
    if (animation.direction === 'up') yOffset = -distance;
    if (animation.direction === 'down') yOffset = distance;
  } else if (animation.type === 'float') {
    const elapsed = Math.max(0, frame - animation.startFrame);
    yOffset =
      Math.sin(elapsed * 0.08 + (stableNumber(element.id) % 628) / 100) *
      animation.amplitudePx;
  } else if (animation.type === 'pulse') {
    const phase = clampProgress(
      frame,
      animation.startFrame,
      animation.durationFrames,
    );
    const wave = (Math.sin(phase * Math.PI * 2) + 1) / 2;
    animationScale =
      animation.minimumScale +
      (animation.maximumScale - animation.minimumScale) * wave;
  }

  const widthFactor =
    element.role === 'character' ? 0.33 : element.role === 'prop' ? 0.2 : 1;
  const imageWidth =
    element.role === 'background' ? width : width * widthFactor * element.scale;
  const imageHeight =
    element.role === 'background'
      ? height
      : height * (element.role === 'character' ? 0.82 : 0.45) * element.scale;
  return {
    position: 'absolute',
    left: element.position.x * width,
    top: element.position.y * height,
    width: imageWidth,
    height: imageHeight,
    objectFit: element.role === 'background' ? 'cover' : 'contain',
    objectPosition: 'center bottom',
    transform: `translate(-50%, -50%) translate(${xOffset}px, ${yOffset}px) scale(${animationScale})`,
    transformOrigin: 'center bottom',
    opacity,
    zIndex: element.zIndex,
  };
}

export const PreparedShot: React.FC<PreparedShotProps> = ({
  shot,
  elements,
  fonts,
  randomSeed,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const camera = shot.composition.camera;
  let cameraScale = 1;
  let cameraX = 0;
  let cameraY = 0;

  if (camera?.type === 'zoom') {
    cameraScale = interpolate(
      frame,
      [camera.startFrame, camera.startFrame + camera.durationFrames],
      [camera.fromScale, camera.toScale],
      {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
        easing: Easing.inOut(Easing.ease),
      },
    );
  }
  if (camera?.type === 'pan') {
    const progress = clampProgress(
      frame,
      camera.startFrame,
      camera.durationFrames,
    );
    const x = camera.from.x + (camera.to.x - camera.from.x) * progress;
    const y = camera.from.y + (camera.to.y - camera.from.y) * progress;
    cameraX = (0.5 - x) * width * 0.1;
    cameraY = (0.5 - y) * height * 0.1;
  }

  const orderedElements = [...elements].sort(
    (left, right) =>
      Number(left.role !== 'background') -
        Number(right.role !== 'background') ||
      left.zIndex - right.zIndex ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
  const placeholderSeed = (stableNumber(shot.id) + randomSeed) >>> 0;

  return (
    <AbsoluteFill style={{ overflow: 'hidden', backgroundColor: '#101820' }}>
      {fonts.length > 0 && (
        <style>
          {fonts
            .map(
              (font) =>
                `@font-face{font-family:"${font.family}";src:url("${staticFile(font.src)}")}`,
            )
            .join('\n')}
        </style>
      )}
      <AbsoluteFill
        style={{
          transform: `translate(${cameraX}px, ${cameraY}px) scale(${cameraScale})`,
          transformOrigin: 'center center',
        }}
      >
        {orderedElements.length === 0 ? (
          <PlaceholderArt seed={placeholderSeed % 4} />
        ) : null}
        {orderedElements.map((element) => (
          <Img
            key={element.id}
            src={staticFile(element.src)}
            style={visualElementStyle(element, frame, width, height)}
          />
        ))}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
