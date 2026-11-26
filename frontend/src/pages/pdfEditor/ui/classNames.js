/** Joins class names, skipping everything that is not a non-empty string. */
export const cx = (...parts) => parts.filter((part) => typeof part === "string" && part).join(" ");
