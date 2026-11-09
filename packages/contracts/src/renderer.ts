import type { CompiledSceneInstruction } from './compiled-scene.js';
import type { Rational, RenderPolicy } from './render-policy.js';
import type { Shot } from './shots.js';

export type RenderArtifactType =
  'video/mp4' | 'image-sequence/png' | 'image/png';

export interface RendererIdentity {
  id: string;
  version: string;
}

export interface RendererCapabilities {
  identity: RendererIdentity;
  artifactTypes: readonly RenderArtifactType[];
  videoCodecs: readonly string[];
  pixelFormats: readonly string[];
  colorProfiles: readonly string[];
}

export interface RendererAssetInput {
  assetId: string;
  version: string;
  type: string;
  sourceUri: string;
  localPath: string;
  contentHash: string;
  metadata: Record<string, unknown>;
}

export type RenderArtifactRequest =
  | { type: 'video/mp4'; outputPath: string }
  | { type: 'image-sequence/png'; outputDirectory: string }
  | { type: 'image/png'; outputPath: string; frame: number };

export interface RenderShotRequest {
  jobId: string;
  shot: Shot;
  scene?: CompiledSceneInstruction;
  assets: readonly RendererAssetInput[];
  settings: RenderPolicy;
  artifact: RenderArtifactRequest;
  randomSeed: number;
  cacheDirectory: string;
  receiptPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RenderOutputChecksum {
  path: string;
  sha256: string;
  bytes: number;
}

export interface RenderReceiptBase {
  jobId: string;
  shotId: string;
  renderer: RendererIdentity;
  fingerprint: string;
  startedAt: string;
  completedAt: string;
  outputPaths: string[];
  outputChecksums: RenderOutputChecksum[];
  logs: string[];
  metrics: Record<string, number | string | boolean>;
  requestedRenderer?: string;
  actualRenderer?: string;
  fallbackUsed?: boolean;
  degraded?: boolean;
  warnings?: string[];
  completedWithWarning?: boolean;
}

export interface SuccessfulRenderReceipt extends RenderReceiptBase {
  status: 'success';
  artifactType: RenderArtifactType;
}

export interface FailedRenderReceipt extends RenderReceiptBase {
  status: 'failure';
  error: {
    code: RendererErrorCode;
    message: string;
    retryable: boolean;
  };
}

export type RenderShotResult =
  | { status: 'success'; receipt: SuccessfulRenderReceipt; cacheHit: boolean }
  | {
      status: 'failure';
      receipt: FailedRenderReceipt;
      error: FailedRenderReceipt['error'];
    };

export type RendererErrorCode =
  | 'INVALID_INSTRUCTIONS'
  | 'MISSING_ASSET'
  | 'UNSUPPORTED_ARTIFACT'
  | 'UNSUPPORTED_SETTINGS'
  | 'RENDER_CRASHED'
  | 'TIMEOUT'
  | 'INTERRUPTED'
  | 'INCOMPLETE_OUTPUT'
  | 'CACHE_ERROR'
  | 'IO_ERROR';

export interface ArtifactInspectionRequest {
  artifactType: RenderArtifactType;
  path: string;
  expectedFrameCount?: number;
  expectedWidth?: number;
  expectedHeight?: number;
  expectedFrameRate?: Rational;
  expectedCodec?: string;
  expectedPixelFormat?: string;
  expectedColorProfile?: string;
}

export interface ArtifactInspection {
  artifactType: RenderArtifactType;
  outputChecksums: RenderOutputChecksum[];
  frameCount?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  codec?: string;
  pixelFormat?: string;
  colorProfile?: string;
}

export type RendererOperationResult<T> =
  | { status: 'success'; value: T }
  | {
      status: 'failure';
      error: { code: RendererErrorCode; message: string; retryable: boolean };
    };

export interface RendererAdapter {
  readonly identity: RendererIdentity;
  inspectCapabilities(): Promise<RendererOperationResult<RendererCapabilities>>;
  renderShot(request: RenderShotRequest): Promise<RenderShotResult>;
  inspectArtifact(
    request: ArtifactInspectionRequest,
  ): Promise<RendererOperationResult<ArtifactInspection>>;
}
