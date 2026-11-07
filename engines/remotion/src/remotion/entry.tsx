import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { PreparedShot, type PreparedShotProps } from './Scene.js';

const defaultProps: PreparedShotProps = {
  shot: {
    id: 'placeholder',
    durationFrames: 1,
    visualDescription: 'Deterministic placeholder visual.',
    composition: {
      framing: 'Wide shot',
      subjectPlacement: 'Centered',
      cameraMovement: 'Static',
      instructions: [],
    },
    requiredAssets: [],
  },
  durationInFrames: 1,
  fps: 30,
  width: 1920,
  height: 1080,
  elements: [],
  fonts: [],
  randomSeed: 0,
};

const RemotionRoot: React.FC = () => (
  <Composition
    id="PreparedShot"
    component={PreparedShot as unknown as React.FC<Record<string, unknown>>}
    width={1920}
    height={1080}
    fps={30}
    durationInFrames={1}
    defaultProps={defaultProps}
    calculateMetadata={({ props }) => {
      const prepared = props as unknown as PreparedShotProps;
      return {
        width: prepared.width,
        height: prepared.height,
        fps: prepared.fps,
        durationInFrames: prepared.durationInFrames,
      };
    }}
  />
);

registerRoot(RemotionRoot);
