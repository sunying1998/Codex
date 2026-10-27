import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { control, stopRuntime } from "../scripts/lib/control.mjs";
import { delay, readJson } from "../scripts/lib/project.mjs";

test(
  "managed runtime authenticates local control, processes media, stops only its services and resumes interrupted work",
  { timeout: 120000 },
  async () => {
    const root = fs.realpathSync(process.cwd()),
      data = fs.mkdtempSync(path.join(os.tmpdir(), "yingke-managed-"));
    const ctx = { root, data, runtime: path.join(data, "runtime") };
    const socket = net.createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    const origin = `http://127.0.0.1:${port}`,
      env = {
        ...process.env,
        YINGKE_PROJECT_ROOT: root,
        YINGKE_DATA_DIR: data,
        PORT: String(port),
      };
    let child,
      cookie = "",
      logs = "";
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { stdio: "ignore" },
    );
    function launch() {
      child = spawn(process.execPath, ["scripts/runtime.mjs"], {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (chunk) => {
          logs = (logs + chunk).slice(-15000);
        });
    }
    async function ready() {
      for (let n = 0; n < 180; n++) {
        const state = await control(ctx);
        if (state?.ready) return state;
        if (child.exitCode !== null) throw new Error(logs);
        await delay(200);
      }
      throw new Error("Managed readiness timed out: " + logs);
    }
    async function request(route, options = {}) {
      const response = await fetch(origin + route, {
        ...options,
        headers: {
          origin,
          cookie,
          ...(typeof options.body === "string"
            ? { "Content-Type": "application/json" }
            : {}),
          ...options.headers,
        },
      });
      assert.ok(response.ok, await response.clone().text());
      return response;
    }
    async function job(id, terminal = true) {
      for (let n = 0; n < 300; n++) {
        const current = (await (await request("/api/jobs/" + id)).json()).job;
        if (
          terminal &&
          ["succeeded", "failed", "cancelled"].includes(current.status)
        )
          return current;
        if (!terminal && current.status === "running") return current;
        await delay(20);
      }
      throw new Error("Managed job did not reach expected state");
    }
    try {
      const fixture = path.join(data, "test.mp4");
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1280x720:rate=24",
        "-t",
        "8",
        "-c:v",
        "libx264",
        "-threads",
        "1",
        fixture,
      ]);
      launch();
      await ready();
      const state = readJson(path.join(ctx.runtime, "control.json"));
      const forbidden = await fetch(
        `http://127.0.0.1:${state.controlPort}/status`,
      );
      assert.equal(forbidden.status, 403);
      const setup = await request("/api/auth/setup", {
        method: "POST",
        body: JSON.stringify({
          username: "managed_test",
          password: "managed-test-only-passphrase",
        }),
      });
      cookie = setup.headers.get("set-cookie").split(";")[0];
      const project = (
        await (
          await request("/api/projects", {
            method: "POST",
            body: JSON.stringify({ title: "Managed runtime validation" }),
          })
        ).json()
      ).project;
      const form = new FormData();
      form.append("file", new Blob([fs.readFileSync(fixture)]), "test.mp4");
      const upload = await (
        await request("/api/projects/" + project.id + "/assets?kind=source", {
          method: "POST",
          body: form,
        })
      ).json();
      assert.equal((await job(upload.jobId)).status, "succeeded");
      const exported = (
        await (
          await request("/api/projects/" + project.id + "/export", {
            method: "POST",
            headers: { "Idempotency-Key": "managed-export-validation" },
          })
        ).json()
      ).job;
      await job(exported.id, false);
      await stopRuntime(ctx);
      const exited = child.exitCode !== null ? null : once(child, "exit");
      if (exited) await exited;
      assert.equal(unrelated.exitCode, null);
      let db = new DatabaseSync(path.join(data, "studio.sqlite"), {
        readOnly: true,
      });
      assert.equal(
        db.prepare("SELECT status FROM jobs WHERE id=?").get(exported.id)
          .status,
        "queued",
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM worker_lock").get().n,
        0,
      );
      db.close();
      launch();
      await ready();
      assert.equal((await job(exported.id)).status, "succeeded");
      const output = await request("/api/jobs/" + exported.id + "/download");
      assert.ok((await output.arrayBuffer()).byteLength > 1000);
      await stopRuntime(ctx);
      if (child.exitCode === null) await once(child, "exit");
      db = new DatabaseSync(path.join(data, "studio.sqlite"), {
        readOnly: true,
      });
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 1);
      db.close();
      assert.equal(unrelated.exitCode, null);
      assert.equal(
        fs.existsSync(path.join(ctx.runtime, "control.json")),
        false,
      );
    } catch (error) {
      console.error(logs);
      throw error;
    } finally {
      try {
        await stopRuntime(ctx);
      } catch {}
      if (child?.exitCode === null) child.kill("SIGTERM");
      unrelated.kill("SIGTERM");
      await delay(100);
      fs.rmSync(data, { recursive: true, force: true });
    }
  },
);
