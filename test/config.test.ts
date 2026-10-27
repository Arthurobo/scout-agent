import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, missingEnv, requireGitHubToken } from "../src/config.js";
import { createModel, modelSettings } from "../src/model.js";

describe("loadConfig", () => {
  it("parses comma lists and applies defaults", () => {
    const cfg = loadConfig(["APPROVER_SLACK_IDS", "DEMO_ALLOWED_LOGINS", "MODEL_ID", "DEMO_MODE"], {
      APPROVER_SLACK_IDS: "U1, U2 ,",
    });
    expect(cfg.APPROVER_SLACK_IDS).toEqual(["U1", "U2"]);
    expect(cfg.DEMO_ALLOWED_LOGINS).toEqual([]);
    expect(cfg.MODEL_ID).toBe("deepseek/deepseek-v4.1-flash");
    expect(cfg.DEMO_MODE).toBe("false");
  });

  it("names every missing variable and never includes values", () => {
    let message = "";
    try {
      loadConfig(["SLACK_BOT_TOKEN", "DATABASE_URL", "APPROVER_SLACK_IDS"], {
        DATABASE_URL: "   ",
        APPROVER_SLACK_IDS: "",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain("SLACK_BOT_TOKEN");
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("APPROVER_SLACK_IDS");
  });

  it("normalises DEMO_MODE and rejects typos instead of failing open", () => {
    expect(loadConfig(["DEMO_MODE"], { DEMO_MODE: " TRUE " }).DEMO_MODE).toBe("true");
    expect(loadConfig(["DEMO_MODE"], { DEMO_MODE: "False" }).DEMO_MODE).toBe("false");
    expect(loadConfig(["DEMO_MODE"], { DEMO_MODE: "" }).DEMO_MODE).toBe("false");
    for (const v of ["1", "yes", "ture"]) {
      expect(() => loadConfig(["DEMO_MODE"], { DEMO_MODE: v })).toThrow(ConfigError);
    }
  });

  it("does not leak a rejected value into the error", () => {
    expect(() => loadConfig(["DEMO_MODE"], { DEMO_MODE: "super-secret-value" })).toThrow(
      /^Missing or invalid environment variables: DEMO_MODE$/,
    );
  });

  it("missingEnv lists the absent names", () => {
    expect(missingEnv(["SLACK_BOT_TOKEN", "OPENROUTER_API_KEY"], { OPENROUTER_API_KEY: "k" })).toEqual([
      "SLACK_BOT_TOKEN",
    ]);
  });
});

describe("send mode and signature settings", () => {
  it("defaults SEND_MODE to allowlist, normalises it and rejects typos", () => {
    expect(loadConfig(["SEND_MODE"], {}).SEND_MODE).toBe("allowlist");
    expect(loadConfig(["SEND_MODE"], { SEND_MODE: " OPEN " }).SEND_MODE).toBe("open");
    expect(loadConfig(["SEND_MODE"], { SEND_MODE: "" }).SEND_MODE).toBe("allowlist");
    for (const v of ["yes", "opne", "true"]) {
      expect(() => loadConfig(["SEND_MODE"], { SEND_MODE: v })).toThrow(ConfigError);
    }
  });

  it("parses SEND_ALLOWED_RECIPIENTS as a list and treats OUTREACH_SIGNATURE as optional", () => {
    const c = loadConfig(["SEND_ALLOWED_RECIPIENTS", "OUTREACH_SIGNATURE"], { SEND_ALLOWED_RECIPIENTS: "a@b.test, c@d.test" });
    expect(c.SEND_ALLOWED_RECIPIENTS).toEqual(["a@b.test", "c@d.test"]);
    expect(c.OUTREACH_SIGNATURE).toBeUndefined();
    expect(() => loadConfig(["OUTREACH_SIGNATURE"], { OUTREACH_SIGNATURE: "x".repeat(201) })).toThrow(ConfigError);
  });

  it("rejects a signature with a code fence or a newline", () => {
    for (const v of ["a ``` b", "line one\nline two"]) {
      expect(() => loadConfig(["OUTREACH_SIGNATURE"], { OUTREACH_SIGNATURE: v })).toThrow(ConfigError);
    }
    expect(loadConfig(["OUTREACH_SIGNATURE"], { OUTREACH_SIGNATURE: "Fake Founder, Fake Co" }).OUTREACH_SIGNATURE).toBe("Fake Founder, Fake Co");
  });

  it("signatureFromEnv returns a single trimmed line or nothing", async () => {
    const { signatureFromEnv } = await import("../src/tools/deps.js");
    expect(signatureFromEnv({})).toBeUndefined();
    expect(signatureFromEnv({ OUTREACH_SIGNATURE: "   " })).toBeUndefined();
    expect(signatureFromEnv({ OUTREACH_SIGNATURE: "Fake Founder,  founder,  Fake Co" })).toBe("Fake Founder, founder, Fake Co");
  });
});

describe("send settings and token requirement", () => {
  it("validates REPLY_TO and defaults SCOUT_AUDIT_HEADER to true", () => {
    const ok = loadConfig(["REPLY_TO", "SCOUT_AUDIT_HEADER"], { REPLY_TO: "owner@example.test" });
    expect(ok).toEqual({ REPLY_TO: "owner@example.test", SCOUT_AUDIT_HEADER: "true" });
    expect(loadConfig(["SCOUT_AUDIT_HEADER"], { SCOUT_AUDIT_HEADER: " FALSE " }).SCOUT_AUDIT_HEADER).toBe("false");
    expect(() => loadConfig(["REPLY_TO"], { REPLY_TO: "not-an-email" })).toThrow(ConfigError);
    expect(() => loadConfig(["SCOUT_AUDIT_HEADER"], { SCOUT_AUDIT_HEADER: "no" })).toThrow(ConfigError);
  });

  it("requires GITHUB_TOKEN in every environment", () => {
    expect(() => requireGitHubToken({})).toThrow(/GITHUB_TOKEN/);
    expect(() => requireGitHubToken({ GITHUB_TOKEN: "   " })).toThrow(/GITHUB_TOKEN/);
    expect(() => requireGitHubToken({ GITHUB_TOKEN: "t" })).not.toThrow();
  });
});

describe("model", () => {
  it("pins the privacy and tool-call settings", () => {
    expect(modelSettings).toEqual({
      parallelToolCalls: false,
      provider: { data_collection: "deny" },
      reasoning: { effort: "low" },
    });
  });

  it("builds a model for the configured id without network", () => {
    const m = createModel({ OPENROUTER_API_KEY: "test-key", MODEL_ID: "anthropic/claude-sonnet-5.5" });
    expect(m.modelId).toBe("anthropic/claude-sonnet-5.5");
  });

  it("defaults the model id", () => {
    expect(createModel({ OPENROUTER_API_KEY: "test-key" }).modelId).toBe("deepseek/deepseek-v4.1-flash");
  });

  it("fails fast when the key is missing", () => {
    expect(() => createModel({})).toThrow(ConfigError);
  });
});
