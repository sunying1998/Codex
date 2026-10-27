// Keep provider credentials and implementations on the server. No model is enabled yet.
export type ReplacementInput = {
  projectId: string;
  sourceAssetId: string;
  referenceAssetIds: string[];
  start: number;
  end: number;
  mode: "face" | "head" | "outfit" | "body";
};
export interface ReplacementProvider {
  id: string;
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
    reason: "人物替换模型尚未接入；当前可上传、预览、选取片段并导出。",
  },
  export: {
    available: true,
    format: "mp4",
    maxSourceSeconds: 600,
    maxUploadMB: 512,
  },
  references: { available: true, maxCount: 8, maxUploadMB: 15 },
};
