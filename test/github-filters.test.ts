import { describe, expect, it } from "vitest";
import { contactRoutes } from "../src/github/contact.js";
import { excludeReason, type FilterContext } from "../src/github/filters.js";
import { SEED_REPOS } from "../src/github/seeds.js";
import { demoConfigFromEnv } from "../src/outreach/demo.js";

const ctx = (over: Partial<FilterContext> = {}): FilterContext => ({
  excludedLogins: new Set(["fake-trigger-person"]),
  suppressedIds: new Set([9]),
  liveIds: new Set([8]),
  demo: { enabled: false, allowedLogins: [], allowedRecipients: [], sendMode: "allowlist" },
  ...over,
});

const p = (over: Record<string, unknown> = {}) => ({ id: 1, login: "fake-dev-one", type: "User", ...over });

describe("excludeReason truth table", () => {
  it.each([
    ["plain user", p(), null],
    ["type Bot", p({ type: "Bot" }), "bot"],
    ["login ends [bot]", p({ login: "dependabot[bot]" }), "bot"],
    ["organization", p({ type: "Organization" }), "organization"],
    ["triggerdotdev person (case-insensitive)", p({ login: "Fake-Trigger-Person" }), "triggerdotdev_person"],
    ["bio mentions trigger.dev", p({ bio: "I work on Trigger.dev things" }), "mentions_triggerdotdev"],
    ["company mentions triggerdotdev", p({ company: "@triggerdotdev" }), "mentions_triggerdotdev"],
    ["suppressed", p({ id: 9 }), "suppressed"],
    ["already live outreach", p({ id: 8 }), "already_contacted"],
    ["bio mentions a different trigger", p({ bio: "I like triggers in postgres" }), null],
  ] as const)("%s -> %s", (_name, profile, expected) => {
    expect(excludeReason(profile, ctx())).toBe(expected);
  });
});

describe("DEMO_ALLOWED_LOGINS filter", () => {
  const demo = demoConfigFromEnv({ DEMO_MODE: "true", DEMO_ALLOWED_LOGINS: "Arthurobo" });

  it("passes only allowlisted logins when demo mode is on", () => {
    expect(excludeReason(p({ login: "arthurobo" }), ctx({ demo }))).toBeNull();
    expect(excludeReason(p({ login: "fake-dev-one" }), ctx({ demo }))).toBe("demo_not_allowed");
  });

  it("does not filter when demo mode is off", () => {
    const off = demoConfigFromEnv({ DEMO_MODE: "false", DEMO_ALLOWED_LOGINS: "Arthurobo" });
    expect(excludeReason(p({ login: "fake-dev-one" }), ctx({ demo: off }))).toBeNull();
  });

  it("filters everyone when demo mode is on with an empty allowlist", () => {
    const empty = demoConfigFromEnv({ DEMO_MODE: "true" });
    expect(excludeReason(p(), ctx({ demo: empty }))).toBe("demo_not_allowed");
  });
});

describe("contactRoutes provenance", () => {
  it("builds routes only from profile-published fields with provenance", () => {
    const routes = contactRoutes({
      email: "fake.dev@example.test",
      twitter_username: "fake_dev",
      blog: "fake-dev.example.test/blog",
    });
    expect(routes).toEqual([
      { channel: "email", value: "fake.dev@example.test", provenance: "email published on GitHub profile" },
      { channel: "twitter", value: "@fake_dev", provenance: "X/Twitter handle published on GitHub profile" },
      { channel: "web", value: "https://fake-dev.example.test/blog", provenance: "website published on GitHub profile" },
    ]);
  });

  it("never invents a route from missing, empty or invalid fields", () => {
    expect(contactRoutes({})).toEqual([]);
    expect(contactRoutes({ email: null, twitter_username: null, blog: "" })).toEqual([]);
    expect(contactRoutes({ email: "not an email", twitter_username: "bad handle!", blog: "javascript:alert(1)" })).toEqual([]);
  });

  it("rejects noreply commit-style addresses", () => {
    expect(contactRoutes({ email: "123+fake@users.noreply.github.com" })).toEqual([]);
  });

  it("has no input that can carry a commit email", () => {
    const routes = contactRoutes({ email: null, blog: null } as never);
    expect(routes).toEqual([]);
  });
});

describe("seed repos", () => {
  it("includes the demo repo first and no triggerdotdev repos", () => {
    expect(SEED_REPOS[0]?.repo).toBe("Arthurobo/agentflow");
    expect(SEED_REPOS.some((s) => s.repo.toLowerCase().startsWith("triggerdotdev/"))).toBe(false);
    expect(new Set(SEED_REPOS.map((s) => s.repo)).size).toBe(SEED_REPOS.length);
  });
});
