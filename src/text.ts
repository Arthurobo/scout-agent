const DASH = "[\\u2013\\u2014]";

const ANY_DASH = new RegExp(DASH);
const DIGIT_DASH = new RegExp(`(?<=\\d)${DASH}(?=\\d)`, "g");
const WORD_EN_DASH = new RegExp("(?<=[A-Za-z0-9])\\u2013(?=[A-Za-z0-9])", "g");
const AFTER_PUNCT = new RegExp(`([.,;:!?])[ \\t]*${DASH}[ \\t]*`, "g");
const LINE_START = new RegExp(`^[ \\t]*${DASH}[ \\t]*`, "gm");
const LINE_END = new RegExp(`[ \\t]*${DASH}[ \\t]*$`, "gm");
const ANYWHERE = new RegExp(`[ \\t]*${DASH}[ \\t]*`, "g");

export function stripDashes(text: string): string {
  if (!ANY_DASH.test(text)) return text;
  return text
    .replace(DIGIT_DASH, "-")
    .replace(WORD_EN_DASH, "-")
    .replace(AFTER_PUNCT, "$1 ")
    .replace(LINE_START, "")
    .replace(LINE_END, "")
    .replace(ANYWHERE, ", ")
    .replace(/,[ \t]*,/g, ",");
}

const MAILTO = /mailto:/gi;
const EMAIL = /[^\s@<>`]+@[^\s@<>`]+\.[A-Za-z]{2,}/g;
const URL_TOKEN = /(?<![`\w])(https?:\/\/[^\s`]+|www\.[^\s`]+)/gi;
const DOMAIN = /(?<![`\w@./])([a-z0-9-]+\.)+(com|dev|io|org|net|ai|co|me)(\/[^\s`]*)?/gi;
const TRAILING = /[.,;:!?)\]]+$/;

export const ADDRESS_PLACEHOLDER = "the address on the approval card";

export function sanitizeReply(text: string): string {
  return stripDashes(text)
    .replace(MAILTO, "")
    .replace(EMAIL, ADDRESS_PLACEHOLDER)
    .replace(URL_TOKEN, (match: string) => {
      const trailing = TRAILING.exec(match)?.[0] ?? "";
      const core = trailing ? match.slice(0, -trailing.length) : match;
      return `\`${core}\`${trailing}`;
    })
    .replace(DOMAIN, (match: string) => {
      const trailing = TRAILING.exec(match)?.[0] ?? "";
      const core = trailing ? match.slice(0, -trailing.length) : match;
      return `\`${core}\`${trailing}`;
    });
}
