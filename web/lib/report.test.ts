import { describe, expect, test } from "bun:test";
import { escapeMarkdown, reportMarkdown } from "./report";

describe("escapeMarkdown", () => {
  test("escapes the characters that carry meaning in markdown", () => {
    expect(escapeMarkdown("SQLite [docs] (official)")).toBe("SQLite \\[docs\\] \\(official\\)");
    expect(escapeMarkdown("a*b_c`d")).toBe("a\\*b\\_c\\`d");
  });

  test("flattens newlines so a title cannot break the list", () => {
    expect(escapeMarkdown("first\nsecond")).toBe("first second");
  });
});

describe("reportMarkdown", () => {
  const sources = [
    { title: "SQLite docs", url: "https://sqlite.org/wal.html" },
    { title: "Postgres docs", url: "https://postgresql.org/docs" },
  ];

  test("writes the goal, the answer and a numbered source list", () => {
    expect(reportMarkdown("Pick a database", "## Answer\n\nPostgres.\n", sources)).toBe(
      "# Pick a database\n\n## Answer\n\nPostgres.\n\n## Sources this run used\n\n1. [SQLite docs](<https://sqlite.org/wal.html>)\n2. [Postgres docs](<https://postgresql.org/docs>)\n",
    );
  });

  test("leaves out a source list when the run cited nothing", () => {
    expect(reportMarkdown("Pick a database", "Postgres.", [])).toBe("# Pick a database\n\nPostgres.");
  });

  test("keeps a hand-written run without a goal heading", () => {
    expect(reportMarkdown(null, "Postgres.", [])).toBe("Postgres.");
  });

  test("a title cannot rewrite the link it sits in", () => {
    const hostile = [{ title: "Real](https://evil.example/steal) [", url: "https://sqlite.org/wal.html" }];
    const markdown = reportMarkdown(null, "answer", hostile);

    expect(markdown).toContain("[Real\\]\\(https://evil.example/steal\\) \\[](<https://sqlite.org/wal.html>)");
    expect(markdown).not.toContain("](https://evil.example/steal)");
  });

  test("drops sources the browser should not follow", () => {
    const mixed = [
      { title: "Fine", url: "https://example.com" },
      { title: "Script", url: "javascript:alert(1)" },
    ];

    expect(reportMarkdown(null, "answer", mixed)).toBe("answer\n\n## Sources this run used\n\n1. [Fine](<https://example.com>)\n");
  });

  test("names a source that has no title", () => {
    expect(reportMarkdown(null, "answer", [{ title: "", url: "https://example.com" }])).toContain("1. [Untitled](<https://example.com>)");
  });
});
