export class ClientError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...options,
    headers: {
      ...(typeof options?.body === "string"
        ? { "Content-Type": "application/json" }
        : {}),
      ...options?.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !url.startsWith("/api/auth/"))
      window.dispatchEvent(new Event("session-expired"));
    throw new ClientError(data.error || "操作失败，请重试。", response.status);
  }
  return data as T;
}
export function uploadFile(
  projectId: string,
  file: File,
  kind: "source" | "reference",
  progress: (value: number) => void,
) {
  return new Promise<{ assetId: string; jobId: string }>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/api/projects/${projectId}/assets?kind=${kind}`);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable)
        progress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      try {
        const body = JSON.parse(request.responseText);
        if (request.status >= 200 && request.status < 300) resolve(body);
        else reject(new Error(body.error || "上传失败，请重试。"));
      } catch {
        reject(new Error("上传未完成，请重试。"));
      }
    };
    request.onerror = () => reject(new Error("网络中断，请重新上传。"));
    request.onabort = () => reject(new Error("上传已取消。"));
    const body = new FormData();
    body.append("file", file);
    request.send(body);
  });
}
export function formatTime(seconds: number | null | undefined) {
  if (!seconds || !Number.isFinite(seconds)) return "00:00";
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
}
export function bytes(value: number) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(value / 1024)} KB`;
}
export const message = (error: unknown) =>
  error instanceof Error ? error.message : "操作未完成，请重试。";
