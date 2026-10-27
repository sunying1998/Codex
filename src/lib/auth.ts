import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { NextResponse } from "next/server";
import { db, transaction } from "./db";
import { ApiError } from "./http";
import type { User } from "./types";

const cookieName = "yingke_session";
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password: string, stored: string) {
  const [salt, value] = stored.split(":");
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(value, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
export function currentUser(request: Request): User | undefined {
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return;
  return db()
    .prepare(
      "SELECT u.id,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?",
    )
    .get(digest(token), Date.now()) as User | undefined;
}
export function requireUser(request: Request) {
  const user = currentUser(request);
  if (!user) throw new ApiError(401, "请先登录工作室。");
  return user;
}
export function initialized() {
  return !!db().prepare("SELECT 1 FROM users LIMIT 1").get();
}
export function throttle(key: string) {
  transaction(() => {
    const now = Date.now();
    db().prepare("DELETE FROM auth_attempts WHERE reset_at<?").run(now);
    const row = db()
      .prepare("SELECT count FROM auth_attempts WHERE key=?")
      .get(key) as { count: number } | undefined;
    if (row && row.count >= 10)
      throw new ApiError(429, "尝试次数过多，请在十分钟后重试。");
    db()
      .prepare(
        "INSERT INTO auth_attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",
      )
      .run(key, now + 600_000);
  });
}
export function createOwner(username: string, password: string): User {
  const hash = hashPassword(password);
  return transaction(() => {
    if (initialized()) throw new ApiError(409, "工作室已初始化，请直接登录。");
    const id = randomUUID();
    db()
      .prepare("INSERT INTO users VALUES(?,?,?,?)")
      .run(id, username, hash, Date.now());
    return { id, username };
  });
}
export function loginUser(username: string, password: string): User {
  // Global limit also covers nonexistent usernames, preventing username rotation.
  throttle("login");
  const row = db()
    .prepare("SELECT * FROM users WHERE username=?")
    .get(username) as (User & { password: string }) | undefined;
  const valid = verifyPassword(
    password,
    row?.password || "00000000000000000000000000000000:" + "00".repeat(64),
  );
  if (!row || !valid) throw new ApiError(401, "账号或密码不正确。");
  db().prepare("DELETE FROM auth_attempts WHERE key='login'").run();
  return { id: row.id, username: row.username };
}
export function sessionResponse(user: User, request: Request) {
  const token = randomBytes(32).toString("hex");
  const seconds = 7 * 24 * 3600;
  db().prepare("DELETE FROM sessions WHERE expires_at<?").run(Date.now());
  db()
    .prepare("INSERT INTO sessions VALUES(?,?,?)")
    .run(digest(token), user.id, Date.now() + seconds * 1000);
  const response = NextResponse.json({ user });
  const secure =
    new URL(process.env.APP_ORIGIN || request.url).protocol === "https:";
  response.cookies.set(cookieName, token, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/",
    maxAge: seconds,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
export function logout(request: Request) {
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);
  if (token)
    db().prepare("DELETE FROM sessions WHERE token=?").run(digest(token));
  const response = NextResponse.json({ ok: true });
  response.cookies.set(cookieName, "", {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return response;
}
