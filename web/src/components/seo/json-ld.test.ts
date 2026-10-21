import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JsonLd } from "./json-ld";

test("JSON-LD keeps a script-closing sequence inside its serialized data", () => {
  const value = '</script><script>alert("example")</script>';
  const html = renderToStaticMarkup(
    createElement(JsonLd, { schema: { name: value } }),
  );
  expect(html.match(/<script/g)).toHaveLength(1);
  expect(html.match(/<\/script>/g)).toHaveLength(1);
  const payload = html.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
  expect(payload).not.toContain("<");
  expect(JSON.parse(payload)).toEqual({ name: value });
});
