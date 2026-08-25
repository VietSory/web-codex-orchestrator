import assert from "node:assert/strict";
import test from "node:test";
import { isExactChatGptSessionUrl } from "../src/agent/wco-browser-companion-client.js";

test("first-party companion accepts only the exact HTTPS chatgpt.com session origin", () => {
  assert.equal(isExactChatGptSessionUrl("https://chatgpt.com/?temporary-chat=true"), true);
  assert.equal(isExactChatGptSessionUrl("https://chatgpt.com/c/example"), true);
  assert.equal(isExactChatGptSessionUrl("https://chatgpt.com.evil.example/?temporary-chat=true"), false);
  assert.equal(isExactChatGptSessionUrl("https://evil.example/?next=https://chatgpt.com"), false);
  assert.equal(isExactChatGptSessionUrl("http://chatgpt.com/?temporary-chat=true"), false);
  assert.equal(isExactChatGptSessionUrl("https://user:pass@chatgpt.com/"), false);
  assert.equal(isExactChatGptSessionUrl("not-a-url"), false);
});
