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

test("guide explains requester, assignee and human delegation in 6–10 Korean lines", async () => {
  const section = GUIDE_TEXT.split("## 요청자·담당자·위임자\n")[1]?.split("\n## ")[0].trim();
  assert.ok(section);
  const lines = section.split("\n");
  assert.ok(lines.length >= 6 && lines.length <= 10);
  assert.match(section, /요청자\(requester\).*호출한 계정/);
  assert.match(section, /담당자\(assignee\).*역할 계정/);
  assert.match(section, /assignee_type=agent/);
  assert.match(section, /assignee_id=<actor id>/);
  assert.match(section, /첫 줄.*delegated_by: <name>/);
  const r = await guideTools[0].handler({}, { async request() { return { ok: true, status: 200 }; } });
  assert.equal(r.content[0].text, GUIDE_TEXT);
});
