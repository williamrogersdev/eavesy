import { describe, expect, test } from "bun:test";
import { buildTemplate, RESOURCE_TEMPLATES } from "./resource-templates";

describe("editable resource output", () => {
  test("keeps missing evidence explicit and includes every labeled field", () => {
    for (const template of Object.values(RESOURCE_TEMPLATES)) {
      const output = buildTemplate(template, {});
      for (const field of template.fields)
        expect(output).toContain(`## ${field.label}\n\n[Not provided]`);
      expect(output).not.toContain(template.fields[0].example);
    }
  });
  test("preserves user observations, code, and source lines without adding sample facts", () => {
    const output = buildTemplate(RESOURCE_TEMPLATES["ai-bug-report"], {
      observed: "  Export fails with `rowCount = 2`.\nNo cause established.  ",
      evidence: "capture/context.md\nScreenshot 00:12",
    });
    expect(output).toContain(
      "Export fails with `rowCount = 2`.\nNo cause established.",
    );
    expect(output).toContain("capture/context.md\nScreenshot 00:12");
    expect(output).not.toContain("Alpha");
  });
});
