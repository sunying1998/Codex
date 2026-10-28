import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const name = "next-env.d.ts";
const standard = (content) => content.toString("utf8").replaceAll("\r\n", "\n");
const pattern =
  /^\/\/\/ <reference types="next" \/>\n\/\/\/ <reference types="next\/image-types\/global" \/>\nimport "\.\/\.next\/(dev\/)?types\/routes\.d\.ts";\nimport "\.\/\.next\/(dev\/)?types\/root-params\.d\.ts";\n\n\/\/ NOTE: This file should not be edited\n\/\/ see https:\/\/nextjs\.org\/docs\/app\/api-reference\/config\/typescript for more information\.\n$/;
const run = (root, args) =>
  execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });

export function inspectGeneratedNextEnv(root) {
  const file = path.join(root, name);
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    const staged = run(root, ["diff", "--cached", "--name-only", "--", name]);
    if (staged.length) return null;
    const head = run(root, ["show", "HEAD:" + name]);
    const current = fs.readFileSync(file);
    const valid = (content) => {
      const text = standard(content),
        match = pattern.exec(text);
      return match && match[1] === match[2];
    };
    if (!valid(head) || !valid(current)) return null;
    return { file, head, current };
  } catch {
    return null;
  }
}

export function prepareGeneratedNextEnv(root, backup) {
  const snapshot = inspectGeneratedNextEnv(root);
  if (!snapshot)
    throw new Error("next-env.d.ts 含自定义或暂存修改，未自动处理。");
  const folder = path.join(backup, "generated-next-env");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, name), snapshot.current, { flag: "wx" });
  fs.writeFileSync(path.join(folder, "tracked-next-env.d.ts"), snapshot.head, {
    flag: "wx",
  });
  if (!fs.readFileSync(snapshot.file).equals(snapshot.current))
    throw new Error("next-env.d.ts 在备份期间发生变化，未覆盖。");
  fs.writeFileSync(snapshot.file, snapshot.head);
  return snapshot;
}

export function preserveGeneratedNextEnv(snapshot, mergeFailed = false) {
  if (!fs.existsSync(snapshot.file)) {
    if (!mergeFailed)
      fs.writeFileSync(snapshot.file, snapshot.current, { flag: "wx" });
  } else if (
    mergeFailed &&
    fs.lstatSync(snapshot.file).isFile() &&
    fs.readFileSync(snapshot.file).equals(snapshot.head)
  ) {
    fs.writeFileSync(snapshot.file, snapshot.current);
  }
}
