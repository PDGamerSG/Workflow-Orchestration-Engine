import { describe, expect, test } from "bun:test";
import { mapCompletion, OpenAiCompatibleProvider, retryAfterMs } from "./openai-compatible";
import { LlmError } from "./provider";

function providerReturning(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers });
  }) as unknown as typeof fetch;
  const provider = new OpenAiCompatibleProvider({ baseUrl: "https://api.example.com/v1/", apiKey: "secret", model: "m", fetchImpl });
  return { provider, calls };
}

describe("OpenAiCompatibleProvider", () => {
  test("sends a chat completion and reads text and usage", async () => {
    const { provider, calls } = providerReturning(200, {
      choices: [{ message: { content: "hello" } }],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    });
    const schema = { type: "object", properties: { a: { type: "string" } } };

    const result = await provider.generate({ prompt: "hi", jsonSchema: schema, signal: new AbortController().signal });

    expect(result).toEqual({ text: "hello", sources: [], usage: { inputTokens: 12, outputTokens: 5, searchCalls: 0 } });
    const [call] = calls;
    expect(call!.url).toBe("https://api.example.com/v1/chat/completions");
    expect((call!.init.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect(JSON.parse(call!.init.body as string)).toEqual({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_schema", json_schema: { name: "response", schema, strict: false } },
    });
  });

  test("turns a 429 into an LlmError with the retry delay", async () => {
    const { provider } = providerReturning(429, { error: { message: "Rate limit reached" } }, { "retry-after": "7" });

    const err = await provider.generate({ prompt: "hi", signal: new AbortController().signal }).catch((e) => e);

    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ status: 429, retryAfterMs: 7_000, message: "Rate limit reached" });
  });

  test("lets an abort pass through untouched", async () => {
    const fetchImpl = (async () => {
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    const provider = new OpenAiCompatibleProvider({ baseUrl: "https://x", apiKey: "k", model: "m", fetchImpl });

    const err = await provider.generate({ prompt: "hi", signal: new AbortController().signal }).catch((e) => e);

    expect(err).not.toBeInstanceOf(LlmError);
    expect(err.name).toBe("AbortError");
  });
});

describe("mapCompletion", () => {
  test("reports an error body without choices as a provider failure", () => {
    expect(() => mapCompletion({ error: { message: "Provider returned error", code: 429, metadata: { raw: "upstream busy" } } })).toThrow(
      expect.objectContaining({ status: 429, message: "Provider returned error: upstream busy" }),
    );
    expect(() => mapCompletion({})).toThrow(expect.objectContaining({ status: 502 }));
  });
});

describe("retryAfterMs", () => {
  test("reads seconds and ignores anything else", () => {
    expect(retryAfterMs("2.5")).toBe(2_500);
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBeUndefined();
  });
});
