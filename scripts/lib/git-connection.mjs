import { execFileSync } from "node:child_process";
import { readGitProfile, validateGitProfile } from "./git-profile.mjs";

export const HTTP1_GIT_OPTIONS = ["-c", "http.version=HTTP/1.1"];
export function interruptedHandshake(message) {
  return (
    /schannel: failed to receive handshake|SSL_ERROR_SYSCALL|SSL routines::unexpected eof while reading/i.test(
      message,
    ) &&
    !/authentication|certificate|CERT_|SEC_E_UNTRUSTED_ROOT|CONNECT tunnel|returned error:\s*\d{3}|HTTP\/\S+\s+[45]\d{2}/i.test(
      message,
    )
  );
}
export function connectionReset(message) {
  return (
    /Recv failure: Connection was reset|HTTP\/2 stream .* (?:closed|reset)|HTTP\/2 framing layer/i.test(
      message,
    ) &&
    !/authentication|certificate|CONNECT tunnel|returned error:\s*\d{3}|HTTP\/\S+\s+[45]\d{2}/i.test(
      message,
    )
  );
}

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
export function gitProfileOptions(profile) {
  const result = [];
  for (let index = 0; index < DIRECT_GIT_OPTIONS.length; index += 2) {
    let setting = DIRECT_GIT_OPTIONS[index + 1];
    if (setting.endsWith(".proxy=")) {
      if (!profile.proxy) continue;
      setting += profile.proxy;
    }
    result.push("-c", setting);
  }
  result.push("-c", "http.version=" + profile.httpVersion);
  if (profile.tlsBackend)
    result.push("-c", "http.sslBackend=" + profile.tlsBackend);
  return result;
}
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
  let profile = null;
  if (platform === "win32" && network) {
    profile =
      environment.YINGKE_SETUP_GIT_PROXY ||
      environment.YINGKE_SETUP_GIT_SSL_BACKEND
        ? validateGitProfile({
            version: 1,
            proxy: environment.YINGKE_SETUP_GIT_PROXY || "",
            tlsBackend: environment.YINGKE_SETUP_GIT_SSL_BACKEND || "",
          })
        : readGitProfile(root, environment);
  }
  const selected =
    platform === "win32" &&
    network &&
    environment.YINGKE_GIT_CONNECTION_MODE === "direct" &&
    !profile;
  let http1 =
    platform === "win32" &&
    network &&
    environment.YINGKE_GIT_HTTP_VERSION === "HTTP/1.1";
  const invoke = (direct) =>
    execute(
      "git",
      [
        ...(direct ? DIRECT_GIT_OPTIONS : []),
        ...(profile
          ? gitProfileOptions(profile)
          : http1
            ? HTTP1_GIT_OPTIONS
            : []),
        ...args,
      ],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: direct ? directEnvironment(environment) : environment,
        ...(network ? { timeout: 60000 } : {}),
      },
    ).trim();
  const connect = (direct) => {
    if (profile) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          return invoke(direct);
        } catch (error) {
          const message = String(error.stderr || error.message);
          if (
            attempt === 3 ||
            !args.some((arg) => ["fetch", "ls-remote"].includes(arg)) ||
            error.signal ||
            error.killed ||
            !(interruptedHandshake(message) || connectionReset(message))
          )
            throw error;
          log(
            "Git 传输中断，保留已保存的代理和 TLS 设置重试（" +
              (attempt + 1) +
              "/3）。",
          );
        }
      }
    }
    try {
      return invoke(direct);
    } catch (error) {
      if (
        platform === "win32" &&
        args.some((arg) => ["ls-remote", "fetch"].includes(arg)) &&
        !error.signal &&
        !error.killed &&
        interruptedHandshake(String(error.stderr || error.message))
      ) {
        log("Git TLS 握手中断，沿用当前代理、TLS 后端和证书校验重试一次。");
        return invoke(direct);
      }
      if (
        platform === "win32" &&
        !http1 &&
        args.some((arg) => ["ls-remote", "fetch"].includes(arg)) &&
        !error.signal &&
        !error.killed &&
        connectionReset(String(error.stderr || error.message))
      ) {
        log(
          "Git 连接被重置，沿用当前网络路径，以 HTTP/1.1 重试一次。代理配置及 TLS 校验保持不变。",
        );
        http1 = true;
        return invoke(direct);
      }
      throw error;
    }
  };
  try {
    return connect(selected);
  } catch (error) {
    const original = String(error.stderr || error.message);
    if (
      !selected &&
      !profile &&
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
        return connect(true);
      } catch (directError) {
        throw new Error(
          "本机代理无法连接，GitHub 直连也未成功。请启动你原来使用的代理程序或修正其地址后重试。\n直连结果：" +
            safeGitError(directError.stderr || directError.message),
        );
      }
    }
    const hint = connectionReset(original)
      ? "连接被重置，尚不能确定是代理还是网络中断。请确认原代理程序正在运行，并检查浏览器能否打开仓库；浏览器可访问也不代表 Git 使用相同代理。"
      : unreachableLocalProxy(original)
        ? profile
          ? "已保存的本机代理无法连接，请先启动代理软件或检查本项目 git-connection.json 中的端口。"
          : "本机代理无法连接。"
        : /authentication|could not read Username|repository not found/i.test(
              original,
            )
          ? "仓库访问或认证失败。"
          : /certificate|\bSSL\b|\bTLS\b/i.test(original)
            ? "TLS 连接或证书校验失败，未关闭验证。"
            : "";
    throw new Error("Git 操作失败：" + hint + safeGitError(original));
  }
}
