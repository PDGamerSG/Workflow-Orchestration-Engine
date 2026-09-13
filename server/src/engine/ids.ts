import { randomBytes } from "node:crypto";

/** Run ids sort by creation time: `run_` + base36 milliseconds + 8 random hex chars. */
export function newRunId(now: number): string {
  return `run_${now.toString(36)}${randomBytes(4).toString("hex")}`;
}
