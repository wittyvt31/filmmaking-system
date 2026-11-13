export interface Revision {
  id: string;
  createdAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  catalog: string;
  revisions: Revision[];
}

export interface AssetReference {
  assetId: string;
  version: string;
  type: string;
}

export interface Validation {
  issues: { path: string; message: string }[];
  shots?: number;
  frames?: number;
}

export interface Run {
  id: string;
  projectId: string;
  revisionId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted';
  createdAt: string;
  finishedAt?: string;
  error?: string;
  logs: string[];
  progress?: { completed: number; total: number };
  cacheHits?: { shots: number; assembly: boolean };
}

export interface Output {
  name: string;
  url: string;
  kind: 'image' | 'video' | 'file';
}

export interface AssetStudioIssue {
  path: string;
  message: string;
}

export interface AssetStudioValidation {
  valid: boolean;
  issues: AssetStudioIssue[];
  partCount?: number;
  meshCount?: number;
  jointCount?: number;
}

export interface AssetStudioAsset {
  assetId: string;
  version: string;
  contentHash: string;
  glbUrl: string;
  previewUrl?: string;
  partCount: number;
  jointCount: number;
}

export interface AssetStudioBuildResult {
  status: 'published' | 'reused';
  asset: AssetStudioAsset;
  preview: {
    status: 'rendered' | 'rejected';
    message?: string;
  };
}

export type { ProceduralAssetDefinition } from '@filmmaking/contracts';
