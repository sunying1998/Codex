import { execFileSync } from "node:child_process";

export const DIRECT_GIT_OPTIONS = [
  "-c",
  "http.proxy=",
  "-c",
  "http.https://github.com/.proxy=",
  "-c",
  "http.https://github.com/sunying1998/Codex.git.proxy=",
  "-c",
  "http.https://github.com/sunying1998/Codex.git/.proxy=",
  "-c",
  "remote.origin.proxy=",
  "-c",
  "http.sslVerify=true",
  "-c",
  "http.https://github.com/.sslVerify=true",
  "-c",
  "http.https://github.com/sunying1998/Codex.git.sslVerify=true",
  "-c",
  "http.https://github.com/sunying1998/Codex.git/.sslVerify=true",
];
export function unreachableLocalProxy(message) {
  const text = String(message);
  if (
    /authentication|certificate|\bSSL\b|\bTLS\b|CONNECT tunnel failed|returned error:\s*\d{3}|HTTP\/\S+\s+\d{3}/i.test(
      text,
    )
  )
    return false;
  return (
    /(?:over proxy|proxy(?: server)?(?: at| to)?)[^\r\n]*(?:127\.0\.0\.1|localhost|\[?::1\]?)/i.test(
      text,
    ) &&
    /could not connect|couldn't connect|connection refused|failed to connect/i.test(
      text,
    )
  );
}
export function directEnvironment(environment) {
  const result = { ...environment };
  for (const name of Object.keys(result))
    if (["http_proxy", "https_proxy", "all_proxy"].includes(name.toLowerCase()))
      delete result[name];
  return result;
}
export function safeGitError(value) {
  return String(value)
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]+)?@/g, "$1[认证信息]@")
    .trim();
}
export function executeGit(
  root,
  args,
  {
    platform = process.platform,
    environment = process.env,
    execute = execFileSync,
    log = console.log,
  } = {},
) {
  const network = args.some((arg) =>
    ["fetch", "clone", "ls-remote", "pull", "push"].includes(arg),
  );
  const selected =
    platform === "win32" &&
    network &&
    environment.YINGKE_GIT_CONNECTION_MODE === "direct";
  const invoke = (direct) =>
    execute("git", [...(direct ? DIRECT_GIT_OPTIONS : []), ...args], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: direct ? directEnvironment(environment) : environment,
      ...(network ? { timeout: 60000 } : {}),
    }).trim();
  try {
    return invoke(selected);
  } catch (error) {
    const original = String(error.stderr || error.message);
    if (
      !selected &&
      platform === "win32" &&
      network &&
      !error.signal &&
      !error.killed &&
      unreachableLocalProxy(original)
    ) {
      log(
        "本机代理未响应，尝试仅对本次 Git 命令使用直连；保留全局代理配置及 TLS 校验。",
      );
      try {
        return invoke(true);
      } catch (directError) {
        throw new Error(
          "本机代理无法连接，GitHub 直连也未成功。请启动你原来使用的代理程序或修正其地址后重试。\n直连结果：" +
            safeGitError(directError.stderr || directError.message),
        );
      }
    }
    const hint = unreachableLocalProxy(original)
      ? "本机代理无法连接。"
      : /authentication|could not read Username|repository not found/i.test(
            original,
          )
        ? "仓库访问或认证失败。"
        : /certificate|\bSSL\b|\bTLS\b/i.test(original)
          ? "TLS 证书校验未通过，未关闭验证。"
          : "";
    throw new Error("Git 操作失败：" + hint + safeGitError(original));
  }
}
