import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generator = path.join(root, "scripts/create-windows-installer.mjs");
const target =
  "C:\\Users\\Administrator\\Desktop\\yingke-personal-beta\\yingke-studio";
test("standalone installer embeds the pinned payload beyond cmd command limits and accepts only a local proxy and known TLS backend", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "yingke-installer-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, "installer.cmd");
  execFileSync(
    process.execPath,
    [generator, target, output, "http://127.0.0.1:12450", "openssl"],
    { cwd: root },
  );
  const cmd = fs.readFileSync(output, "ascii");
  const source = fs.readFileSync(output + ".review.ps1", "utf8");
  const marker = "# YINGKE-POWERSHELL-PAYLOAD";
  assert.equal(
    cmd
      .slice(cmd.lastIndexOf(marker) + marker.length)
      .trim()
      .replaceAll("\r\n", "\n"),
    source.trim(),
  );
  assert.ok(cmd.indexOf("exit /b %errorlevel%") < cmd.lastIndexOf(marker));
  assert.ok(
    cmd.split("\r\n").find((line) => line.startsWith("powershell.exe")).length <
      8191,
  );
  assert.ok(
    source.includes(
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
    ),
  );
  assert.equal(
    Buffer.from(
      source.match(/FromBase64String\('([^']+)'\)/)[1],
      "base64",
    ).toString("utf8"),
    target,
  );
  assert.ok(
    !/@@[A-Z_]+@@|ExecutionPolicy|sslVerify=false|--insecure|--global/i.test(
      source,
    ),
  );
  for (const [proxy, backend] of [
    ["http://example.com:12450", "openssl"],
    ["http://127.0.0.1:65536", "openssl"],
    ["http://127.0.0.1:12450';throw 'oops", "openssl"],
    ["http://127.0.0.1:12450", "invalid"],
  ]) {
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [generator, target, output, proxy, backend],
        { cwd: root, stdio: "pipe" },
      ),
    );
  }
});
