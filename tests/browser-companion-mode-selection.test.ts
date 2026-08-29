import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import {
  detectModesFromMenuEntries,
  menuEntryMatchesMode,
  WcoWindowsChatGptBrowserTransport,
} from "../src/browser-companion/browser-transport.js";

test("Extra High does not make High appear available", () => {
  assert.equal(menuEntryMatchesMode("Extra High", "high"), false);
  assert.equal(menuEntryMatchesMode("Extra High", "extra-high"), true);
  assert.deepEqual(detectModesFromMenuEntries(["Extra High"]), ["extra-high"]);
});

test("High selection does not click Extra High when Extra High appears first", async () => {
  let clicked = "";
  const candidates = ["Extra High", "High"].map((textContent) => ({
    textContent,
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
    click: () => {
      clicked = textContent;
    },
  }));

  const transport = Object.create(WcoWindowsChatGptBrowserTransport.prototype) as WcoWindowsChatGptBrowserTransport;
  const harness = transport as unknown as {
    openModelMenu: () => Promise<string[]>;
    evaluate: (_session: unknown, expression: string) => Promise<unknown>;
    selectMode: (session: unknown, mode: "high") => Promise<void>;
  };

  harness.openModelMenu = async () => ["Extra High", "High"];
  harness.evaluate = async (_session, expression) => runInNewContext(expression, {
    document: {
      querySelectorAll: () => candidates,
    },
  }) as unknown;

  await harness.selectMode({ targetId: "target", sessionId: "session" }, "high");
  assert.equal(clicked, "High");
});
