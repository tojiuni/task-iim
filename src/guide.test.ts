import { test } from "node:test";
import assert from "node:assert/strict";
import { GUIDE_TEXT, guideTools } from "./guide.ts";

test("GUIDE_TEXT includes the title_name regex and state machine", () => {
  assert.match(GUIDE_TEXT, /\^\[a-z\]\[a-z0-9\]\*\(-\[a-z0-9\]\+\)\+\$/);
  assert.match(GUIDE_TEXT, /assigned/);
});

test("ticket_guide tool returns the guide text", async () => {
  const t = guideTools.find((x) => x.name === "ticket_guide")!;
  const r = await t.handler({}, { async request() { return { ok: true, status: 200 }; } });
  assert.match(r.content[0].text, /title_name/);
});
