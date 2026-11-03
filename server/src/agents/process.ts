import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { LlmError } from "../llm/provider";

/** A bounded, cancellable child process. Prompts are stdin data, never shell source. */
export function runProcess(options: { executable: string; args: string[]; cwd: string; input: string; signal: AbortSignal; maxOutputBytes: number }): Promise<string> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(options.executable, options.args, { cwd: options.cwd, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const decoder = new StringDecoder("utf8");
    let bytes = 0;
    let failure: unknown;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      const send = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch { /* The process may have exited between event delivery and kill. */ }
      };
      send("SIGTERM");
      killTimer ??= setTimeout(() => send("SIGKILL"), 250);
      killTimer.unref();
    };
    const abort = () => { failure = options.signal.reason ?? new DOMException("Cancelled", "AbortError"); kill(); };
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    const count = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > options.maxOutputBytes && !failure) { failure = new LlmError("Agent exceeded its output limit", { status: 400 }); kill(); }
    };
    child.stdout.on("data", (chunk: Buffer) => { count(chunk); if (!failure) output += decoder.write(chunk); });
    child.stderr.on("data", count);
    child.stdin.on("error", () => {});
    child.on("error", () => {
      failure = new LlmError("Could not launch the local agent. Check that its CLI is installed and the working directory exists.", { status: 400 });
    });
    child.on("close", (code) => {
      options.signal.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new LlmError(`Local agent exited with code ${code ?? "unknown"}. Check its authentication and CLI version.`, { status: 400 }));
      else resolve(output + decoder.end());
    });
    child.stdin.end(options.input);
  });
}
