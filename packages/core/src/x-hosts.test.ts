import { expect, test } from "vitest";
import {
  assertNotXOwnedUrl,
  isXOwnedHost,
  XOwnedHostError,
} from "./x-hosts.ts";

test.each([
  "x.com",
  "X.com",
  "api.x.com",
  "mobile.twitter.com",
  "publish.twitter.com",
  "syndication.twitter.com",
  "t.co",
  "pbs.twimg.com",
  "video.twimg.com",
  "cdn.syndication.twimg.com",
  "abs.twimg.com",
  "pic.x.com",
  "x.com.",
])("%s is one of X's hosts", (host) => {
  expect(isXOwnedHost(host)).toBe(true);
});

test.each([
  "example.com",
  "linux.com",
  "notx.com",
  "x.com.example.org",
  "internet.co",
  "t.com",
  "twimg.com.evil.example",
  "127.0.0.1",
  "",
])("%j is not", (host) => {
  expect(isXOwnedHost(host)).toBe(false);
});

test("a URL on another host passes the guard, parsed", () => {
  expect(assertNotXOwnedUrl("https://example.com/a?b=1").href).toBe(
    "https://example.com/a?b=1",
  );
  expect(assertNotXOwnedUrl(new URL("http://127.0.0.1:47130/")).port).toBe(
    "47130",
  );
});

test.each([
  ["a post", "https://x.com/someone/status/1975000000000000001"],
  ["a link redirect", "https://t.co/AbCdEf1234"],
  ["a photo", "https://pbs.twimg.com/media/abc.jpg?format=jpg&name=orig"],
  ["a video", "https://video.twimg.com/amplify_video/1/vid/a.mp4"],
  [
    "an embed",
    "https://publish.twitter.com/oembed?url=https%3A%2F%2Fexample.com",
  ],
  [
    "the syndication endpoint",
    "https://cdn.syndication.twimg.com/tweet-result?id=1",
  ],
  ["an article", "http://x.com/i/article/1975000000000000001"],
  ["a host in capitals with a port", "HTTPS://API.X.COM:443/2/tweets"],
  ["credentials in front of the host", "https://example.com@x.com/"],
  ["something that is not a URL", "x.com/someone"],
  ["nothing", ""],
])("requesting %s is refused", (_, url) => {
  expect(() => assertNotXOwnedUrl(url)).toThrow(XOwnedHostError);
});
