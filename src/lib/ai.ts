// Keep provider credentials and implementations on the server. No model is enabled yet.
// Face-only v1. Outfit editing will have a separate input and preservation policy.
export type ReplacementInput = {
  projectId: string;
  sourceAssetId: string;
  referenceAssetId: string;
  start: number;
  end: number;
  mode: "face";
};
export interface ReplacementProvider {
  id: string;
  mode: "face";
  submit(
    input: ReplacementInput,
    signal: AbortSignal,
  ): Promise<{ externalId: string }>;
  poll(
    externalId: string,
    signal: AbortSignal,
  ): Promise<{
    status: "queued" | "running" | "succeeded" | "failed";
    progress?: number;
    outputUrl?: string;
    error?: string;
  }>;
  cancel(externalId: string): Promise<void>;
}
export const capabilities = {
  replacement: {
    available: false,
    mode: "face",
    reason: "视频面部替换服务尚未接入；当前导出仍保留原人物。",
  },
  export: {
    available: true,
    format: "mp4",
    maxSourceSeconds: 600,
    maxUploadMB: 512,
  },
  references: { available: true, maxCount: 8, maxUploadMB: 15 },
};
