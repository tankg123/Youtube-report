import { useEffect } from "react";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../context/I18nContext";
import { t } from "../i18n/index.js";

// Matched as lowercase substrings of a control's text + aria-label + title + value (see isActionControl):
// English verbs first, then the Vietnamese verbs the bilingual dictionaries render on the same buttons.
const ACTION_WORDS = [
  "add",
  "create",
  "edit",
  "delete",
  "remove",
  "save",
  "update",
  "sync",
  "import",
  "export",
  "upload",
  "download",
  "pdf",
  "excel",
  "csv",
  "clear",
  "generate",
  "enable",
  "disable",
  "change password",
  "profile settings",
  "two-factor",
  "2fa",
  "setup",
  "resend",
  "send code",
  "submit",
  "confirm",
  "thêm",
  "tạo",
  "sửa",
  "xóa",
  "xoá",
  "lưu",
  "cập nhật",
  "đồng bộ",
  "nhập",
  "xuất",
  "tải",
  "xóa bảng",
  "xoá bảng"
];

// Verbs matched only at the START of a control's text (after an optional icon / count), in both languages:
// a substring match would also lock status chips and filters that merely contain the word ("Đã gỡ",
// "Đang chạy", "Released", "Running"). Imperative buttons begin with their verb.
const ACTION_PREFIXES = [
  "release",
  "reinstate",
  "activate",
  "re-check",
  "recheck",
  "retry",
  "deliver",
  "run",
  "start",
  "stop",
  "send",
  "gỡ",
  "khôi phục",
  "xác nhận",
  "kích hoạt",
  "kiểm tra lại",
  "thử lại",
  "phân phối",
  "tải lên",
  "tải xuống",
  "gửi",
  "chạy",
  "bắt đầu",
  "dừng",
  "bật",
  "tắt",
  "thiết lập",
  "bỏ chọn"
];

const ALLOW_EXACT = new Set([
  "close",
  "cancel",
  "back",
  "previous",
  "next",
  "view",
  "refresh",
  "reset",
  "filter",
  "filters",
  "sort",
  "copy",
  "copy channel id",
  "open channel in new tab",
  "profile settings",
  "change password",
  "two-factor authentication",
  "generate qr code",
  "enable 2fa",
  "disable 2fa",
  "en",
  "vi",
  "light",
  "dark",
  "logout",
  "sign out",
  "đóng",
  "hủy",
  "huỷ",
  "quay lại",
  "trước",
  "sau",
  "xem",
  "làm mới",
  "lọc",
  "đăng xuất",
  "đặt lại",
  "bộ lọc",
  "sắp xếp",
  "sao chép",
  "cài đặt hồ sơ",
  "đổi mật khẩu",
  "xác thực hai lớp",
  "tạo mã qr",
  "bật 2fa",
  "tắt 2fa",
  "sáng",
  "tối",
  "phân phối lên cms",
  "phân phối video"
]);

const ACTION_ICON_HINTS = [
  "lucide-plus",
  "lucide-trash",
  "lucide-trash-2",
  "lucide-pencil",
  "lucide-pen",
  "lucide-square-pen",
  "lucide-save",
  "lucide-upload",
  "lucide-download",
  "lucide-file-down",
  "lucide-file-up",
  "lucide-refresh-cw",
  "lucide-refresh-ccw",
  "lucide-lock-keyhole",
  "lucide-shield-check"
];

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

// "gỡ claim đã chọn" and "+ release 3 claims" start with a verb; "đã gỡ" or "released" do not. A verb must be
// followed by the end of the text or a non-letter so "run" does not match "running" and "gỡ" not "gỡi".
function startsWithActionVerb(label) {
  const text = label.replace(/^[^\p{L}\p{N}]+/u, "").replace(/^\d+\s*/, "");
  return ACTION_PREFIXES.some((verb) => text === verb || (text.startsWith(verb) && !/\p{L}/u.test(text.charAt(verb.length))));
}

function labelFor(element) {
  return normalize([
    element.innerText,
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.getAttribute("value")
  ].filter(Boolean).join(" "));
}

function isActionControl(element) {
  if (element.closest("[data-readonly-allow='true']")) return false;

  const label = labelFor(element);
  if (ALLOW_EXACT.has(label)) return false;

  if (element.tagName === "BUTTON" && normalize(element.getAttribute("type")) === "submit") {
    return true;
  }

  if (ACTION_WORDS.some((word) => label.includes(word))) return true;
  if (startsWithActionVerb(label)) return true;

  const html = normalize(element.innerHTML);
  if (!label && ACTION_ICON_HINTS.some((hint) => html.includes(hint))) return true;
  if (label && ACTION_ICON_HINTS.some((hint) => html.includes(hint)) && !ALLOW_EXACT.has(label)) {
    return ACTION_WORDS.some((word) => label.includes(word)) || startsWithActionVerb(label);
  }

  if (element.tagName === "A" && element.hasAttribute("download")) return true;
  if (element.tagName === "LABEL" && element.querySelector("input[type='file']")) return true;

  return false;
}

function lockElement(element) {
  if (element.dataset.readonlyLocked === "true") return;
  element.dataset.readonlyLocked = "true";
  element.dataset.readonlyTitle = element.getAttribute("title") || "";

  if ("disabled" in element) {
    element.dataset.readonlyDisabled = element.disabled ? "true" : "false";
    element.disabled = true;
  }

  if (element.tagName === "A" || element.tagName === "LABEL") {
    element.dataset.readonlyTabIndex = element.getAttribute("tabindex") || "";
    element.setAttribute("tabindex", "-1");
    element.setAttribute("aria-disabled", "true");
  }

  element.setAttribute("title", t("Read only mode: this action is disabled"));
  element.classList.add("read-only-action-disabled");
}

function unlockElement(element) {
  if (element.dataset.readonlyLocked !== "true") return;

  if ("disabled" in element && element.dataset.readonlyDisabled === "false") {
    element.disabled = false;
  }

  if (element.tagName === "A" || element.tagName === "LABEL") {
    if (element.dataset.readonlyTabIndex) {
      element.setAttribute("tabindex", element.dataset.readonlyTabIndex);
    } else {
      element.removeAttribute("tabindex");
    }
    element.removeAttribute("aria-disabled");
  }

  if (element.dataset.readonlyTitle) {
    element.setAttribute("title", element.dataset.readonlyTitle);
  } else {
    element.removeAttribute("title");
  }

  element.classList.remove("read-only-action-disabled");
  delete element.dataset.readonlyLocked;
  delete element.dataset.readonlyDisabled;
  delete element.dataset.readonlyTabIndex;
  delete element.dataset.readonlyTitle;
}

function applyReadOnlyLock() {
  const controls = document.querySelectorAll("button, a, label");
  controls.forEach((element) => {
    if (isActionControl(element)) {
      lockElement(element);
    } else {
      unlockElement(element);
    }
  });
}

function clearReadOnlyLock() {
  document.querySelectorAll("[data-readonly-locked='true']").forEach(unlockElement);
}

export default function ReadOnlyRuntime() {
  const { isReadOnly } = useAuth();
  // language: a toggle unlocks and re-locks the controls so the injected title follows the UI language.
  const { language } = useI18n();

  useEffect(() => {
    if (!isReadOnly) {
      document.body.classList.remove("read-only-mode");
      clearReadOnlyLock();
      return undefined;
    }

    document.body.classList.add("read-only-mode");
    applyReadOnlyLock();

    const observer = new MutationObserver(() => {
      window.requestAnimationFrame(applyReadOnlyLock);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "disabled", "aria-label", "title"]
    });

    return () => {
      observer.disconnect();
      document.body.classList.remove("read-only-mode");
      clearReadOnlyLock();
    };
  }, [isReadOnly, language]);

  return null;
}
