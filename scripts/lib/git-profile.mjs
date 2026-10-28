import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function validateGitProfile(value) {
  if (
    !value ||
    value.version !== 1 ||
    Object.keys(value).some(
      (key) => !["version", "proxy", "tlsBackend", "httpVersion"].includes(key),
    )
  )
    throw new Error("本项目 Git 连接配置格式不正确。");
  const { proxy = "", tlsBackend = "", httpVersion = "HTTP/1.1" } = value;
  if (typeof proxy !== "string") throw new Error("Git 代理地址格式不正确。");
  if (proxy) {
    const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(proxy);
    if (!match || Number(match[1]) > 65535)
      throw new Error(
        "Git 代理需要本机 HTTP/混合代理地址，例如 http://127.0.0.1:12450。",
      );
  }
  if (
    !["", "openssl", "schannel"].includes(tlsBackend) ||
    httpVersion !== "HTTP/1.1"
  )
    throw new Error("Git TLS 后端或 HTTP 版本不受支持。");
  return { version: 1, proxy, tlsBackend, httpVersion };
}

export function gitProfilePath(root, environment = process.env) {
  return path.join(
    path.resolve(root, environment.YINGKE_DATA_DIR || ".data"),
    "git-connection.json",
  );
}

export function readGitProfile(root, environment = process.env) {
  const file = gitProfilePath(root, environment);
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    return validateGitProfile(JSON.parse(content));
  } catch {
    throw new Error(
      "本项目 Git 连接配置无效，请检查 " + file + "；未发起网络请求。",
    );
  }
}

export function saveGitProfile(root, value, environment = process.env) {
  const profile = validateGitProfile(value);
  const file = gitProfilePath(root, environment);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temp, JSON.stringify(profile, null, 2) + "\n", {
      mode: 0o600,
    });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return file;
}
