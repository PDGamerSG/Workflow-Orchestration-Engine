import { describe, expect, test } from "bun:test";
import { formatAge, formatCost, formatDuration, formatTokens, tryPrettyJson, webUrl } from "./format";

describe("webUrl", () => {
  test("passes http and https through", () => {
    expect(webUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(webUrl("http://example.com")).toBe("http://example.com");
  });

  test("rejects anything the browser should not follow from a model's answer", () => {
    expect(webUrl("javascript:alert(1)")).toBeNull();
    expect(webUrl("JaVaScRiPt:alert(1)")).toBeNull();
    expect(webUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(webUrl("file:///etc/passwd")).toBeNull();
    expect(webUrl("/relative/path")).toBeNull();
    expect(webUrl("")).toBeNull();
  });
});

describe("formatting", () => {
  test("keeps small costs readable and rounds larger ones", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.0021)).toBe("$0.0021");
    expect(formatCost(1.239)).toBe("$1.24");
  });

  test("shortens token counts", () => {
    expect(formatTokens(940)).toBe("940");
    expect(formatTokens(4_600)).toBe("4.6k");
    expect(formatTokens(250_000)).toBe("250k");
  });

  test("scales durations from milliseconds to minutes", () => {
    expect(formatDuration(430)).toBe("430 ms");
    expect(formatDuration(3_900)).toBe("3.9 s");
    expect(formatDuration(95_000)).toBe("1 min 35 s");
  });

  test("reads ages relative to now", () => {
    const now = 1_000_000_000;
    expect(formatAge(now - 5_000, now)).toBe("5 s ago");
    expect(formatAge(now - 120_000, now)).toBe("2 min ago");
    expect(formatAge(now - 7_200_000, now)).toBe("2 h ago");
  });

  test("pretty-prints JSON output but leaves prose alone", () => {
    expect(tryPrettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(tryPrettyJson("## Not JSON")).toBeNull();
    expect(tryPrettyJson("42")).toBeNull();
  });
});
