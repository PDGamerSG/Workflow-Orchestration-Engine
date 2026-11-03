import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProvider } from "./provider";

let directory: string;
let executable: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "relay-agent-fixture-"));
  executable = join(directory, "agent");
  await writeFile(executable, `#!/usr/bin/env node
let input = ''; for await (const chunk of process.stdin) input += chunk;
if (input === 'hang') { setInterval(() => {}, 1000); }
else if (input === 'overflow') { process.stdout.write('x'.repeat(20000)); }
else if (input === 'exit') { process.stderr.write('private upstream diagnostic'); process.exit(7); }
else if (input === 'error') { console.log(JSON.stringify({type:'result',is_error:true,result:'auth failed'})); }
else if (process.argv.includes('--output-format')) {
 console.log(JSON.stringify({type:'result',is_error:false,result:input,usage:{input_tokens:10,output_tokens:4,cache_read_input_tokens:5}}));
} else if (process.argv.includes('exec')) {
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:input}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:6}}));
} else {
 console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:input}],usage:{input:8,output:3,cacheRead:2}}}));
 console.log(JSON.stringify({type:'agent_end',messages:[]}));
}
`);
  await chmod(executable, 0o700);
});
afterAll(() => rm(directory, { recursive: true, force: true }));

describe("local agent subprocess adapters", () => {
  for (const [agent, inputTokens, outputTokens] of [["pi", 10, 3], ["claude-code", 15, 4], ["codex", 12, 6]] as const) {
    test(`${agent} sends a literal stdin prompt and parses final text/usage`, async () => {
      const provider = new AgentProvider({ agent, cwd: directory, executable });
      const result = await provider.generate({ prompt: "literal $(touch injected) `whoami` \u2028 message", signal: new AbortController().signal });
      expect(result.text).toBe("literal $(touch injected) `whoami` \u2028 message");
      expect(result.usage).toEqual({ inputTokens, outputTokens, searchCalls: 0 });
      expect(await Bun.file(join(directory, "injected")).exists()).toBe(false);
    });
  }

  test("handles a result that reports an error even when the process exits zero", async () => {
    const provider = new AgentProvider({ agent: "claude-code", cwd: directory, executable });
    await expect(provider.generate({ prompt: "error", signal: new AbortController().signal })).rejects.toThrow("reported a failed run");
  });

  test("stops a hanging process on cancellation", async () => {
    const provider = new AgentProvider({ agent: "pi", cwd: directory, executable });
    await expect(provider.generate({ prompt: "hang", signal: AbortSignal.timeout(100) })).rejects.toThrow();
  });

  test("rejects excessive output and nonzero exits without exposing diagnostics", async () => {
    const provider = new AgentProvider({ agent: "pi", cwd: directory, executable, maxOutputBytes: 1024 });
    await expect(provider.generate({ prompt: "overflow", signal: new AbortController().signal })).rejects.toThrow("output limit");
    await expect(provider.generate({ prompt: "exit", signal: new AbortController().signal })).rejects.toThrow("exited with code 7");
  });
});
