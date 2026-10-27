import { z } from "zod";

export const userSchema = z.object({
  id: z.number(),
  login: z.string(),
  type: z.string(),
  html_url: z.string().optional(),
  name: z.string().nullish(),
  email: z.string().nullish(),
  twitter_username: z.string().nullish(),
  blog: z.string().nullish(),
  bio: z.string().nullish(),
  company: z.string().nullish(),
  location: z.string().nullish(),
});
export type GitHubUser = z.infer<typeof userSchema>;

export const contributorsSchema = z.array(
  z.object({
    id: z.number(),
    login: z.string(),
    type: z.string(),
    contributions: z.number(),
  }),
);
export type Contributor = z.infer<typeof contributorsSchema>[number];

export const membersSchema = z.array(z.object({ id: z.number(), login: z.string() }));

export const repoSchema = z.object({
  full_name: z.string(),
  html_url: z.string().optional(),
  language: z.string().nullish(),
  fork: z.boolean().optional(),
  archived: z.boolean().optional(),
  private: z.boolean().optional(),
  stargazers_count: z.number().optional(),
  pushed_at: z.string().optional(),
});

export const repoSearchSchema = z.object({ items: z.array(repoSchema) });
export const repoListSchema = z.array(repoSchema);

export const issueSearchSchema = z.object({
  items: z.array(
    z.object({
      number: z.number(),
      title: z.string(),
      html_url: z.string(),
      repository_url: z.string(),
      updated_at: z.string().optional(),
      repository: z.object({ private: z.boolean().optional() }).optional(),
      pull_request: z.object({ merged_at: z.string().nullish() }).optional(),
    }),
  ),
});

export const commitsSchema = z.array(
  z.object({
    sha: z.string(),
    html_url: z.string(),
    commit: z.object({
      message: z.string(),
      author: z.object({ date: z.string().optional() }).nullish(),
    }),
    author: z.object({ login: z.string() }).nullish(),
  }),
);
