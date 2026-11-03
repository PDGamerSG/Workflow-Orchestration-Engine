import { expect, test } from "@playwright/test";

test("workflow inputs wait for workspace initialization before accepting edits", async ({
  page,
}) => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/connections", async (route) => {
    await ready;
    await route.continue();
  });
  try {
    await page.goto("/playground?template=engine-tour");
    await expect(page.getByLabel("Workflow graph")).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByLabel("Workflow graph")).toBeEnabled();
  const graph = '{"steps":[{"id":"one","prompt":"{{one.output}}"}]}';
  await page.getByLabel("Workflow graph").fill(graph);
  await expect(page.getByLabel("Workflow graph")).toHaveValue(graph);
  await page.getByRole("button", { name: "Start demo run" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "invalid graph" }),
  ).toContainText("references itself");
});

test("a visitor launches the tour, inspects a step and exports the result", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Give every agent a place in the plan.",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "3 Join the results" }).click();
  await expect(
    page.getByText("Synthesis starts only after all three inputs succeed.", {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Run the demo" }).click();
  await expect(page).toHaveURL(/\/runs\/run_/);
  await expect(
    page.getByText("Demo simulation.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Download .md" })).toBeVisible({
    timeout: 30_000,
  });
  const traceDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export trace" }).click();
  expect((await traceDownload).suggestedFilename()).toMatch(/-trace.json$/);
  await page.getByRole("tab", { name: /^Timeline/ }).click();
  await expect(
    page
      .getByText("Run finished", { exact: false })
      .or(page.getByText("Run succeeded", { exact: false })),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("the reliability lab retries a transient failure and completes", async ({
  page,
}) => {
  await page.goto("/playground?template=retry-lab");
  await expect(page.getByLabel("Workflow graph")).toContainText(
    "resilient_branch",
  );
  await page.getByRole("button", { name: "Start demo run" }).click();
  await expect(page).toHaveURL(/\/runs\//);
  await expect(page.getByRole("button", { name: "Download .md" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("tab", { name: /^Timeline/ }).click();
  await expect(page.locator('[data-type="step.retrying"]')).toBeVisible();
});

test("JSON validation errors remain actionable and runs can be cancelled", async ({
  page,
}) => {
  await page.goto("/playground?template=engine-tour");
  await page
    .getByLabel("Workflow graph")
    .fill('{"steps":[{"id":"one","prompt":"{{one.output}}"}]}');
  await page.getByRole("button", { name: "Start demo run" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "invalid graph" }),
  ).toContainText("references itself");
  await page
    .getByLabel("Workflow graph")
    .fill(
      '{"steps":[{"id":"one","prompt":"Explain scheduling"},{"id":"two","prompt":"Use {{one.output}}"}]}',
    );
  await page.getByRole("button", { name: "Start demo run" }).click();
  await expect(page.getByRole("button", { name: "Cancel run" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel run" }).click();
  await expect(
    page.getByRole("button", { name: "Delete", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Delete for good" }).click();
  await expect(page).toHaveURL(/\/playground$/);
});

test("another browser context cannot read the current workspace", async ({
  page,
  browser,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Run the demo" }).click();
  await expect(page).toHaveURL(/\/runs\/run_/);
  const id = page.url().split("/").at(-1)!;
  const stranger = await browser.newContext();
  try {
    const response = await stranger.request.get(
      `${new URL(page.url()).origin}/api/runs/${id}`,
    );
    expect(response.status()).toBe(404);
    const listing = await stranger.request.get(
      `${new URL(page.url()).origin}/api/runs`,
    );
    expect((await listing.json()).runs).toEqual([]);
  } finally {
    await stranger.close();
  }
});

test("mobile pages fit the viewport and connection controls are labelled", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/", "/playground", "/connections", "/architecture"]) {
    await page.goto(path);
    await expect(
      page.getByRole("navigation", { name: "Main navigation" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await page.goto("/connections");
  await expect(page.getByLabel("API key", { exact: true })).toHaveAttribute(
    "type",
    "password",
  );
  await expect(
    page.getByRole("button", { name: "Validate & save connection" }),
  ).toBeEnabled();
});
