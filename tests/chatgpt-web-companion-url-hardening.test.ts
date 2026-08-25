import assert from "node:assert/strict";
import test from "node:test";
import { isChatGptWebSessionUrl } from "../src/agent/chatgpt-web-companion-client.js";

test("companion accepts only the exact HTTPS chatgpt.com session origin", () => {
  assert.equal(isChatGptWebSessionUrl("https://chatgpt.com/?temporary-chat=true"), true);
  assert.equal(isChatGptWebSessionUrl("https://chatgpt.com/c/example"), true);
  assert.equal(isChatGptWebSessionUrl("https://chatgpt.com.evil.example/?temporary-chat=true"), false);
  assert.equal(isChatGptWebSessionUrl("https://evil.example/?next=https://chatgpt.com"), false);
  assert.equal(isChatGptWebSessionUrl("http://chatgpt.com/?temporary-chat=true"), false);
  assert.equal(isChatGptWebSessionUrl("https://user:pass@chatgpt.com/"), false);
  assert.equal(isChatGptWebSessionUrl("not-a-url"), false);
});
