/**
 * The newest of the demo's posts: those saved in the days since the last
 * whole week, which open the library screen, and those of that week, which
 * the demo's sample digest is about. Newest first within each.
 */
import { type PostSpec, photo, post, video } from "../post-spec.ts";

export const SINCE: PostSpec[] = [
  post(
    "issues",
    "Released: a small MCP server that exposes a SQLite database read-only. One tool lists the tables, one runs a SELECT with a row limit, and nothing writes. https://issues-welcome.example/sqlite-mcp",
    "ai-agents",
    "launch",
    ["mcp", "open-source", "sqlite"],
    {
      saved: "since",
      card: {
        title: "sqlite-mcp: a read-only window for a model",
        description:
          "Two tools, a row limit, and a database opened read-only so that nothing a model is told can change it.",
      },
    },
  ),
  post(
    "noor",
    "Finished the settings panel. Every row opens with the same spring, and nothing moves that you did not touch.",
    "design",
    "showcase",
    ["animation", "ui-components"],
    {
      saved: "since",
      media: [
        video(
          42,
          "A settings panel on a phone. Rows expand one at a time with a soft spring, and each toggle's thumb stretches slightly while it travels.",
        ),
      ],
      key: "settings-panel",
    },
  ),
  post(
    "ravi",
    "Before you hand an agent a database tool, open the database read-only. A model can be talked into things by the very rows it reads. A connection that cannot write is the one promise that holds whatever it is told.",
    "ai-agents",
    "tip",
    ["mcp", "security", "sqlite"],
    { saved: "since", key: "refiled" },
  ),
  post(
    "wal",
    "SQLite tip that saved me today: run `PRAGMA wal_checkpoint(TRUNCATE)` after a big import. Our WAL file had quietly grown to 4 GB because one long-lived reader never let a checkpoint finish. Close your readers.",
    "tools",
    "tip",
    ["sqlite"],
    { saved: "since", proposed: ["sqlite-wal"], key: "wal-checkpoint" },
  ),
  post(
    "hana",
    "Wrote up how we moved a dashboard to server components without a rewrite: one route at a time, data fetching first, client state last. https://renders-twice.example/incremental-rsc",
    "web-dev",
    "guide",
    ["react", "nextjs"],
    {
      saved: "since",
      proposed: ["react-server-components"],
      card: {
        title: "Server components, one route at a time",
        description:
          "A migration log: what moved first, what stayed on the client, and what we would not do again.",
      },
    },
  ),
  post(
    "loop",
    'The most useful line in my CLAUDE.md is still the boring one: "run the tests before you say you are done, and paste the output if they fail." Fewer confident summaries, more evidence.',
    "ai-agents",
    "tip",
    ["claude-code", "agent-rules"],
    { saved: "since" },
  ),
  post(
    "emir",
    "Postgres'te yavaş sorgu ararken ilk baktığım yer pg_stat_statements. Toplam süreye göre sıralayın, çağrı sayısına göre değil: en pahalı sorgu çoğu zaman en sık çalışan değil, en uzun süren oluyor.",
    "tools",
    "tip",
    ["postgres"],
    { saved: "since", lang: "tr" },
  ),
  post(
    "mrr",
    "This matches what I saw. The annual plan only started selling once it was the default choice and not the upsell.",
    "business",
    "discussion",
    ["paywall"],
    {
      saved: "since",
      quote: {
        by: "paywall",
        text: "Three paywall tests, one result: moving the trial toggle above the price lifted trial starts by 18%. Nobody reads below the button.",
      },
    },
  ),
  post(
    "yusuf",
    "Two screens, one code path: how I lay out SwiftUI navigation so iPad gets a sidebar and iPhone gets a stack, without an if-statement in every view.",
    "mobile-dev",
    "guide",
    ["swiftui"],
    {
      saved: "since",
      media: [
        photo(
          "An iPad showing a three-column layout: a sidebar of folders, a list of notes, and the open note.",
        ),
        photo(
          "The same app on an iPhone: the folders, the list and the note are three pushed screens.",
          1000,
          1600,
        ),
      ],
    },
  ),
  post(
    "tiny",
    "Five small self-hosted tools I kept after a year: a feed reader, a paste bin, a link saver, an uptime page and a photo backup. Each is one binary and one SQLite file. https://tinytools.example/keepers",
    "tools",
    "resource-list",
    ["open-source", "self-hosting"],
    {
      saved: "since",
      card: {
        title: "The keepers: five tools that survived a year",
        description:
          "What stayed on the server after twelve months, and what was uninstalled within a week.",
      },
    },
  ),
];

export const DIGEST_WEEK: PostSpec[] = [
  // SQLite as the whole backend.
  post(
    "wal",
    "People ask how far one SQLite file goes. Ours: 40 GB, 600 writes a second at peak, one writer process, WAL mode, `synchronous=NORMAL`, and a busy timeout so short transactions queue instead of failing. The limit we hit first was our own slow queries.",
    "tools",
    "discussion",
    ["sqlite"],
    { saved: "digest-week", key: "one-file" },
  ),
  post(
    "tiny",
    "Backing up SQLite while the app is running: do not copy the file. Use the backup API or `VACUUM INTO`, then open the copy and run `PRAGMA integrity_check` before you call it a backup. A backup you have not opened is a hope.",
    "tools",
    "guide",
    ["sqlite", "self-hosting"],
    { saved: "digest-week", key: "backup" },
  ),
  post(
    "migrations",
    "Migration rule that has not failed me yet: a migration that has run anywhere is frozen. Fix it with a new one. Store a checksum of each applied migration and refuse to start when the code disagrees with the database.",
    "tools",
    "tip",
    ["sqlite", "postgres"],
    { saved: "digest-week", key: "frozen-migrations" },
  ),
  post(
    "deniz",
    "FTS5 is the most underrated part of SQLite. Full-text search with ranking, prefix queries and your own tokenizer rules, in the same file as your data, kept in step by three triggers. I deleted a whole search service. https://night-debugging.example/fts5-notes",
    "tools",
    "guide",
    ["sqlite"],
    {
      saved: "digest-week",
      proposed: ["local-first"],
      card: {
        title: "FTS5 notes: search without a search service",
        description:
          "External-content tables, the three triggers, bm25 weights, and what the tokenizer does to accented letters.",
      },
      key: "fts5",
    },
  ),
  // Agents need rules.
  post(
    "tomas",
    "An agent harness is mostly a list of things the model may not do on its own: spend money, push, delete, send. Write the list first. The prompt comes after.",
    "ai-agents",
    "discussion",
    ["agent-rules"],
    { saved: "digest-week", key: "may-not" },
  ),
  post(
    "loop",
    "What changed my agent's output most was not a better prompt. It was a test command that takes nine seconds. If checking is cheap, it checks; if checking takes four minutes, it guesses and tells you it checked.",
    "ai-agents",
    "tip",
    ["claude-code", "testing"],
    { saved: "digest-week", key: "nine-seconds" },
  ),
  post(
    "drawer",
    "A skill is a folder: one page that says when to use it, and the scripts it needs beside that page. The page is read only when the task calls for it, so twenty skills cost you twenty one-line descriptions, not twenty pages of context.",
    "ai-agents",
    "guide",
    ["agent-skills", "claude-code"],
    { saved: "digest-week", key: "skill-folder" },
  ),
  post(
    "ada",
    'Gave the agent a read-only MCP server over our issue tracker and nothing that writes. It can now answer "has this been reported?" and cannot close anything by mistake. Read-only first is a good default for every tool you hand a model.',
    "ai-agents",
    "tip",
    ["mcp"],
    { saved: "digest-week", key: "read-only-mcp" },
  ),
  // Motion.
  post(
    "easing",
    "Rule of thumb for interface motion: things the user starts get 150 to 250 ms and ease-out. Things that happen on their own get less, or nothing. If you press a control a hundred times a day, it should not animate at all.",
    "design",
    "tip",
    ["animation"],
    { saved: "digest-week", key: "ease-out" },
  ),
  post(
    "noor",
    "Before and after: the same list, with and without layout animation when an item is removed. The second one tells you where the item went. That is the whole job of motion.",
    "design",
    "showcase",
    ["animation"],
    {
      saved: "digest-week",
      media: [
        video(
          18,
          "Two phone screens side by side. On the left a list item vanishes and the rows below jump up. On the right the rows slide up to close the gap.",
        ),
      ],
      key: "before-after",
    },
  ),
  post(
    "elif",
    "Animasyonda en sık yapılan hata süre değil, eğri. Doğrusal hareket mekanik durur. Kullanıcının başlattığı her harekette ease-out kullanın: hızlı başlasın, yavaşça otursun.",
    "design",
    "tip",
    ["animation"],
    { saved: "digest-week", lang: "tr", key: "egri" },
  ),
  // Beside the themes.
  post(
    "solder",
    "Finally measured it: the ESP32 on my desk draws 11 µA in deep sleep once you cut the power LED and stop feeding the USB bridge. Two AA cells, one reading every ten minutes, and the estimate is fourteen months.",
    "other",
    "showcase",
    [],
    {
      saved: "digest-week",
      proposed: ["esp32"],
      media: [
        photo(
          "A small development board on a breadboard, wired to a multimeter that reads 0.011 mA.",
        ),
      ],
      key: "deep-sleep",
    },
  ),
  post(
    "notebook",
    'Kept a "things I was wrong about" file for a year. Forty entries. The pattern: I am rarely wrong about the technology and often wrong about how long people take to change a habit.',
    "life",
    "discussion",
    ["career"],
    { saved: "digest-week" },
  ),
];
