/** #714 gap 13 — a page opts into dark only by saying so. */
import { describe, it, expect } from "vitest";
import { pageOptsIntoDark } from "../pageTheme";

describe("pageOptsIntoDark", () => {
  it.each([
    '<meta name="color-scheme" content="light dark"><p>x</p>',
    "<meta content='dark' name='color-scheme'>",
    "<style>:root { color-scheme: light dark; }</style>",
    "<style>@media (prefers-color-scheme: dark) { body { background: #000 } }</style>",
    "<style>body { color: light-dark(#111, #eee) }</style>",
    '<html style="color-scheme: dark">',
  ])("opts in: %s", (html) => expect(pageOptsIntoDark(html)).toBe(true));

  it.each([
    "",
    "<p>A page about dark mode and color schemes.</p>",
    '<meta name="color-scheme" content="light">',
    '<meta name="color-scheme" content="only light">',
    '<meta name="theme-color" content="dark">',
    "<style>:root { color-scheme: light; }</style>",
  ])("stays as authored: %s", (html) => expect(pageOptsIntoDark(html)).toBe(false));
});

describe("pageOptsIntoDark — only styles count (#725 review)", () => {
  it.each([
    "<pre>@media (prefers-color-scheme: dark) { body { background: #000 } }</pre>",
    "<p>Use light-dark(#111, #eee) for colours.</p>",
    "<code>color-scheme: dark</code>",
    "<style>/* nothing */</style><pre><style>:root{color-scheme:dark}</style></pre>",
    "<script>const css = 'prefers-color-scheme: dark';</script>",
  ])("prose and samples don't opt in: %s", (html) => expect(pageOptsIntoDark(html)).toBe(false));
});
