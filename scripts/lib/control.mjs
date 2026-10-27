import fs from "node:fs";
import path from "node:path";
import { delay, readJson } from "./project.mjs";

export async function control(ctx, command = "status") {
  const state = readJson(path.join(ctx.runtime, "control.json"));
  if (!state) return null;
  if (
    state.protocol !== 1 ||
    state.root !== ctx.root ||
    !Number.isInteger(state.controlPort) ||
    typeof state.token !== "string"
  )
    throw new Error("本机运行状态文件格式不正确，未停止任何进程。");
  try {
    const response = await fetch(
      `http://127.0.0.1:${state.controlPort}/${command}`,
      {
        method: command === "stop" ? "POST" : "GET",
        headers: { Authorization: "Bearer " + state.token },
        signal: AbortSignal.timeout(2000),
      },
    );
    if (!response.ok) throw new Error("本机进程控制认证失败。");
    const result = await response.json();
    if (
      result.protocol !== 1 ||
      result.root !== ctx.root ||
      result.pid !== state.pid
    )
      throw new Error("进程身份不匹配，未停止任何进程。");
    return result;
  } catch (error) {
    if (
      error.cause?.code === "ECONNREFUSED" ||
      error.cause?.code === "ECONNRESET"
    )
      return null;
    throw error;
  }
}
export async function stopRuntime(ctx) {
  const state = await control(ctx);
  if (!state) return false;
  await control(ctx, "stop");
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    if (!(await control(ctx))) return true;
    await delay(200);
  }
  throw new Error("服务未在预期时间内停止，更新已暂停。");
}
export function removeOwnedState(file, token) {
  if (readJson(file)?.token === token) fs.rmSync(file, { force: true });
}
