import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { adoptProject } from "../scripts/lib/adopt.mjs";
import { updateProject, withUpdateLock } from "../scripts/lib/update.mjs";
import {
  project,
  hash,
  readJson,
  writeJson,
  REPOSITORY,
} from "../scripts/lib/project.mjs";
import { fileURLToPath } from "node:url";
import { saveGitProfile } from "../scripts/lib/git-profile.mjs";
import { writeAppTypeDeclarations } from "next/dist/lib/typescript/writeAppTypeDeclarations.js";
import { assertClean } from "../scripts/lib/project.mjs";

function command(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function write(root, file, content) {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
function commit(root, message) {
  command(root, ["add", "."]);
  command(root, ["commit", "-qm", message]);
  return command(root, ["rev-parse", "HEAD"]);
}
function configure(root) {
  command(root, ["config", "user.name", "Sync Test"]);
  command(root, ["config", "user.email", "sync-test@example.invalid"]);
}
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "yingke-sync-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const remote = path.join(temp, "remote.git"),
    author = path.join(temp, "author"),
    source = path.join(temp, "source"),
    root = path.join(temp, "old project");
  fs.mkdirSync(author);
  fs.mkdirSync(root);
  command(temp, ["init", "--bare", "--initial-branch=main", remote]);
  command(author, ["init", "--initial-branch=main"]);
  configure(author);
  write(
    author,
    "package.json",
    JSON.stringify({ name: "yingke-studio", private: true, type: "module" }),
  );
  write(
    author,
    "package-lock.json",
    JSON.stringify({ lockfileVersion: 3, version: 1 }),
  );
  write(
    author,
    ".gitignore",
    ".data/\n.env*\n!.env.example\nnode_modules/\n.next/\n",
  );
  write(author, ".env.example", "# empty example\n");
  write(author, "src/value.txt", "version one\n");
  const first = commit(author, "first");
  command(author, ["remote", "add", "origin", remote]);
  command(author, ["push", "-q", "-u", "origin", "main"]);
  command(temp, ["clone", "-q", "--branch", "main", remote, source]);
  write(
    root,
    "package.json",
    JSON.stringify({ name: "yingke-studio", private: true }),
  );
  write(root, "src/value.txt", "old extracted code\n");
  write(root, "my-notes.txt", "personal notes\n");
  write(root, ".env.local", "LOCAL_ONLY_TEST=keep-local\n");
  write(root, ".data/media/original.bin", "irreplaceable media");
  const db = new DatabaseSync(path.join(root, ".data/studio.sqlite"));
  db.exec(
    "CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT); INSERT INTO users VALUES('owner','existing owner'); CREATE TABLE worker_lock(id INTEGER PRIMARY KEY,owner TEXT,expires_at INTEGER);",
  );
  db.close();
  return { temp, remote, author, source, root, first, ctx: project(root) };
}
async function fakeNpm(root, action) {
  if (action === "install") {
    write(root, "node_modules/next/package.json", "{}");
    write(root, "node_modules/tsx/package.json", "{}");
  } else write(root, ".next/BUILD_ID", "test-build");
}
function options(f, calls = []) {
  return {
    repository: f.remote,
    runNpm: async (root, action) => {
      calls.push(action);
      await fakeNpm(root, action);
    },
    stop: async () => {
      calls.push("stop");
    },
    waitStopped: async () => {},
  };
}

async function legacyGeneratedFixture(t) {
  const f = fixture(t);
  await writeAppTypeDeclarations({
    baseDir: f.author,
    distDir: ".next",
    imageImportsEnabled: true,
    hasAppDir: true,
    hasPagesDir: false,
  });
  f.legacy = commit(f.author, "legacy tracked Next.js output");
  command(f.author, ["push", "-q"]);
  command(f.source, ["fetch", "origin", "main"]);
  command(f.source, ["merge", "--ff-only", "origin/main"]);
  await adoptProject({
    root: f.root,
    source: f.source,
    repository: f.remote,
    expectedCommit: f.legacy,
  });
  await writeAppTypeDeclarations({
    baseDir: f.root,
    distDir: ".next/dev",
    imageImportsEnabled: true,
    hasAppDir: true,
    hasPagesDir: false,
  });
  const current = fs
    .readFileSync(path.join(f.root, "next-env.d.ts"), "utf8")
    .replaceAll("\n", "\r\n");
  write(f.root, "next-env.d.ts", current);
  f.generated = Buffer.from(current);
  return f;
}

function untrackGeneratedFixture(f) {
  fs.appendFileSync(path.join(f.author, ".gitignore"), "next-env.d.ts\n");
  command(f.author, ["rm", "--cached", "next-env.d.ts"]);
  const next = commit(f.author, "generate next-env locally");
  command(f.author, ["push", "-q"]);
  return next;
}

test("legacy Next.js dev declarations migrate with an exact backup and remain ignored across dev/build regeneration", async (t) => {
  const f = await legacyGeneratedFixture(t),
    next = untrackGeneratedFixture(f),
    calls = [];
  const result = await updateProject(f.ctx, options(f, calls));
  assert.equal(result.after, next);
  assert.deepEqual(
    fs.readFileSync(
      path.join(result.backup, "generated-next-env/next-env.d.ts"),
    ),
    f.generated,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(f.root, "next-env.d.ts")),
    f.generated,
  );
  assert.equal(command(f.root, ["ls-files", "--", "next-env.d.ts"]), "");
  assert.equal(
    command(f.root, ["check-ignore", "next-env.d.ts"]),
    "next-env.d.ts",
  );
  for (const distDir of [".next", ".next/dev"]) {
    await writeAppTypeDeclarations({
      baseDir: f.root,
      distDir,
      imageImportsEnabled: true,
      hasAppDir: true,
      hasPagesDir: false,
    });
    assert.doesNotThrow(() => assertClean(f.root));
  }
  assert.equal(
    fs.readFileSync(path.join(f.root, ".data/media/original.bin"), "utf8"),
    "irreplaceable media",
  );
  const repeated = [];
  await updateProject(f.ctx, options(f, repeated));
  assert.deepEqual(repeated, ["stop"]);
});

test("custom declaration content, staged declarations and other source edits stop before generated-file migration", async (t) => {
  for (const kind of ["custom", "staged", "source"]) {
    const f = await legacyGeneratedFixture(t);
    untrackGeneratedFixture(f);
    if (kind === "custom")
      fs.appendFileSync(
        path.join(f.root, "next-env.d.ts"),
        "declare const personalType: string;\n",
      );
    if (kind === "staged") command(f.root, ["add", "next-env.d.ts"]);
    if (kind === "source")
      write(f.root, "src/value.txt", "personal source edit");
    const original = fs.readFileSync(path.join(f.root, "next-env.d.ts")),
      calls = [];
    await assert.rejects(
      updateProject(f.ctx, options(f, calls)),
      /本地受 Git 管理/,
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(
      fs.readFileSync(path.join(f.root, "next-env.d.ts")),
      original,
    );
    assert.equal(command(f.root, ["rev-parse", "HEAD"]), f.legacy);
  }
});

test("a failed merge restores the original generated file while preserving unrelated personal files", async (t) => {
  const f = await legacyGeneratedFixture(t);
  untrackGeneratedFixture(f);
  write(f.author, "my-notes.txt", "remote collision");
  commit(f.author, "collision");
  command(f.author, ["push", "-q"]);
  await assert.rejects(updateProject(f.ctx, options(f)), /Git 操作失败/);
  assert.deepEqual(
    fs.readFileSync(path.join(f.root, "next-env.d.ts")),
    f.generated,
  );
  assert.equal(
    fs.readFileSync(path.join(f.root, "my-notes.txt"), "utf8"),
    "personal notes\n",
  );
  assert.equal(command(f.root, ["rev-parse", "HEAD"]), f.legacy);
});

test("first Git adoption backs up overlapping code and preserves account, config, media and unrelated files", async (t) => {
  const f = fixture(t),
    before = hash(fs.readFileSync(path.join(f.root, ".data/studio.sqlite")));
  const result = await adoptProject({
    root: f.root,
    source: f.source,
    repository: f.remote,
    expectedCommit: f.first,
  });
  assert.equal(command(f.root, ["rev-parse", "HEAD"]), f.first);
  assert.equal(
    fs.readFileSync(
      path.join(result.backup, "previous-code/src/value.txt"),
      "utf8",
    ),
    "old extracted code\n",
  );
  assert.equal(
    fs.readFileSync(path.join(f.root, "src/value.txt"), "utf8"),
    "version one\n",
  );
  assert.equal(
    fs.readFileSync(path.join(f.root, ".env.local"), "utf8"),
    "LOCAL_ONLY_TEST=keep-local\n",
  );
  assert.equal(
    fs.readFileSync(path.join(f.root, ".data/media/original.bin"), "utf8"),
    "irreplaceable media",
  );
  assert.equal(
    fs.readFileSync(path.join(f.root, "my-notes.txt"), "utf8"),
    "personal notes\n",
  );
  assert.equal(
    hash(fs.readFileSync(path.join(f.root, ".data/studio.sqlite"))),
    before,
  );
  const backupDb = new DatabaseSync(path.join(result.backup, "studio.sqlite"), {
    readOnly: true,
  });
  assert.equal(
    backupDb.prepare("SELECT username FROM users").get().username,
    "existing owner",
  );
  backupDb.close();
  assert.equal(
    command(f.root, ["status", "--porcelain", "--untracked-files=no"]),
    "",
  );
});

test("fast-forward update saves recovery point, preserves data and reuses valid dependencies on repeated updates", async (t) => {
  const f = fixture(t);
  await adoptProject({
    root: f.root,
    source: f.source,
    repository: f.remote,
    expectedCommit: f.first,
  });
  const connection = {
    version: 1,
    proxy: "http://127.0.0.1:12450",
    tlsBackend: "openssl",
    httpVersion: "HTTP/1.1",
  };
  saveGitProfile(f.root, connection);
  write(f.author, "src/value.txt", "version two\n");
  const second = commit(f.author, "second");
  command(f.author, ["push", "-q"]);
  const calls = [],
    result = await updateProject(f.ctx, options(f, calls));
  assert.equal(result.before, f.first);
  assert.equal(result.after, second);
  assert.ok(result.backup);
  assert.deepEqual(
    readJson(path.join(result.backup, "git-connection.json")),
    connection,
  );
  assert.deepEqual(
    readJson(path.join(f.ctx.data, "git-connection.json")),
    connection,
  );
  assert.deepEqual(calls, ["stop", "install", "build"]);
  assert.equal(
    fs.readFileSync(path.join(f.root, ".data/media/original.bin"), "utf8"),
    "irreplaceable media",
  );
  assert.equal(
    readJson(path.join(result.backup, "version.json")).before,
    f.first,
  );
  assert.equal(
    command(f.root, ["show-ref", "--verify", "refs/heads/main"]).split(" ")[0],
    second,
  );
  const repeated = [];
  await updateProject(f.ctx, options(f, repeated));
  assert.deepEqual(repeated, ["stop"]);
  write(
    f.author,
    "package-lock.json",
    JSON.stringify({ lockfileVersion: 3, version: 2 }),
  );
  commit(f.author, "dependency change");
  command(f.author, ["push", "-q"]);
  const changed = [];
  await updateProject(f.ctx, options(f, changed));
  assert.deepEqual(changed, ["stop", "install", "build"]);
});

test("verified installer handoff updates from downloaded objects while the original remote is unavailable", async (t) => {
  const f = fixture(t);
  await adoptProject({
    root: f.root,
    source: f.source,
    repository: f.remote,
    expectedCommit: f.first,
  });
  write(f.author, "src/value.txt", "already downloaded newer version");
  const second = commit(f.author, "second");
  command(f.author, ["push", "-q"]);
  command(f.source, ["fetch", "origin", "main"]);
  fs.renameSync(f.remote, f.remote + ".offline");
  const calls = [];
  const result = await updateProject(f.ctx, {
    ...options(f, calls),
    prefetched: { source: f.source, expectedCommit: f.first },
  });
  assert.equal(result.after, second);
  assert.deepEqual(calls, ["stop", "install", "build"]);
  assert.equal(command(f.root, ["remote", "get-url", "origin"]), f.remote);
  assert.equal(
    fs.readFileSync(path.join(f.root, ".data/media/original.bin"), "utf8"),
    "irreplaceable media",
  );
  assert.equal(
    fs.readFileSync(path.join(f.root, ".env.local"), "utf8"),
    "LOCAL_ONLY_TEST=keep-local\n",
  );
  const repeated = [];
  await updateProject(f.ctx, {
    ...options(f, repeated),
    prefetched: { source: f.source, expectedCommit: f.first },
  });
  assert.deepEqual(repeated, ["stop"]);
});

test("installer handoff refuses mismatched or modified sources before stopping services", async (t) => {
  const f = fixture(t);
  await adoptProject({
    root: f.root,
    source: f.source,
    repository: f.remote,
    expectedCommit: f.first,
  });
  const calls = [];
  await assert.rejects(
    updateProject(f.ctx, {
      ...options(f, calls),
      prefetched: { source: f.source, expectedCommit: "0".repeat(40) },
    }),
    /固定提交校验失败/,
  );
  write(f.source, "src/value.txt", "modified installer");
  await assert.rejects(
    updateProject(f.ctx, {
      ...options(f, calls),
      prefetched: { source: f.source, expectedCommit: f.first },
    }),
    /本地受 Git 管理/,
  );
  assert.deepEqual(calls, []);
  assert.equal(command(f.root, ["rev-parse", "HEAD"]), f.first);
});

test("first-setup CLI migrates and invokes start with all network Git protocols denied", (t) => {
  const f = fixture(t);
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  fs.cpSync(
    path.join(repositoryRoot, "scripts"),
    path.join(f.author, "scripts"),
    { recursive: true },
  );
  write(
    f.author,
    "scripts/manage.mjs",
    "import fs from 'node:fs'; fs.writeFileSync('.data/start-action.json',JSON.stringify({action:process.argv[2]}));\n",
  );
  const expected = commit(f.author, "installer command fixture");
  command(f.author, ["push", "-q"]);
  command(f.source, ["fetch", "origin", "main"]);
  command(f.source, ["merge", "--ff-only", "origin/main"]);
  command(f.source, ["remote", "set-url", "origin", REPOSITORY]);
  // Reuse a prepared build so this command-level fixture never installs packages or launches a web service.
  const lockHash = hash(
    fs.readFileSync(path.join(f.author, "package-lock.json")),
  );
  const marker = { lockHash, nodeMajor: process.versions.node.split(".")[0] };
  writeJson(path.join(f.ctx.runtime, "dependencies.json"), marker);
  writeJson(path.join(f.ctx.runtime, "build.json"), {
    ...marker,
    commit: expected,
  });
  write(f.root, "node_modules/next/package.json", "{}");
  write(f.root, "node_modules/tsx/package.json", "{}");
  write(f.root, ".next/BUILD_ID", "fixture-build");
  const output = execFileSync(
    process.execPath,
    [
      path.join(f.source, "scripts/first-git-setup.mjs"),
      f.root,
      expected,
      "--no-open",
    ],
    {
      cwd: f.root,
      encoding: "utf8",
      env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.ok(output.includes("不重复连接 GitHub"));
  assert.deepEqual(readJson(path.join(f.root, ".data/start-action.json")), {
    action: "start",
  });
  assert.equal(command(f.root, ["rev-parse", "HEAD"]), expected);
  assert.equal(
    fs.readFileSync(path.join(f.root, ".data/media/original.bin"), "utf8"),
    "irreplaceable media",
  );
});

test("tracked local edits and divergent commits stop before services or user code are touched", async (t) => {
  const f = fixture(t);
  await adoptProject({
    root: f.root,
    source: f.source,
    repository: f.remote,
    expectedCommit: f.first,
  });
  write(f.root, "src/value.txt", "my modification\n");
  const calls = [];
  await assert.rejects(
    updateProject(f.ctx, options(f, calls)),
    /本地受 Git 管理/,
  );
  assert.deepEqual(calls, []);
  configure(f.root);
  commit(f.root, "local-only commit");
  write(f.author, "src/value.txt", "remote modification\n");
  commit(f.author, "remote");
  command(f.author, ["push", "-q"]);
  await assert.rejects(updateProject(f.ctx, options(f, calls)), /分叉/);
  assert.deepEqual(calls, []);
  assert.equal(
    fs.readFileSync(path.join(f.root, "src/value.txt"), "utf8"),
    "my modification\n",
  );
});

test("protected remote data and untracked collisions are rejected without deleting existing files", async (t) => {
  const f = fixture(t);
  await adoptProject({
    root: f.root,
    source: f.source,
    repository: f.remote,
    expectedCommit: f.first,
  });
  write(f.author, ".env", "FIXTURE_ONLY=not-a-real-secret\n");
  command(f.author, ["add", "-f", ".env"]);
  command(f.author, ["commit", "-qm", "invalid protected path"]);
  command(f.author, ["push", "-q"]);
  const calls = [];
  await assert.rejects(updateProject(f.ctx, options(f, calls)), /敏感配置路径/);
  assert.deepEqual(calls, []);
  assert.equal(command(f.root, ["rev-parse", "HEAD"]), f.first);
  command(f.author, ["rm", "-q", ".env"]);
  write(f.author, "my-notes.txt", "remote conflicting file");
  commit(f.author, "remove invalid and add collision");
  command(f.author, ["push", "-q"]);
  await assert.rejects(updateProject(f.ctx, options(f, calls)), /Git 操作失败/);
  assert.equal(
    fs.readFileSync(path.join(f.root, "my-notes.txt"), "utf8"),
    "personal notes\n",
  );
  assert.equal(command(f.root, ["rev-parse", "HEAD"]), f.first);
});

test("failed builds retain a consistent database backup and do not report a ready service", async (t) => {
  const f = fixture(t);
  await adoptProject({
    root: f.root,
    source: f.source,
    repository: f.remote,
    expectedCommit: f.first,
  });
  write(f.author, "src/value.txt", "broken version");
  commit(f.author, "update");
  command(f.author, ["push", "-q"]);
  const before = hash(
    fs.readFileSync(path.join(f.root, ".data/studio.sqlite")),
  );
  await assert.rejects(
    updateProject(f.ctx, {
      ...options(f),
      runNpm: async (root, action) => {
        if (action === "build") throw new Error("simulated build failure");
        await fakeNpm(root, action);
      },
    }),
    /服务保持停止/,
  );
  assert.equal(
    hash(fs.readFileSync(path.join(f.root, ".data/studio.sqlite"))),
    before,
  );
  assert.ok(
    fs
      .readdirSync(f.ctx.updates)
      .some((name) => name.startsWith("git-update-")),
  );
  await updateProject(f.ctx, options(f));
  assert.equal(
    readJson(path.join(f.ctx.runtime, "build.json")).commit,
    command(f.root, ["rev-parse", "HEAD"]),
  );
});

test("migration refuses mismatched commits and existing repositories; update lock prevents concurrent mutations", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    adoptProject({
      root: f.root,
      source: f.source,
      repository: f.remote,
      expectedCommit: "0".repeat(40),
    }),
    /提交校验失败/,
  );
  assert.equal(fs.existsSync(path.join(f.root, ".git")), false);
  await adoptProject({
    root: f.root,
    source: f.source,
    repository: f.remote,
    expectedCommit: f.first,
  });
  await assert.rejects(
    adoptProject({
      root: f.root,
      source: f.source,
      repository: f.remote,
      expectedCommit: f.first,
    }),
    /已有仓库/,
  );
  await withUpdateLock(f.ctx, async () => {
    await assert.rejects(
      withUpdateLock(f.ctx, async () => {}),
      /另一个启动或更新/,
    );
  });
  await withUpdateLock(f.ctx, async () => {});
  assert.equal(
    fs.existsSync(path.join(f.ctx.updates, "operation.lock")),
    false,
  );
});
