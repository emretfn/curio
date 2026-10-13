/**
 * The demo's sample digest: the written part of one week, by the keys of
 * the posts it points at. It was written by hand with the demo's posts and
 * says so in its first sentence; no run of `pnpm digest` made it, nothing
 * was sent anywhere, and it cost nothing.
 */

interface SampleDigest {
  overview: string;
  themes: { title: string; summary: string; posts: string[] }[];
  worthRevisiting: { post: string; why: string }[];
}

export const DIGEST: SampleDigest = {
  overview:
    "This is a sample summary, written for the demo library to show what a week's digest reads like. No model was called to write it.\n\nThirteen bookmarks this week, and three subjects account for eleven of them: SQLite doing the work of a database server, what makes a coding agent dependable, and motion in interfaces. The posts agree with each other more than they argue, and most of them are practical: nearly every one holds a rule you could apply the same day.",
  themes: [
    {
      title: "One SQLite file as the whole backend",
      summary:
        "Four posts make the same case from different sides: a single file in WAL mode carries far more than people expect, as long as there is one writer and its transactions are short. The parts to keep are the procedures. Back up through the backup API and open the copy before you trust it; freeze a migration once it has run anywhere; and let FTS5 do the searching in the same file as the data.",
      posts: ["one-file", "backup", "frozen-migrations", "fts5"],
    },
    {
      title: "Agents are made dependable by limits and cheap checks",
      summary:
        "None of these four is about prompting. One starts from the list of things a model may not do on its own, one from a test command fast enough that checking beats guessing, one explains why a skill costs a line of context until it is needed, and one hands a model a tool that can read and cannot write. Together they describe a harness, not a conversation.",
      posts: ["may-not", "nine-seconds", "skill-folder", "read-only-mcp"],
    },
    {
      title: "Motion that explains what happened",
      summary:
        "Three posts on interface animation, two of them rules of thumb and one a demonstration. The shared point is that movement is there to say where something went, that the curve matters more than the duration, and that a control pressed a hundred times a day should not animate at all.",
      posts: ["ease-out", "before-after", "egri"],
    },
  ],
  worthRevisiting: [
    {
      post: "backup",
      why: "It is a procedure with three steps, and it applies to any SQLite file you depend on, this library's included.",
    },
    {
      post: "nine-seconds",
      why: "The cheapest change of the week: it asks for a faster test command and nothing else.",
    },
    {
      post: "deep-sleep",
      why: "It fits none of the library's categories. If posts about hardware keep arriving, that is a category to add.",
    },
  ],
};
