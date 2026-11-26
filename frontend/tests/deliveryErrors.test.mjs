import test from "node:test";
import assert from "node:assert/strict";
import { getErrorMessage } from "../src/pages/assetDelivery/utils.js";
import { translateMessage } from "../src/i18n/index.js";

const nginx413 = "<html><head><title>413 Request Entity Too Large</title></head><body><h1>413 Request Entity Too Large</h1><hr><center>nginx/1.18.0 (Ubuntu)</center></body></html><!-- a padding to disable MSIE and Chrome friendly error page -->";

test("proxy 413 responses show a translated, actionable size-limit message instead of HTML", () => {
  for (const data of [nginx413, "Request Entity Too Large", "", undefined, new Blob([nginx413], { type: "text/html" })]) {
    const message = getErrorMessage({ response: { status: 413, data }, message: "Request failed with status code 413" });
    assert.match(message, /upload size limit.*HTTP 413/);
    assert.match(message, /administrator.*retry/);
    assert.doesNotMatch(message, /<html>|nginx\/|padding/);
    assert.match(translateMessage(message, "vi"), /giới hạn dung lượng tải lên.*HTTP 413/);
  }
});

test("backend size-limit and video validation details survive error formatting", () => {
  const message = "File is larger than the allowed 16384 MB";
  assert.equal(getErrorMessage({ response: { status: 413, data: { success: false, message } } }), message);
  assert.equal(getErrorMessage({ response: { status: 413, data: { error: message } } }), message);
  assert.equal(getErrorMessage({ response: { status: 413, data: { errors: [{ message }] } } }), message);
  assert.equal(getErrorMessage({ response: { status: 422, data: { code: "VIDEO_TOO_SHORT", message: "Video is too short" } } }), "Video is too short");
});

test("other proxy HTML pages are hidden while plain text and transport errors remain useful", () => {
  const message = getErrorMessage({ response: { status: 502, data: "<!DOCTYPE html><html><body>502 Bad Gateway</body></html>" } });
  assert.match(message, /server returned an error page/);
  assert.match(translateMessage(message, "vi"), /Máy chủ trả về trang báo lỗi/);
  assert.equal(getErrorMessage({ response: { status: 400, data: "Invalid file" } }), "Invalid file");
  assert.equal(getErrorMessage({ code: "ECONNABORTED" }), "Request timed out");
  assert.equal(getErrorMessage({ code: "ERR_CANCELED" }), "Cancelled");
  assert.equal(getErrorMessage(new Error("Network Error")), "Network Error");
});
