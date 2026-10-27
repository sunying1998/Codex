import test from "node:test";
import assert from "node:assert/strict";
import { validTrim, rangeFor, credentials } from "../src/lib/validation";
import { hashPassword, verifyPassword } from "../src/lib/auth";
import { sameOrigin, ApiError } from "../src/lib/http";
import { storagePath } from "../src/lib/db";

test("byte ranges support seeking and suffixes, reject malformed and unsatisfiable requests", () => {
  assert.deepEqual(rangeFor("bytes=0-99", 500), { start: 0, end: 99 });
  assert.deepEqual(rangeFor("bytes=100-", 500), { start: 100, end: 499 });
  assert.deepEqual(rangeFor("bytes=-20", 500), { start: 480, end: 499 });
  assert.deepEqual(rangeFor("bytes=-900", 500), { start: 0, end: 499 });
  assert.deepEqual(rangeFor("bytes=400-999", 500), { start: 400, end: 499 });
  for (const input of [
    "bytes=500-",
    "bytes=99-0",
    "bytes=-0",
    "bytes=-",
    "bytes=0-1,3-5",
    "bytes=9007199254740992-",
    "garbage",
  ])
    assert.equal(rangeFor(input, 500), undefined, input);
});
test("clip bounds reject invalid, nonfinite and subframe selections", () => {
  assert.equal(validTrim(0, 3, 3), true);
  assert.equal(validTrim(1, 2, 3), true);
  for (const [start, end, duration] of [
    [-1, 2, 3],
    [2, 1, 3],
    [0, 4, 3],
    [0, 0.01, 3],
    [NaN, 2, 3],
    [0, Infinity, 3],
  ])
    assert.equal(validTrim(start, end, duration), false);
});
test("password hashes are salted and do not authenticate an incorrect password", () => {
  const password = "unit-test-only-long-passphrase";
  const first = hashPassword(password),
    second = hashPassword(password);
  assert.notEqual(first, second);
  assert.equal(verifyPassword(password, first), true);
  assert.equal(verifyPassword("incorrect-password", first), false);
  assert.equal(
    credentials.safeParse({ username: "owner", password: "short" }).success,
    false,
  );
});
test("mutating requests reject absent, foreign and lookalike origins", () => {
  const request = (origin?: string) =>
    new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: origin ? { origin } : {},
    });
  assert.doesNotThrow(() => sameOrigin(request("http://localhost:3000")));
  for (const origin of [
    undefined,
    "http://localhost:3000.evil.example",
    "https://evil.example",
    "null",
  ])
    assert.throws(() => sameOrigin(request(origin)), ApiError);
  assert.throws(
    () =>
      sameOrigin(
        new Request("http://localhost:3000/api/projects", {
          headers: {
            origin: "http://localhost:3000",
            "sec-fetch-site": "cross-site",
          },
        }),
      ),
    ApiError,
  );
});
test("storage paths cannot escape the private data directory", () => {
  assert.throws(() => storagePath("../../etc/passwd"));
  assert.throws(() => storagePath("/etc/passwd"));
  assert.match(
    storagePath("media/project/file.mp4"),
    /media\/project\/file\.mp4$/,
  );
});
