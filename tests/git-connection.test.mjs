import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  executeGit,
  unreachableLocalProxy,
  DIRECT_GIT_OPTIONS,
  HTTP1_GIT_OPTIONS,
  interruptedHandshake,
} from "../scripts/lib/git-connection.mjs";

const dead =
  "fatal: unable to access 'https://github.com/sunying1998/Codex.git/': Failed to connect to github.com:443 over proxy 127.0.0.1 after 2112 ms: Could not connect to server";
test("Git native URL matching applies empty proxy overrides while retaining TLS verification", () => {
  for (const url of [
    "https://github.com/sunying1998/Codex.git",
    "https://github.com/sunying1998/Codex.git/",
  ]) {
    const configured = [
      "-c",
      "http.proxy=http://127.0.0.1:9",
      "-c",
      "http." + url + ".proxy=http://127.0.0.1:9",
      "-c",
      "http." + url + ".sslVerify=false",
    ];
    const proxy = execFileSync(
      "git",
      [
        ...configured,
        ...DIRECT_GIT_OPTIONS,
        "config",
        "--get-urlmatch",
        "http.proxy",
        url,
      ],
      { encoding: "utf8" },
    ).trim();
    const tls = execFileSync(
      "git",
      [
        ...configured,
        ...DIRECT_GIT_OPTIONS,
        "config",
        "--get-urlmatch",
        "http.sslVerify",
        url,
      ],
      { encoding: "utf8" },
    ).trim();
    assert.equal(proxy, "");
    assert.equal(tls, "true");
  }
});
test("Windows TLS receive interruption retries the same read operation without changing backend, proxy or trust", () => {
  const environment = {
    HTTPS_PROXY: "http://127.0.0.1:12450",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.sslBackend",
    GIT_CONFIG_VALUE_0: "openssl",
  };
  const calls = [];
  const result = executeGit("project", ["fetch", "origin"], {
    platform: "win32",
    environment,
    log: () => {},
    execute: (_program, args, options) => {
      calls.push(args);
      assert.equal(options.env, environment);
      if (calls.length === 1)
        throw failure(
          "schannel: failed to receive handshake, SSL/TLS connection failed",
        );
      return "ok";
    },
  });
  assert.equal(result, "ok");
  assert.deepEqual(calls, [
    ["fetch", "origin"],
    ["fetch", "origin"],
  ]);
  assert.equal(
    interruptedHandshake(
      "TLS connect error: error:0A000126:SSL routines::unexpected eof while reading",
    ),
    true,
  );
  for (const error of [
    "SSL certificate problem: SSL_ERROR_SYSCALL",
    "SEC_E_UNTRUSTED_ROOT: schannel: failed to receive handshake",
    "HTTP/1.1 403 SSL_ERROR_SYSCALL",
  ])
    assert.equal(interruptedHandshake(error), false);
});
test("handshake interruptions remain bounded, do not retry clone/push/cloud/cancellation, and preserve TLS error meaning", () => {
  for (const [platform, command, extra, expected] of [
    ["win32", "fetch", {}, 2],
    ["win32", "clone", {}, 1],
    ["win32", "push", {}, 1],
    ["linux", "fetch", {}, 1],
    ["win32", "fetch", { signal: "SIGINT" }, 1],
  ]) {
    let count = 0;
    assert.throws(
      () =>
        executeGit("project", [command, "origin"], {
          platform,
          log: () => {},
          execute: () => {
            count++;
            throw failure(
              "schannel: failed to receive handshake, SSL/TLS connection failed",
              extra,
            );
          },
        }),
      /TLS 连接或证书校验失败/,
    );
    assert.equal(count, expected);
  }
});
test("Windows reset retries read-only negotiation with HTTP/1.1 on the same proxy route", () => {
  for (const command of ["ls-remote", "fetch"]) {
    const environment = {
      HTTPS_PROXY: "http://127.0.0.1:7890",
      GIT_ASKPASS: "preserved",
    };
    const calls = [];
    assert.equal(
      executeGit("project", [command, "origin"], {
        platform: "win32",
        environment,
        log: () => {},
        execute: (_program, args, options) => {
          calls.push(args);
          assert.equal(options.env, environment);
          if (calls.length === 1)
            throw failure("fatal: Recv failure: Connection was reset");
          return "ok";
        },
      }),
      "ok",
    );
    assert.deepEqual(calls, [
      [command, "origin"],
      [...HTTP1_GIT_OPTIONS, command, "origin"],
    ]);
    assert.equal(environment.YINGKE_GIT_HTTP_VERSION, undefined);
  }
});
test("HTTP/1.1 reset failure stops after one retry and gives connectivity guidance", () => {
  let count = 0;
  assert.throws(
    () =>
      executeGit("project", ["fetch", "origin"], {
        platform: "win32",
        log: () => {},
        execute: () => {
          count++;
          throw failure("Recv failure: Connection was reset");
        },
      }),
    /连接被重置/,
  );
  assert.equal(count, 2);
});
test("reset never retries clone, push, cancellation, cloud, certificate or policy failures", () => {
  for (const [platform, command, message, extra] of [
    ["win32", "clone", "Recv failure: Connection was reset", {}],
    ["win32", "push", "Recv failure: Connection was reset", {}],
    ["linux", "fetch", "Recv failure: Connection was reset", {}],
    [
      "win32",
      "fetch",
      "Recv failure: Connection was reset",
      { signal: "SIGINT" },
    ],
    [
      "win32",
      "fetch",
      "certificate error: Recv failure: Connection was reset",
      {},
    ],
    ["win32", "fetch", "HTTP/2 403: Recv failure: Connection was reset", {}],
  ]) {
    let count = 0;
    assert.throws(() =>
      executeGit("project", [command, "origin"], {
        platform,
        log: () => {},
        execute: () => {
          count++;
          throw failure(message, extra);
        },
      }),
    );
    assert.equal(count, 1, [platform, command, message].join(" "));
  }
});
test("bootstrap HTTP/1.1 selection propagates to Windows clone without changing proxy settings", () => {
  const environment = {
    YINGKE_GIT_HTTP_VERSION: "HTTP/1.1",
    HTTPS_PROXY: "existing",
  };
  executeGit("project", ["clone", "source", "target"], {
    platform: "win32",
    environment,
    execute: (_program, args, options) => {
      assert.deepEqual(args, [
        ...HTTP1_GIT_OPTIONS,
        "clone",
        "source",
        "target",
      ]);
      assert.equal(options.env, environment);
      return "ok";
    },
  });
});
function failure(stderr, extra = {}) {
  return Object.assign(new Error("git failed"), {
    stderr,
    status: 128,
    ...extra,
  });
}
test("command-only connection options are not saved in a cloned repository", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yingke-proxy-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source.git"),
    target = path.join(root, "clone");
  execFileSync("git", ["init", "--bare", source], { stdio: "ignore" });
  execFileSync("git", [...DIRECT_GIT_OPTIONS, "clone", source, target], {
    stdio: "ignore",
  });
  for (const name of ["http.proxy", "remote.origin.proxy", "http.sslVerify"]) {
    assert.throws(
      () =>
        execFileSync("git", ["config", "--local", "--get", name], {
          cwd: target,
          stdio: "pipe",
        }),
      (error) => error.status === 1,
    );
  }
});
test("Windows dead loopback proxy retries once with command-only proxy overrides and preserved credential helpers", () => {
  const environment = {
    HTTP_PROXY: "http://127.0.0.1:9",
    https_proxy: "http://127.0.0.1:9",
    All_Proxy: "socks5://127.0.0.1:9",
    PATH: "test-path",
    GIT_ASKPASS: "test-auth-helper",
    GIT_CONFIG_COUNT: "1",
  };
  const original = { ...environment },
    calls = [],
    logs = [];
  const result = executeGit("project", ["fetch", "origin", "main"], {
    platform: "win32",
    environment,
    log: (value) => logs.push(value),
    execute: (program, args, options) => {
      calls.push({ program, args, options });
      if (calls.length === 1) throw failure(dead);
      return "success\n";
    },
  });
  assert.equal(result, "success");
  assert.equal(calls.length, 2);
  assert.equal(logs.length, 1);
  assert.deepEqual(calls[0].args, ["fetch", "origin", "main"]);
  assert.deepEqual(calls[1].args, [
    ...DIRECT_GIT_OPTIONS,
    "fetch",
    "origin",
    "main",
  ]);
  assert.deepEqual(environment, original);
  assert.equal(calls[1].options.env.HTTP_PROXY, undefined);
  assert.equal(calls[1].options.env.https_proxy, undefined);
  assert.equal(calls[1].options.env.All_Proxy, undefined);
  assert.equal(calls[1].options.env.GIT_ASKPASS, "test-auth-helper");
  assert.equal(calls[1].options.env.GIT_CONFIG_COUNT, "1");
  assert.ok(calls[1].args.includes("http.sslVerify=true"));
  assert.ok(!calls[1].args.includes("--global"));
});
test("cloud/Linux proxy bindings remain in effect even if a Windows installer mode is present", () => {
  const environment = {
    HTTPS_PROXY: "platform-proxy",
    YINGKE_GIT_CONNECTION_MODE: "direct",
  };
  let count = 0;
  assert.throws(
    () =>
      executeGit("project", ["fetch", "origin", "main"], {
        platform: "linux",
        environment,
        execute: (_program, args, options) => {
          count++;
          assert.deepEqual(args, ["fetch", "origin", "main"]);
          assert.equal(options.env, environment);
          throw failure(dead);
        },
      }),
    /本机代理无法连接/,
  );
  assert.equal(count, 1);
});
test("authentication, certificate, proxy-policy responses and non-loopback proxies never trigger fallback", () => {
  for (const error of [
    "Authentication failed for https://github.com/repo",
    "SSL certificate problem over proxy 127.0.0.1: Could not connect",
    "CONNECT tunnel failed, response 403 over proxy 127.0.0.1: Failed to connect",
    "The requested URL returned error: 407 over proxy 127.0.0.1: Could not connect",
    "Failed to connect to github.com over proxy corporate.example: Could not connect to server",
  ]) {
    let count = 0;
    assert.equal(unreachableLocalProxy(error), false);
    assert.throws(() =>
      executeGit("project", ["fetch", "origin", "main"], {
        platform: "win32",
        execute: () => {
          count++;
          throw failure(error);
        },
      }),
    );
    assert.equal(count, 1, error);
  }
});
test("direct connection failure is reported as connectivity rather than GitHub login and credentials are redacted", () => {
  let count = 0;
  assert.throws(
    () =>
      executeGit("project", ["fetch", "origin", "main"], {
        platform: "win32",
        log: () => {},
        execute: () => {
          count++;
          throw failure(
            count === 1
              ? dead
              : "Failed for https://test-user:test-password@github.com/repo",
          );
        },
      }),
    (error) =>
      error.message.includes("直连也未成功") &&
      !error.message.includes("test-password"),
  );
  assert.equal(count, 2);
});
test("successful normal connections and metadata operations retain their native route", () => {
  let count = 0;
  assert.equal(
    executeGit("project", ["fetch", "origin", "main"], {
      platform: "win32",
      execute: (_program, args) => {
        count++;
        assert.deepEqual(args, ["fetch", "origin", "main"]);
        return "ok";
      },
    }),
    "ok",
  );
  assert.equal(count, 1);
  assert.equal(
    executeGit("project", ["rev-parse", "HEAD"], {
      platform: "win32",
      environment: { YINGKE_GIT_CONNECTION_MODE: "direct" },
      execute: (_program, args) => {
        assert.deepEqual(args, ["rev-parse", "HEAD"]);
        return "sha";
      },
    }),
    "sha",
  );
});
test("Windows bootstrap direct mode is process-scoped, and cancellation does not retry", () => {
  const environment = {
    HTTP_PROXY: "old",
    YINGKE_GIT_CONNECTION_MODE: "direct",
    GIT_ASKPASS: "preserved",
  };
  executeGit("project", ["fetch", "origin", "main"], {
    platform: "win32",
    environment,
    execute: (_program, args, options) => {
      assert.deepEqual(args, [
        ...DIRECT_GIT_OPTIONS,
        "fetch",
        "origin",
        "main",
      ]);
      assert.equal(options.env.HTTP_PROXY, undefined);
      assert.equal(options.env.GIT_ASKPASS, "preserved");
      return "ok";
    },
  });
  let count = 0;
  assert.throws(() =>
    executeGit("project", ["fetch", "origin", "main"], {
      platform: "win32",
      execute: () => {
        count++;
        throw failure(dead, { signal: "SIGINT" });
      },
    }),
  );
  assert.equal(count, 1);
});
