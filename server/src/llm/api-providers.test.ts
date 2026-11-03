import { expect, test } from "bun:test";
import { OpenAiProvider } from "./openai";
import { AnthropicProvider } from "./anthropic";

test("OpenAI Responses maps final text and usage and disables response storage", async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_url: unknown, init: RequestInit) => {
    body = JSON.parse(init.body as string);
    return Response.json({
      status: "completed",
      output: [
        { type: "reasoning" },
        {
          type: "message",
          content: [{ type: "output_text", text: "A saved result" }],
        },
      ],
      usage: { input_tokens: 123, output_tokens: 14 },
    });
  }) as unknown as typeof fetch;
  const provider = new OpenAiProvider({
    model: "test",
    apiKey: "secret",
    fetchImpl,
  });
  const result = await provider.generate({
    prompt: "Explain",
    signal: new AbortController().signal,
  });
  expect(result).toEqual({
    text: "A saved result",
    sources: [],
    usage: { inputTokens: 123, outputTokens: 14, searchCalls: 0 },
  });
  expect(body.store).toBe(false);
  expect(body.input).toBe("Explain");
});

test("Anthropic Messages maps text blocks and measured usage", async () => {
  const provider = new AnthropicProvider({
    model: "test",
    apiKey: "secret",
    fetchImpl: (async () =>
      Response.json({
        stop_reason: "end_turn",
        content: [
          { type: "text", text: "One" },
          { type: "text", text: "Two" },
        ],
        usage: { input_tokens: 80, output_tokens: 12 },
      })) as unknown as typeof fetch,
  });
  expect(
    await provider.generate({
      prompt: "Explain",
      signal: new AbortController().signal,
    }),
  ).toEqual({
    text: "One\nTwo",
    sources: [],
    usage: { inputTokens: 80, outputTokens: 12, searchCalls: 0 },
  });
});

test("provider errors and incomplete responses cannot masquerade as successful steps", async () => {
  for (const Provider of [OpenAiProvider, AnthropicProvider]) {
    const provider = new Provider({
      model: "test",
      apiKey: "secret",
      fetchImpl: (async () =>
        Response.json(
          { error: { message: "secret key was rejected" } },
          { status: 401 },
        )) as unknown as typeof fetch,
    });
    await expect(
      provider.generate({
        prompt: "Explain",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("HTTP 401");
  }
  const provider = new OpenAiProvider({
    model: "test",
    apiKey: "secret",
    fetchImpl: (async () =>
      Response.json({
        status: "incomplete",
        output: [
          { content: [{ type: "output_text", text: "Partial result" }] },
        ],
      })) as unknown as typeof fetch,
  });
  await expect(
    provider.generate({
      prompt: "Explain",
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("did not complete");
});

test("Anthropic rejects truncated and non-text responses", async () => {
  for (const response of [
    {
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "Unfinished result" }],
    },
    {
      stop_reason: "end_turn",
      content: [{ type: "thinking", thinking: "No final answer" }],
    },
  ]) {
    const provider = new AnthropicProvider({
      model: "test",
      apiKey: "secret",
      fetchImpl: (async () =>
        Response.json(response)) as unknown as typeof fetch,
    });
    await expect(
      provider.generate({
        prompt: "Explain",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
  }
});
