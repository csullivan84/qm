import assert from "node:assert/strict";
import test from "node:test";
import { matrixFormattedBody } from "../src/matrix/format.ts";

test("Matrix formatted bodies render useful Markdown while escaping untrusted HTML", () => {
  const rendered = matrixFormattedBody(
    "# Result\n\n- **passed**\n- [report](https://example.com/a?b=1&c=2)\n\n<script>alert(1)</script> `code`",
  );

  assert.match(rendered, /<h1>Result<\/h1>/);
  assert.match(rendered, /<ul><li><strong>passed<\/strong><\/li>/);
  assert.match(rendered, /href="https:\/\/example\.com\/a\?b=1&amp;c=2"/);
  assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(rendered, /<script>/);
  assert.match(rendered, /<code>code<\/code>/);
});

test("Matrix formatted bodies reject unsafe link schemes without dropping their label", () => {
  const rendered = matrixFormattedBody("[open](javascript:alert(1)) and [mail](mailto:a@example.com)");
  assert.doesNotMatch(rendered, /javascript:/);
  assert.doesNotMatch(rendered, /mailto:/);
  assert.match(rendered, /open/);
  assert.match(rendered, /mail/);
});
