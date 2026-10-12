import type { Migration } from "../migrate.ts";

export const migration: Migration = {
  version: 2,
  name: "capture-key-and-request-body",
  sql: `
-- The body of the request that produced the response, kept verbatim. A
-- mutation such as CreateBookmark names its post only there: the response
-- says no more than "Done".
ALTER TABLE raw_captures ADD COLUMN request_body TEXT;

-- An id the capturer gave the capture before sending it. A capturer that
-- queues and retries may deliver the same capture twice; the unique index
-- makes the second delivery a no-op.
ALTER TABLE raw_captures ADD COLUMN capture_key TEXT CHECK (length(capture_key) > 0);

CREATE UNIQUE INDEX raw_captures_capture_key
  ON raw_captures (source, capture_key)
  WHERE capture_key IS NOT NULL;
`,
};
