import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { demoConfigFromEnv, isLoginAllowed, isRecipientAllowed } from "../src/outreach/demo.js";
import { draftHash } from "../src/outreach/hash.js";

const cfg = demoConfigFromEnv({
  DEMO_MODE: "true",
  DEMO_ALLOWED_LOGINS: "fake-owner, Fake-Friend",
  SEND_ALLOWED_RECIPIENTS: "owner@example.test, Friend@Example.test",
});

describe("send recipient allowlist", () => {
  it("refuses a non-allowlisted recipient", () => {
    expect(isRecipientAllowed(cfg, "stranger@example.test")).toBe(false);
  });

  it("allows listed recipients case-insensitively", () => {
    expect(isRecipientAllowed(cfg, "owner@example.test")).toBe(true);
    expect(isRecipientAllowed(cfg, " friend@example.test ")).toBe(true);
  });

  it("refuses everyone when the allowlist is empty (the default mode)", () => {
    expect(isRecipientAllowed(demoConfigFromEnv({ DEMO_MODE: "true" }), "owner@example.test")).toBe(false);
    expect(isRecipientAllowed(demoConfigFromEnv({}), "owner@example.test")).toBe(false);
  });

  it("applies the allowlist whether or not demo mode is on", () => {
    const off = demoConfigFromEnv({ DEMO_MODE: "false", SEND_ALLOWED_RECIPIENTS: "owner@example.test" });
    expect(isRecipientAllowed(off, "stranger@example.test")).toBe(false);
    expect(isRecipientAllowed(off, "owner@example.test")).toBe(true);
  });

  it("allows anyone only when SEND_MODE is open", () => {
    const open = demoConfigFromEnv({ SEND_MODE: " OPEN " });
    expect(open.sendMode).toBe("open");
    expect(isRecipientAllowed(open, "stranger@example.test")).toBe(true);
  });

  it("treats empty or allowlist SEND_MODE as the default and throws on anything else", () => {
    expect(demoConfigFromEnv({ SEND_MODE: "" }).sendMode).toBe("allowlist");
    expect(demoConfigFromEnv({ SEND_MODE: "Allowlist" }).sendMode).toBe("allowlist");
    for (const v of ["true", "yes", "opne", "all"]) {
      expect(() => demoConfigFromEnv({ SEND_MODE: v })).toThrow(/SEND_MODE/);
    }
  });

  it("ignores the old DEMO_ALLOWED_RECIPIENTS name", () => {
    const old = demoConfigFromEnv({ DEMO_ALLOWED_RECIPIENTS: "owner@example.test" });
    expect(isRecipientAllowed(old, "owner@example.test")).toBe(false);
  });

  it("accepts true and false case-insensitively and treats empty or unset as off", () => {
    expect(demoConfigFromEnv({ DEMO_MODE: "TRUE" }).enabled).toBe(true);
    expect(demoConfigFromEnv({ DEMO_MODE: " True " }).enabled).toBe(true);
    expect(demoConfigFromEnv({ DEMO_MODE: "false" }).enabled).toBe(false);
    expect(demoConfigFromEnv({ DEMO_MODE: "" }).enabled).toBe(false);
    expect(demoConfigFromEnv({}).enabled).toBe(false);
  });

  it.each(["1", "yes", "on", "ture", "enabled"])("throws on the unrecognised DEMO_MODE %s", (v) => {
    expect(() => demoConfigFromEnv({ DEMO_MODE: v })).toThrow(/DEMO_MODE/);
  });
});

describe("demo mode login allowlist", () => {
  it("filters logins", () => {
    expect(isLoginAllowed(cfg, "fake-owner")).toBe(true);
    expect(isLoginAllowed(cfg, "fake-friend")).toBe(true);
    expect(isLoginAllowed(cfg, "someone-else")).toBe(false);
  });
});

describe("draftHash", () => {
  it("is sha256 of subject, newline, body", () => {
    expect(draftHash("a", "b")).toBe(createHash("sha256").update("a\nb").digest("hex"));
    expect(draftHash("a", "b")).toMatch(/^[0-9a-f]{64}$/);
    expect(draftHash("a", "b")).not.toBe(draftHash("a\n", "b"));
    expect(draftHash("a", "b")).toBe(draftHash("a", "b"));
  });
});
