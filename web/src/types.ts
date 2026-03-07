export type {
  FolderPayload,
  FolderPreview,
  FolderPreviewBatchError,
  FolderPreviewBatchInput,
  FolderPreviewBatchOutput,
  MediaItem,
  MediaKind,
} from "@tmv/shared-types";

export type PreviewDiagEventPhase =
  | "enqueue"
  | "request"
  | "response"
  | "apply"
  | "error"
  | "timeout";

export interface PreviewDiagEvent {
  ts: number;
  phase: PreviewDiagEventPhase;
  batchSize: number;
  paths: string[];
  status?: number;
  err?: string;
  requestId?: string;
}

export interface PreviewDiagEventsInput {
  events: PreviewDiagEvent[];
}

export type EffectsMode = "auto" | "off" | "full";
export type EffectsRenderer = "canvas2d" | "webgpu";

export interface PerfDiagEvent {
  ts: number;
  fpsEstimate: number;
  longTaskCount10s: number;
  visibleCards: number;
  effectsMode: EffectsMode;
  renderer: EffectsRenderer;
  note?: string;
}

export interface PerfDiagEventsInput {
  events: PerfDiagEvent[];
}
