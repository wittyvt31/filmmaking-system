import { z } from 'zod';
import { AssetVersionReferenceSchema } from './identifiers.js';
import type { Rational } from './render-policy.js';
import type { CharacterAction } from './motion.js';
import { ShotSceneSchema } from './scene.js';
import type { CompiledWorld } from './world.js';
import type { StyleDefinition, VisualSettings } from './style.js';
import type { RigidTransform } from './interactions.js';
import type { PhysicsSimulation } from './physics.js';
import type { PreparedCharacter, SceneCharacter } from './character.js';
import type { CompiledCinematography } from './cinematography.js';
import type { SecondaryMotionFrame } from './secondary-motion.js';

export interface CompiledSceneInstruction {
  version: string;
  shotId: string;
  durationFrames: number;
  frameRate: Rational;
  animationLibraryVersion: string;
  style: StyleDefinition & { parameters?: Readonly<Record<string, unknown>> };
  visualSettings?: VisualSettings;
  environment?: z.infer<typeof AssetVersionReferenceSchema>;
  world?: CompiledWorld;
  physics?: PhysicsSimulation;
  objectMotion?: { objectId: string; poses: RigidTransform[] }[];
  articulatedMotion?: {
    objectId: string;
    controls: {
      id: string;
      keys: { frame: number; value: number }[];
    }[];
  }[];
  secondaryMotion?: {
    ownerId: string;
    bindings: {
      nodeId: string;
      target: 'root' | 'control';
      space: 'world' | 'local';
    }[];
    frames: SecondaryMotionFrame[];
  }[];
  characters: (
    Extract<SceneCharacter, { asset: unknown }> | PreparedCharacter
  )[];
  props: z.infer<typeof ShotSceneSchema>['props'];
  lights: z.infer<typeof ShotSceneSchema>['lights'];
  camera: z.infer<typeof ShotSceneSchema>['camera'];
  cinematography?: CompiledCinematography;
  cameraKeyframes: {
    frame: number;
    distance: number;
    position: { x: number; y: number; z: number };
    target: { x: number; y: number; z: number };
    focalLength: number;
  }[];
  actions: {
    characterId: string;
    action: CharacterAction;
    interval: { startFrame: number; endFrame: number };
  }[];
  motionCurves: {
    characterId: string;
    control: string;
    channel: 'location' | 'rotation' | 'scale';
    frame: number;
    value: readonly number[];
    blendMode: 'replace' | 'additive';
    interpolation?:
      'ease-in' | 'ease-out' | 'ease-in-out' | 'cubic-bezier' | 'hold';
    bezier?: readonly [number, number, number, number];
  }[];
  sha256: string;
}
