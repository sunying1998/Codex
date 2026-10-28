import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  executeGit,
  gitProfileOptions,
} from "../scripts/lib/git-connection.mjs";
import {
  readGitProfile,
  saveGitProfile,
  gitProfilePath,
  validateGitProfile,
} from "../scripts/lib/git-profile.mjs";
const settings = {
  version: 1,
  proxy: "http://127.0.0.1:12450",
  tlsBackend: "openssl",
  httpVersion: "HTTP/1.1",
};
const eof =
  "TLS connect error: error:0A000126:SSL routines::unexpected eof while reading";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yingke-git-profile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function fail(stderr, extra = {}) {
  return Object.assign(new Error("git failed"), {
    stderr,
    status: 128,
    ...extra,
  });
}
test("Git preferences persist as ignored project data and support a configured data directory without editing Git configuration", (t) => {
  const root = fixture(t);
  execFileSync("git", ["init", root], { stdio: "ignore" });
  fs.writeFileSync(path.join(root, ".gitignore"), ".data/\n");
  const before = fs.readFileSync(path.join(root, ".git/config"), "utf8");
  const file = saveGitProfile(root, settings, {});
  assert.equal(file, path.join(root, ".data/git-connection.json"));
  assert.deepEqual(readGitProfile(root, {}), settings);
  assert.equal(fs.readFileSync(path.join(root, ".git/config"), "utf8"), before);
  assert.equal(
    execFileSync("git", ["check-ignore", ".data/git-connection.json"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    ".data/git-connection.json",
  );
  const environment = { YINGKE_DATA_DIR: path.join(root, "custom-data") };
  saveGitProfile(
    root,
    { ...settings, proxy: "http://127.0.0.1:12451" },
    environment,
  );
  assert.equal(
    readGitProfile(root, environment).proxy,
    "http://127.0.0.1:12451",
  );
  assert.equal(readGitProfile(root, {}).proxy, settings.proxy);
  assert.ok(
    !fs.readdirSync(path.dirname(file)).some((name) => name.endsWith(".tmp")),
  );
});
test("fresh Windows update processes reuse saved proxy, OpenSSL and TLS verification while preserving credential bindings", (t) => {
  const root = fixture(t);
  saveGitProfile(root, settings, {});
  const global = path.join(root, "old.gitconfig");
  const original =
    '[http "https://github.com/sunying1998/Codex.git"]\n proxy = http://127.0.0.1:9\n sslVerify = false\n';
  fs.writeFileSync(global, original);
  const environment = {
    ...process.env,
    YINGKE_DATA_DIR: path.join(root, ".data"),
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "fixture-auth-helper",
    GIT_ASKPASS: "retained-helper",
    YINGKE_GIT_CONNECTION_MODE: "direct",
  };
  delete environment.YINGKE_SETUP_GIT_PROXY;
  delete environment.YINGKE_SETUP_GIT_SSL_BACKEND;
  const unchanged = { ...environment };
  let calls = 0;
  executeGit(root, ["fetch", "origin", "main"], {
    platform: "win32",
    environment,
    execute: (_program, args, options) => {
      calls++;
      assert.deepEqual(args, [
        ...gitProfileOptions(settings),
        "fetch",
        "origin",
        "main",
      ]);
      assert.equal(options.env, environment);
      const prefix = args.slice(0, -3);
      const query = (...values) =>
        execFileSync("git", [...prefix, "config", ...values], {
          cwd: root,
          env: environment,
          encoding: "utf8",
        }).trim();
      for (const url of [
        "https://github.com/sunying1998/Codex.git",
        "https://github.com/sunying1998/Codex.git/",
      ]) {
        assert.equal(
          query("--get-urlmatch", "http.proxy", url),
          settings.proxy,
        );
        assert.equal(query("--get-urlmatch", "http.sslVerify", url), "true");
      }
      assert.equal(query("--get", "http.sslBackend"), "openssl");
      assert.equal(query("--get", "credential.helper"), "fixture-auth-helper");
      assert.equal(query("--get", "remote.origin.proxy"), settings.proxy);
      return "ok";
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(environment, unchanged);
  assert.equal(fs.readFileSync(global, "utf8"), original);
});
test("saved profile retries interrupted reads at most three times but never changes route or retries policy, certificate, push or cancellation failures", (t) => {
  const root = fixture(t);
  saveGitProfile(root, settings, {});
  for (const [command, message, extra, count] of [
    ["fetch", eof, {}, 3],
    ["fetch", "Recv failure: Connection was reset", {}, 3],
    ["fetch", "SSL certificate problem", {}, 1],
    ["fetch", "HTTP/1.1 403 " + eof, {}, 1],
    ["push", eof, {}, 1],
    ["fetch", eof, { signal: "SIGINT" }, 1],
    [
      "fetch",
      "Failed to connect over proxy 127.0.0.1: Could not connect",
      {},
      1,
    ],
  ]) {
    let actual = 0;
    assert.throws(() =>
      executeGit(root, [command, "origin"], {
        platform: "win32",
        environment: {},
        log: () => {},
        execute: (_program, args) => {
          actual++;
          assert.deepEqual(args, [
            ...gitProfileOptions(settings),
            command,
            "origin",
          ]);
          throw fail(message, extra);
        },
      }),
    );
    assert.equal(actual, count, message);
  }
});
test("malformed local settings stop Windows network access without exposing their values; metadata and cloud calls retain the native route", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".data"));
  fs.writeFileSync(
    gitProfilePath(root, {}),
    '{"version":1,"proxy":"http://fixture-user:fixture-password@example.com:9"}',
  );
  let calls = 0;
  assert.throws(
    () =>
      executeGit(root, ["fetch", "origin"], {
        platform: "win32",
        environment: {},
        execute: () => {
          calls++;
        },
      }),
    (error) =>
      error.message.includes("连接配置无效") &&
      !error.message.includes("fixture-password"),
  );
  assert.equal(calls, 0);
  for (const [platform, args] of [
    ["win32", ["rev-parse", "HEAD"]],
    ["linux", ["fetch", "origin"]],
  ]) {
    executeGit(root, args, {
      platform,
      environment: { HTTPS_PROXY: "platform-route" },
      execute: (_program, actual, options) => {
        assert.deepEqual(actual, args);
        assert.equal(options.env.HTTPS_PROXY, "platform-route");
        return "ok";
      },
    });
  }
});
test("one-time installer selection overrides previous saved settings, and a later process uses the persisted selection", (t) => {
  const root = fixture(t);
  saveGitProfile(root, { ...settings, proxy: "http://127.0.0.1:9" }, {});
  executeGit(root, ["fetch", "origin"], {
    platform: "win32",
    environment: {
      YINGKE_SETUP_GIT_PROXY: settings.proxy,
      YINGKE_SETUP_GIT_SSL_BACKEND: settings.tlsBackend,
    },
    execute: (_program, args) => {
      assert.deepEqual(args, [
        ...gitProfileOptions(settings),
        "fetch",
        "origin",
      ]);
      return "ok";
    },
  });
  saveGitProfile(root, settings, {});
  executeGit(root, ["fetch", "origin"], {
    platform: "win32",
    environment: {},
    execute: (_program, args) => {
      assert.deepEqual(args, [
        ...gitProfileOptions(settings),
        "fetch",
        "origin",
      ]);
      return "ok";
    },
  });
});
test("preference validation rejects credentials, out-of-range ports, unknown keys and disabling TLS verification", () => {
  for (const value of [
    { ...settings, proxy: "http://user:password@127.0.0.1:12450" },
    { ...settings, proxy: "http://127.0.0.1:65536" },
    { ...settings, sslVerify: false },
    { ...settings, tlsBackend: "unknown" },
    { ...settings, httpVersion: "disabled" },
  ])
    assert.throws(() => validateGitProfile(value));
});
