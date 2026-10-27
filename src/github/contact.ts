export type ContactRoute = {
  channel: "email" | "twitter" | "web";
  value: string;
  provenance: string;
};

export type ContactSource = {
  email?: string | null;
  twitter_username?: string | null;
  blog?: string | null;
};

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const DOMAIN = /^[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(\/\S*)?$/;

export function contactRoutes(p: ContactSource): ContactRoute[] {
  const routes: ContactRoute[] = [];
  const email = p.email?.trim();
  if (email && EMAIL.test(email) && !/@users\.noreply\.github\.com$/i.test(email)) {
    routes.push({ channel: "email", value: email, provenance: "email published on GitHub profile" });
  }
  const handle = p.twitter_username?.trim();
  if (handle && HANDLE.test(handle)) {
    routes.push({
      channel: "twitter",
      value: `@${handle}`,
      provenance: "X/Twitter handle published on GitHub profile",
    });
  }
  const blog = p.blog?.trim();
  if (blog) {
    const url = /^https?:\/\//i.test(blog) ? blog : DOMAIN.test(blog) ? `https://${blog}` : null;
    if (url && /^https?:\/\/[^\s]+$/i.test(url)) {
      routes.push({ channel: "web", value: url, provenance: "website published on GitHub profile" });
    }
  }
  return routes;
}
