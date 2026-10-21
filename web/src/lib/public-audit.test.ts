import { expect, test } from "bun:test";
import { isPrivateAuditPath, isPublicAuditDestination } from "./public-audit";
test("asset redirects must end at a public path on the audited origin", () => {
  const origin = "https://eavesy.com";
  expect(
    isPublicAuditDestination(
      origin,
      `${origin}/resources/examples/workspace-demo`,
    ),
  ).toBe(true);
  expect(
    isPublicAuditDestination(origin, "https://other.example/resources/demo"),
  ).toBe(false);
  for (const path of [
    "/sign-in",
    "/sign-up/verify",
    "/app",
    "/app/settings",
    "/api/file",
    "/connect/mac",
    "/onboarding",
  ]) {
    expect(isPrivateAuditPath(path)).toBe(true);
    expect(isPublicAuditDestination(origin, origin + path)).toBe(false);
  }
  expect(isPublicAuditDestination(origin, origin + "/guides/api-context")).toBe(
    true,
  );
});
