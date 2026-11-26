import test from "node:test";
import assert from "node:assert/strict";
import { SESSION_ENDED_EVENT, keepsPageOnSessionEnd, loginPathFor, returnPathFromSearch, safeReturnPath } from "../src/utils/returnTo.js";

test("a stand-alone tool keeps its page when the session ends; every other page goes to the login", () => {
  assert.equal(keepsPageOnSessionEnd("/pdf"), true);
  assert.equal(keepsPageOnSessionEnd("/pdf/"), true);
  assert.equal(keepsPageOnSessionEnd("/pdf/anything"), true);
  assert.equal(keepsPageOnSessionEnd("/pdfx"), false);
  assert.equal(keepsPageOnSessionEnd("/home"), false);
  assert.equal(keepsPageOnSessionEnd("/login"), false);
  assert.equal(keepsPageOnSessionEnd(""), false);
  assert.equal(keepsPageOnSessionEnd(undefined), false);
  assert.equal(typeof SESSION_ENDED_EVENT, "string");
});

test("only the stand-alone tools are returnable", () => {
  assert.equal(safeReturnPath("/pdf"), "/pdf");
  assert.equal(safeReturnPath("/pdf/"), "/pdf/");
  assert.equal(safeReturnPath("/pdf?file=1#p2"), "/pdf?file=1#p2");
  assert.equal(safeReturnPath("/pdfx"), "");
  assert.equal(safeReturnPath("/home"), "");
  assert.equal(safeReturnPath(""), "");
  assert.equal(safeReturnPath(null), "");
});

test("absolute, protocol-relative and back-slash targets are rejected", () => {
  assert.equal(safeReturnPath("//evil.example/pdf"), "");
  assert.equal(safeReturnPath("https://evil.example/pdf"), "");
  assert.equal(safeReturnPath("/\\evil.example/pdf"), "");
  assert.equal(safeReturnPath("/pdf\\..\\x"), "");
  assert.equal(safeReturnPath("javascript:alert(1)"), "");
});

test("dot segments cannot leave the allow-list (the value is normalised before the check)", () => {
  assert.equal(safeReturnPath("/pdf/../settings/system"), "");
  assert.equal(safeReturnPath("/pdf/.."), "");
  assert.equal(safeReturnPath("/pdf/../../login"), "");
  assert.equal(safeReturnPath("/pdf/%2e%2e/settings/system"), "");
  assert.equal(safeReturnPath("/pdf/%2E%2e/%2e%2E/login"), "");
  assert.equal(safeReturnPath("/pdf/./../channel-management"), "");
  assert.equal(safeReturnPath("/home/../pdf"), "/pdf");
  assert.equal(safeReturnPath("/pdf/a/../b?x=1#y"), "/pdf/b?x=1#y");
  assert.equal(safeReturnPath("/pdf/./"), "/pdf/");
  assert.equal(returnPathFromSearch("?next=%2Fpdf%2F..%2Fchannel-management"), "");
  assert.equal(returnPathFromSearch("?next=%2Fpdf%2F%252e%252e%2Fsettings"), "");
  assert.equal(returnPathFromSearch("?next=%2Fpdf%2F%25252e%25252e%2Fsettings"), "/pdf/%252e%252e/settings");
  assert.equal(loginPathFor("/pdf/../reports"), "/login");
});

test("control characters, empty segments and non-string values are rejected", () => {
  assert.equal(safeReturnPath("/pdf/\t/x"), "");
  assert.equal(safeReturnPath("/pdf\n"), "");
  assert.equal(safeReturnPath("/\t/evil.example/pdf"), "");
  assert.equal(safeReturnPath("/pdf//evil.example"), "");
  assert.equal(safeReturnPath(" /pdf"), "");
  assert.equal(safeReturnPath("/PDF"), "");
  assert.equal(safeReturnPath(undefined), "");
  assert.equal(safeReturnPath({ toString: () => "/pdf/../x" }), "");
});

test("the login URL carries next only for returnable pages and round-trips through the query string", () => {
  assert.equal(loginPathFor("/pdf"), "/login?next=%2Fpdf");
  assert.equal(loginPathFor("/pdf", "?a=1", "#x"), "/login?next=%2Fpdf%3Fa%3D1%23x");
  assert.equal(loginPathFor("/reports"), "/login");
  assert.equal(returnPathFromSearch("?next=%2Fpdf"), "/pdf");
  assert.equal(returnPathFromSearch(new URL(`http://x${loginPathFor("/pdf", "?a=1", "#x")}`).search), "/pdf?a=1#x");
  assert.equal(returnPathFromSearch("?next=%2F%2Fevil.example"), "");
  assert.equal(returnPathFromSearch(""), "");
});
