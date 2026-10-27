import type { Candidate } from "../github/sourcing.js";

export type ThreadInfo = { channel: string; threadTs: string; userId?: string };

export type TurnState = {
  thread?: ThreadInfo;
  runId?: string;
  searchId?: number;
  lastQuery?: string;
  withheld: number;
  candidates: Map<string, Candidate>;
  posted: Set<string>;
};

export type TurnStore = {
  setThread(info: ThreadInfo): void;
  setRunId(runId: string): void;
  setSearch(searchId: number, query: string, candidates: Candidate[], withheld?: number): void;
  get(): Readonly<TurnState>;
  candidate(login: string): Candidate | undefined;
  markPosted(login: string): boolean;
  unmarkPosted(login: string): void;
};

export function createTurnStore(): TurnStore {
  const state: TurnState = { candidates: new Map(), posted: new Set(), withheld: 0 };
  return {
    setThread(info) {
      if (state.thread && state.thread.channel === info.channel && state.thread.threadTs === info.threadTs) {
        state.thread = info;
        return;
      }
      state.thread = info;
      state.searchId = undefined;
      state.lastQuery = undefined;
      state.withheld = 0;
      state.candidates = new Map();
      state.posted = new Set();
    },
    setRunId(runId) {
      state.runId = runId;
    },
    setSearch(searchId, query, candidates, withheld = 0) {
      state.withheld = withheld;
      state.searchId = searchId;
      state.lastQuery = query;
      state.candidates = new Map(candidates.map((c) => [c.login.toLowerCase(), c]));
      state.posted = new Set();
    },
    get: () => state,
    candidate: (login) => state.candidates.get(login.toLowerCase()),
    unmarkPosted(login) {
      state.posted.delete(login.toLowerCase());
    },
    markPosted(login) {
      const key = login.toLowerCase();
      if (state.posted.has(key)) return false;
      state.posted.add(key);
      return true;
    },
  };
}

export const turnStore = createTurnStore();
