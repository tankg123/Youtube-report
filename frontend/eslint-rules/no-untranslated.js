// Local ESLint rule for the bilingual pages (see ../i18n.files.mjs): every user-visible literal must go
// through the i18n layer so the Vietnamese UI has no English leftovers (and the English UI no Vietnamese).
//
//   <p>Save</p>                        → <p>{t("Save")}</p>
//   placeholder="Search claims"        → placeholder={t("Search claims")}
//   {`${count} claims`}                → {t("{count} claims", { count })}
//   label: "Released"                  → label: tk("Released")          (rendered later with t(meta.label))
//   setError("Could not load claims")  → setError(tk("Could not load claims")) and {tm(error)} where shown
//
// The rule looks at display positions only: JSX text, JSX children expressions, text-like attributes and
// object properties (label, title, description, placeholder, …) and the arguments of toast / error setters.
// Strings inside t() / tk() / tm() calls are fine. For a true false positive use
//   // eslint-disable-next-line i18n/no-untranslated -- <why this text is not user copy>

const TRANSLATE_CALLS = new Set(["t", "tk", "tm", "translate", "translateMessage"]);

const TEXT_NAMES = [
  "placeholder", "title", "alt", "label", "shortLabel", "description", "hint", "help", "helpText", "tooltip",
  "subtitle", "heading", "subheading", "caption", "eyebrow", "summary", "message", "text", "badge", "prefix",
  "suffix", "unit", "detail", "note", "warning", "error", "reason", "empty", "emptyText", "emptyTitle",
  "emptyDescription", "emptyMessage", "emptyError", "cta", "confirmLabel", "cancelLabel", "submitLabel",
  "buttonLabel", "actionLabel", "confirmText", "successMessage", "errorMessage", "loadingText", "noun",
  "plural", "pending", "cannot", "success", "name"
];
const TEXT_ATTRIBUTES = new Set([...TEXT_NAMES, "aria-label", "aria-description", "aria-placeholder", "aria-roledescription", "aria-valuetext"]);
const TEXT_PROPERTIES = new Set(TEXT_NAMES);

const NOTIFY_CALLS = new Set([
  "pushToast", "showToast", "toast", "notify", "setToast", "setNotice", "setError", "setMessage", "setWarning",
  "setSuccess", "setStatusMessage", "setFormError", "setSubmitError", "setLoadError", "setSaveError", "setInfo",
  "setHint", "setFeedback", "setBanner", "alert", "confirm"
]);

// Exact texts that are the same in both languages (acronyms, brands, units, format masks).
const ALLOWED = new Set([
  "ID", "IDs", "CSV", "XLSX", "XLS", "PDF", "JSON", "XML", "HTML", "URL", "URLs", "API", "CMS", "ISRC", "UPC", "EAN",
  "GRid", "ISWC", "ISNI", "UUID", "SKU", "HD", "SD", "4K", "USD", "VND", "GBP", "EUR", "JPY", "KRW", "OK", "EN", "VI",
  "VN", "KB", "MB", "GB", "TB", "ms", "px", "UTC", "GMT", "ISO", "RSS", "SQL", "SQLite", "HTTP", "HTTPS", "OAuth",
  "YouTube", "YouTube Studio", "YouTube CMS", "Google", "Content ID", "ANS", "ANS Network", "MCN", "Art Track",
  "Dropbox", "SFTP", "Excel", "Google Sheets", "TikTok", "Spotify", "Facebook", "Instagram", "Apple Music", "Email",
  "E-mail", "Video", "YYYY-MM-DD", "YYYY-MM", "HH:MM", "HH:MM:SS", "N/A", "n/a"
]);

const LETTERS = /[A-Za-zÀ-ÿĀ-ſẠ-ỹ]{2,}/;
// Single lowercase tokens are enum values / option names in properties and call arguments ("warning",
// "numeric", "2-digit"); they are still flagged as JSX text, where a lowercase word is copy.
const IDENTIFIER_LIKE = /^[a-z][a-z0-9_.:/-]*$/;
const LOCALE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})+$/;
const SKIP_SHAPES = [
  /^https?:\/\//i,
  /^[\w.+-]+@[\w-]+\.[\w.-]+$/,
  /^[./\\]/,
  /^[a-z]+\/[a-z0-9.+-]+$/i,
  /^\.[a-z0-9]+$/i,
  /^#[0-9a-f]{3,8}$/i,
  /^[A-Z][A-Z0-9_]*(_[A-Z0-9]+)+$/,
  /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/,
  /^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/
];

function stripPunctuation(text) {
  return text.replace(/^[\s:.,;!?()[\]{}"'·•…\-–—/|]+|[\s:.,;!?()[\]{}"'·•…\-–—/|]+$/g, "");
}

// `tolerant` is true for call arguments and object properties, false for JSX text / attributes.
function isAllowed(raw, tolerant) {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!LETTERS.test(text)) return true;
  const core = stripPunctuation(text);
  if (ALLOWED.has(core) || ALLOWED.has(text)) return true;
  if (core.length <= 4 && !/[a-zÀ-ỹ]/.test(core)) return true;
  if (SKIP_SHAPES.some((shape) => shape.test(core))) return true;
  if (tolerant && (IDENTIFIER_LIKE.test(core) || LOCALE_TAG.test(core))) return true;
  return false;
}

function isTranslateCallee(callee) {
  if (!callee) return false;
  if (callee.type === "Identifier") return TRANSLATE_CALLS.has(callee.name);
  if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") return TRANSLATE_CALLS.has(callee.property.name);
  return false;
}

function attributeName(attribute) {
  const name = attribute.name;
  if (!name) return "";
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXNamespacedName") return `${name.namespace.name}:${name.name.name}`;
  return "";
}

function propertyName(property) {
  if (property.computed) return null;
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "Literal") return String(property.key.value);
  return null;
}

export default {
  meta: {
    type: "problem",
    docs: { description: "User-visible literals in the bilingual pages must go through t() / tk() / tm()." },
    schema: [],
    messages: {
      untranslated: "Untranslated text {{text}}: wrap it in t(\"…\") where it is rendered (tk(\"…\") for a canonical constant or a stored message) and add the Vietnamese entry."
    }
  },

  create(context) {
    const sourceCode = context.sourceCode;

    function insideTranslateCall(node) {
      return sourceCode.getAncestors(node).some((ancestor) => ancestor.type === "CallExpression" && isTranslateCallee(ancestor.callee));
    }

    function report(node, text) {
      const shown = String(text).replace(/\s+/g, " ").trim();
      context.report({ node, messageId: "untranslated", data: { text: JSON.stringify(shown.length > 60 ? `${shown.slice(0, 57)}…` : shown) } });
    }

    function checkExpression(node, inCall, depth) {
      if (!node || depth > 8) return;
      switch (node.type) {
        case "Literal":
          if (typeof node.value === "string" && !isAllowed(node.value, inCall)) report(node, node.value);
          return;
        case "TemplateLiteral": {
          const text = node.quasis.map((quasi) => quasi.value.cooked ?? "").join(" ");
          if (!isAllowed(text, inCall)) report(node, text);
          node.expressions.forEach((expression) => checkExpression(expression, inCall, depth + 1));
          return;
        }
        case "ConditionalExpression":
          checkExpression(node.consequent, inCall, depth + 1);
          checkExpression(node.alternate, inCall, depth + 1);
          return;
        case "LogicalExpression":
          checkExpression(node.left, inCall, depth + 1);
          checkExpression(node.right, inCall, depth + 1);
          return;
        case "BinaryExpression":
          if (node.operator === "+") {
            checkExpression(node.left, inCall, depth + 1);
            checkExpression(node.right, inCall, depth + 1);
          }
          return;
        case "SequenceExpression":
          checkExpression(node.expressions[node.expressions.length - 1], inCall, depth + 1);
          return;
        case "ArrayExpression":
          node.elements.forEach((element) => checkExpression(element, inCall, depth + 1));
          return;
        case "ChainExpression":
          checkExpression(node.expression, inCall, depth + 1);
          return;
        case "CallExpression":
          if (isTranslateCallee(node.callee)) return;
          // Formatting calls (join, toFixed, toLocaleString) carry option tokens, not copy: lowercase
          // identifier-like arguments are tolerated here, sentences are not.
          node.arguments.forEach((argument) => checkExpression(argument, true, depth + 1));
          return;
        default:
          return;
      }
    }

    return {
      JSXText(node) {
        if (!isAllowed(node.value, false)) report(node, node.value);
      },

      JSXExpressionContainer(node) {
        const parent = node.parent;
        if (!parent) return;
        const childPosition = parent.type === "JSXElement" || parent.type === "JSXFragment";
        const attributePosition = parent.type === "JSXAttribute" && TEXT_ATTRIBUTES.has(attributeName(parent));
        if (!childPosition && !attributePosition) return;
        if (!node.expression || node.expression.type === "JSXEmptyExpression") return;
        if (insideTranslateCall(node)) return;
        checkExpression(node.expression, false, 0);
      },

      JSXAttribute(node) {
        if (!TEXT_ATTRIBUTES.has(attributeName(node))) return;
        if (node.value && node.value.type === "Literal" && typeof node.value.value === "string" && !isAllowed(node.value.value, false)) {
          report(node.value, node.value.value);
        }
      },

      Property(node) {
        if (node.kind !== "init" || node.shorthand || node.method) return;
        const name = propertyName(node);
        if (!name || !TEXT_PROPERTIES.has(name)) return;
        if (insideTranslateCall(node)) return;
        // Tolerant: `tone: "warning"`-style enum values share these property names with real copy.
        checkExpression(node.value, true, 0);
      },

      CallExpression(node) {
        const callee = node.callee;
        let name = null;
        if (callee.type === "Identifier") name = callee.name;
        else if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier" && callee.object.type === "Identifier" && callee.object.name === "window") name = callee.property.name;
        if (!name || !NOTIFY_CALLS.has(name)) return;
        // Only the message argument: later arguments are tones / options (pushToast(text, "warning")).
        checkExpression(node.arguments[0], true, 0);
      }
    };
  }
};
