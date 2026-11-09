import { ProjectManifestShapeSchema } from './project-manifest-shape.js';
import { validateManifestSceneInstructions } from './manifest-scene-validation.js';
import {
  validateManifestTimelinePlacements,
  validateManifestTimelineTransitions,
} from './manifest-timeline-validation.js';
import { z } from 'zod';

export const ProjectManifestSchema = ProjectManifestShapeSchema.superRefine(
  (manifest, context) => {
    const clipMaps = validateManifestTimelinePlacements(manifest, context);
    validateManifestSceneInstructions(manifest, context, clipMaps.clipsByShot);
    validateManifestTimelineTransitions(manifest, context, clipMaps);
  },
);

export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;
