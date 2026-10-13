/**
 * The media rules of CODING_STANDARDS.md, X-7 to X-11, as far as source and
 * headers can show them. What a browser then does is shown by the end-to-end
 * test, against a fake media host.
 */
import { globSync, readFileSync } from "node:fs";
import { isXOwnedHost } from "@x-bookmarks/core";
import { expect, test } from "vitest";
import {
  contentSecurityPolicy,
  X_MEDIA_HOSTS,
  xMediaUrl,
} from "./x-media-policy.ts";

const webRoot = new URL("../../", import.meta.url);
const sources = globSync("src/**/*.{ts,tsx,css}", { cwd: webRoot })
  .filter((file) => !/\.test\.tsx?$/.test(file))
  .map((file) => ({
    file,
    source: readFileSync(new URL(file, webRoot), "utf8"),
  }));
const filesWith = (pattern: RegExp) =>
  sources.filter(({ source }) => pattern.test(source)).map(({ file }) => file);

test("a stored address is offered to the browser only when it is HTTPS on the host for its kind", () => {
  expect(xMediaUrl("https://pbs.twimg.com/media/abc.jpg", "image")).toBe(
    "https://pbs.twimg.com/media/abc.jpg",
  );
  expect(xMediaUrl("https://video.twimg.com/vid/abc.mp4?tag=1", "video")).toBe(
    "https://video.twimg.com/vid/abc.mp4?tag=1",
  );
});

test.each([
  ["plain HTTP", "http://pbs.twimg.com/media/abc.jpg", "image"],
  ["X itself", "https://x.com/someone/status/1/photo/1", "image"],
  ["X's link shortener", "https://t.co/abc", "image"],
  ["another host of X's CDN", "https://abs.twimg.com/a.png", "image"],
  ["a look-alike host", "https://pbs.twimg.com.evil.example/a.jpg", "image"],
  ["a host that ends the same", "https://notpbs.twimg.com/a.jpg", "image"],
  [
    "a name hidden before an @",
    "https://pbs.twimg.com@evil.example/a",
    "image",
  ],
  ["another port", "https://pbs.twimg.com:8443/a.jpg", "image"],
  ["another site", "https://example.com/a.jpg", "image"],
  [
    "an image address offered as a video",
    "https://pbs.twimg.com/a.mp4",
    "video",
  ],
  [
    "a video address offered as an image",
    "https://video.twimg.com/a.jpg",
    "image",
  ],
  ["a script", "javascript:alert(1)", "image"],
  ["an inline image", "data:image/png;base64,AAAA", "image"],
  ["something that is not an address", "pbs.twimg.com/media/abc.jpg", "image"],
  ["nothing", null, "image"],
] as const)("%s is never offered", (_, stored, kind) => {
  expect(xMediaUrl(stored, kind)).toBeNull();
});

test("the page's policy lets the browser load pictures and video from this app and X's two media hosts, and nothing else", () => {
  const directives = new Map(
    contentSecurityPolicy()
      .split("; ")
      .map((directive) => {
        const [name = "", ...values] = directive.split(" ");
        return [name, values] as const;
      }),
  );

  expect(directives.get("img-src")).toEqual([
    "'self'",
    "data:",
    "blob:",
    `https://${X_MEDIA_HOSTS.image}`,
  ]);
  expect(directives.get("media-src")).toEqual([
    "'self'",
    `https://${X_MEDIA_HOSTS.video}`,
  ]);
  // Script on the page can reach this app and nowhere else.
  expect(directives.get("connect-src")).toEqual(["'self'"]);
  expect(directives.get("frame-src")).toEqual(["'none'"]);
  expect(directives.get("object-src")).toEqual(["'none'"]);

  const hosts = [...directives.values()]
    .flat()
    .filter((value) => value.includes("."))
    .map((value) => new URL(value).hostname);
  expect(hosts.sort()).toEqual(Object.values(X_MEDIA_HOSTS).sort());
  expect(contentSecurityPolicy()).not.toContain("*");
  expect(hosts.every(isXOwnedHost)).toBe(true);
});

test("every page is served with that policy, no referrer and no DNS look-ahead", () => {
  const config = readFileSync(new URL("next.config.ts", webRoot), "utf8");

  expect(config).toContain(
    '{ key: "Content-Security-Policy", value: contentSecurityPolicy() }',
  );
  expect(config).toContain('{ key: "Referrer-Policy", value: "no-referrer" }');
  expect(config).toContain('{ key: "X-DNS-Prefetch-Control", value: "off" }');
  // Next's image optimiser would have the server request the picture.
  expect(config).not.toMatch(/\bimages\s*:/);
});

test("media elements are written in one file, and rendered by one other", () => {
  const ELEMENT = /<(img|video|audio|source|picture|iframe|embed|object)\b/;

  expect(filesWith(ELEMENT)).toEqual([
    "src/components/library/x-media-element.tsx",
  ]);
  expect(filesWith(/x-media-element/)).toEqual([
    "src/components/library/media.tsx",
  ]);
  expect(filesWith(/next\/image|next\/legacy\/image/)).toEqual([]);
});

test("a media element asks plainly: no credentials, no referrer, and no hint to load early", () => {
  const element = readFileSync(
    new URL("src/components/library/x-media-element.tsx", webRoot),
    "utf8",
  );
  const tags = element.match(/<(img|video)\b[\s\S]*?\/>/g) ?? [];

  expect(tags).toHaveLength(2);
  for (const tag of tags) {
    expect(tag).toContain('crossOrigin="anonymous"');
    expect(tag).not.toMatch(/\b(loading|srcSet|poster|preload|fetchPriority)=/);
  }
  expect(tags[0]).toContain('referrerPolicy="no-referrer"');
});

test("the video element has none of the browser's controls, and one file drives it without naming an address", () => {
  const element = readFileSync(
    new URL("src/components/library/x-media-element.tsx", webRoot),
    "utf8",
  );
  const [tag = ""] = element.match(/<(video)\b[\s\S]*?\/>/) ?? [];
  expect(tag).not.toMatch(/\bcontrols\b/);
  expect(tag).toContain("autoPlay");

  // Telling the element to play or to load is what has it ask for its file.
  expect(filesWith(/\.(?:play|load)\(\)/)).toEqual([
    "src/components/library/video-player.tsx",
  ]);
  const player = sources.find(({ file }) => file.endsWith("video-player.tsx"));
  // It is handed the element, already given its one address, and changes
  // nothing about what is asked for or when: no address, no source of its
  // own, no hint to load, no second version of the video.
  expect(player?.source).not.toMatch(
    /https?:|\.src\b|srcObject|currentSrc|preload|MediaSource|canPlayType/,
  );
});

test("media appears only once its scope is revealed, and a scope is revealed by a press or by the on-screen setting", () => {
  const media = readFileSync(
    new URL("src/components/library/media.tsx", webRoot),
    "utf8",
  );

  // One place reveals a scope, and the observer that may call it looks at
  // the screen itself, with no margin around it.
  expect(media.match(/setRevealed\(true\)/g)).toHaveLength(1);
  expect(media).toContain('rootMargin: "0px"');
  // The automatic setting is read from the browser, and is off on the server.
  const setting = readFileSync(
    new URL("src/components/library/auto-media.ts", webRoot),
    "utf8",
  );
  expect(setting).toContain("() => false");
  expect(setting).toContain('=== "on"');
});

test("no part of the app touches an avatar's address", () => {
  expect(filesWith(/avatarUrl|profile_images/i)).toEqual([]);
});

test("the browser asks this app for data in one place and sends it a change in one other, each by a relative address", () => {
  const ASKS =
    /\bfetc[h]\(|XMLHttpReques[t]|WebSocke[t]|EventSourc[e]|sendBeaco[n]/;

  expect(filesWith(ASKS).toSorted()).toEqual([
    "src/components/library/load-more.ts",
    "src/lib/owner-write.ts",
  ]);
  const loadMore = sources.find(({ file }) => file.endsWith("load-more.ts"));
  expect(loadMore?.source).toMatch(/fetc[h]\(`\/api\/library\?/);
  const ownerWrite = sources.find(({ file }) =>
    file.endsWith("lib/owner-write.ts"),
  );
  expect(ownerWrite?.source).toMatch(/fetc[h]\(`\/api\/owner\/\$\{action\}`/);
  // Neither names a host: a relative address can only lead to this app.
  for (const source of [loadMore?.source, ownerWrite?.source]) {
    expect(source).not.toMatch(/https?:\/\//);
  }
});

test("the server reads media addresses and never requests one", () => {
  const server = sources.filter(
    ({ file }) => file.startsWith("src/server/") || file.startsWith("src/app/"),
  );

  for (const { file, source } of server) {
    expect(source, file).not.toMatch(
      /from "node:(https?|http2|net|tls|dns|child_process)"/,
    );
  }
});
