import { z } from 'zod';
import { AssetVersionReferenceSchema } from './identifiers.js';
import type { Rational } from './render-policy.js';
import type { CharacterAction } from './motion.js';
import { ShotSceneSchema } from './scene.js';

export interface CompiledSceneInstruction {
  version: string;
  shotId: string;
  durationFrames: number;
  frameRate: Rational;
  animationLibraryVersion: string;
  style: {
    id: 'charcoal_horror';
    version: string;
    palette: {
      shadow: readonly number[];
      graphite: readonly number[];
      paper: readonly number[];
    };
    lighting: {
      keyColor: readonly number[];
      keyEnergy: number;
      keySize: number;
      keyPosition: readonly number[];
      ambientFill: number;
    };
    grainScale: number;
    grainStrength: number;
    vignetteStrength: number;
    hazeStrength: number;
    paperFiberScale: number;
    paperOpacity: number;
    lineBoilStrength: number;
    boilFps?: number;
    edgeBreakup?: number;
    edgeSoftness?: number;
    shadowSmudge?: number;
    graphiteSheen?: number;
    contrastCurve?: readonly number[];
    paperWhitePoint?: number;
    hazeDrift?: number;
    dustDensity?: number;
    shadows?: 'off' | 'contact' | 'soft-cast';
    glow?: boolean;
    finalGrade?: boolean;
  };
  environment: z.infer<typeof AssetVersionReferenceSchema>;
  groups: z.infer<typeof ShotSceneSchema>['groups'];
  layers: z.infer<typeof ShotSceneSchema>['layers'];
  characters: z.infer<typeof ShotSceneSchema>['characters'];
  props: z.infer<typeof ShotSceneSchema>['props'];
  lights: z.infer<typeof ShotSceneSchema>['lights'];
  camera: z.infer<typeof ShotSceneSchema>['camera'];
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
  }[];
  sha256: string;
}
