import type { Migration } from "../migrate.ts";

export const migration: Migration = {
  version: 9,
  name: "tagging-run-accounts",
  sql: `
-- Two figures a tagging run knew while it ran and did not write down, so
-- that nothing reading its record afterwards could know them.
--
--   held_usd               what the run held against its spend cap for
--                          attempts that went out and brought no answer
--                          back: each at the most a request of that run
--                          could cost, because the API may have charged for
--                          it and no token count says. It is in cost_usd
--                          nowhere. The app's allowance for a day is taken
--                          over cost_usd and this together; without it,
--                          passes whose requests time out never use the
--                          allowance up.
--   filed_without_request  of the run's classified bookmarks, those that
--                          held nothing worth sending and were dealt with
--                          without a request. What a bookmark cost a run is
--                          its cost over the bookmarks it asked about, and
--                          these were not asked about.
ALTER TABLE tagging_runs
  ADD COLUMN held_usd REAL NOT NULL DEFAULT 0 CHECK (held_usd >= 0);
ALTER TABLE tagging_runs
  ADD COLUMN filed_without_request INTEGER NOT NULL DEFAULT 0
    CHECK (filed_without_request >= 0);

-- A run from before this migration: what it held is not known, and stays
-- zero. What it filed without a request can still be read off the library,
-- where such a classification names no model and falls inside the run's
-- time; one made again since by a model is no longer counted, which errs
-- towards a dearer rate and never a cheaper one.
UPDATE tagging_runs SET filed_without_request = min(classified, (
  SELECT count(*) FROM bookmark_classifications c
  WHERE c.model IS NULL
    AND c.classified_at >= tagging_runs.started_at
    AND c.classified_at <= coalesce(tagging_runs.finished_at, tagging_runs.heartbeat_at)))
WHERE mode <> 'new-tags';
`,
};
