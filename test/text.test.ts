import { describe, expect, it } from "vitest";
import { sanitizeReply } from "../src/text.js";

describe("sanitizeReply", () => {
  it("turns the live sentence with a mailto address into the placeholder", () => {
    expect(sanitizeReply("Approved and sent to Arthurobo at mailto:john.doe@example.com")).toBe(
      "Approved and sent to Arthurobo at the address on the approval card",
    );
  });

  it("replaces bare and bracketed addresses", () => {
    expect(sanitizeReply("Sent to fake.dev+tag@example.test, thanks")).toBe("Sent to the address on the approval card, thanks");
    expect(sanitizeReply("Sent to <fake@example.test>")).toBe("Sent to <the address on the approval card>");
    expect(sanitizeReply("a@b.test and c@d.test")).toBe("the address on the approval card and the address on the approval card");
  });

  it("wraps URLs in backticks so Slack neither links nor unfurls them, keeping trailing punctuation outside", () => {
    expect(sanitizeReply("See https://github.com/fake/repo for details")).toBe("See `https://github.com/fake/repo` for details");
    expect(sanitizeReply("Docs at www.example.test/x.")).toBe("Docs at `www.example.test/x`.");
    expect(sanitizeReply("Two: http://a.test/1, https://b.test/2!")).toBe("Two: `http://a.test/1`, `https://b.test/2`!");
  });

  it("does not double-wrap a URL that is already in backticks", () => {
    expect(sanitizeReply("See `https://github.com/fake/repo` here")).toBe("See `https://github.com/fake/repo` here");
  });

  it("still strips dashes", () => {
    expect(sanitizeReply(`Scout ${String.fromCharCode(0x2014)} I help`)).toBe("Scout, I help");
  });

  it("leaves plain text byte for byte unchanged", () => {
    const text = "Found 3 candidates.\n\n  - one\n  - two  \n*bold* and `code`";
    expect(sanitizeReply(text)).toBe(text);
  });

  it("backticks scheme-less domains with a path or a common TLD, trailing full stop outside", () => {
    expect(sanitizeReply("see github.com/foo/bar.")).toBe("see `github.com/foo/bar`.");
    expect(sanitizeReply("try example.dev now")).toBe("try `example.dev` now");
  });

  it("leaves abbreviations and versions alone and does not touch backticked domains", () => {
    expect(sanitizeReply("e.g. this works, v1.2.3 too, i.e. fine")).toBe("e.g. this works, v1.2.3 too, i.e. fine");
    expect(sanitizeReply("see `github.com/foo` ok")).toBe("see `github.com/foo` ok");
  });
});
