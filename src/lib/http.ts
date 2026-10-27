import { NextResponse } from "next/server";
import { ZodError } from "zod";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host") || new URL(request.url).host;
  if (!origin || request.headers.get("sec-fetch-site") === "cross-site")
    throw new ApiError(403, "请求来源验证失败，请从网站内操作。");
  try {
    const incoming = new URL(origin);
    if (
      process.env.APP_ORIGIN
        ? incoming.origin !== new URL(process.env.APP_ORIGIN).origin
        : incoming.host !== host ||
          !["http:", "https:"].includes(incoming.protocol)
    ) {
      throw new Error("Origin mismatch");
    }
  } catch {
    throw new ApiError(403, "请求来源验证失败，请从网站内操作。");
  }
}
export function endpoint(
  fn: (request: Request) => Promise<Response> | Response,
) {
  return async (request: Request) => {
    try {
      return await fn(request);
    } catch (error) {
      if (error instanceof ApiError)
        return NextResponse.json(
          { error: error.message },
          { status: error.status },
        );
      if (error instanceof ZodError || error instanceof SyntaxError)
        return NextResponse.json(
          { error: "输入格式有误，请检查后重试。" },
          { status: 400 },
        );
      console.error(
        "API operation failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
      return NextResponse.json(
        { error: "操作未完成，请重试或查看服务日志。" },
        { status: 500 },
      );
    }
  };
}
export async function readJson(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "请求内容为空。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 16_384) {
      await reader.cancel();
      throw new ApiError(413, "请求内容过大。");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
