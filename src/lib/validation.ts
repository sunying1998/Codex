import { z } from "zod";
export const credentials = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(60)
    .regex(/^[a-zA-Z0-9_@.\-]+$/),
  password: z.string().min(12).max(128),
});
export const projectInput = z.object({
  title: z.string().trim().min(1).max(80),
});
export const projectUpdate = projectInput.extend({
  version: z.number().int().positive(),
  trim_start: z.number().finite().min(0),
  trim_end: z.number().finite().min(0),
});
export function validTrim(start: number, end: number, duration: number) {
  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    end > start &&
    end <= duration + 0.05 &&
    end - start >= 0.1
  );
}
export function rangeFor(
  header: string,
  size: number,
): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size <= 0) return;
  const start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  const end = match[1]
    ? match[2]
      ? Math.min(Number(match[2]), size - 1)
      : size - 1
    : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size ||
    (!match[1] && Number(match[2]) === 0)
  )
    return;
  return { start, end };
}
