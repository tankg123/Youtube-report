import { Clock, TriangleAlert } from "lucide-react";
import { useI18n } from "../../context/I18nContext";
import { Button, InlineMessage, Modal } from "./shared";
import { formatBytes } from "./utils";
import { MIN_VIDEO_REFERENCE_SECONDS, formatSeconds } from "./mediaProbe";

/**
 * Pop-up listing video files refused because they are shorter than a Content ID reference
 * may be. `items`: [{ file | name, size, duration }]; nothing was uploaded for them.
 */
export default function ShortMediaDialog({ items = [], minSeconds = MIN_VIDEO_REFERENCE_SECONDS, onClose }) {
  const { t } = useI18n();
  if (!items.length) return null;
  return (
    <Modal
      open
      size="md"
      title={t("Video too short for a Content ID reference")}
      subtitle={
        items.length === 1
          ? t("References must be at least {seconds} seconds long. {count} file was not uploaded.", { seconds: minSeconds, count: items.length })
          : t("References must be at least {seconds} seconds long. {count} files were not uploaded.", { seconds: minSeconds, count: items.length })
      }
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t("OK, got it")}
        </Button>
      }
    >
      <div className="space-y-4">
        <InlineMessage tone="warning" icon={TriangleAlert}>
          {t("YouTube cannot build a fingerprint from clips this short, so they would be rejected or match nothing. Trim-free fixes: deliver the full-length video instead, or combine short clips into one longer reference.")}
        </InlineMessage>
        <ul className="max-h-64 space-y-2 overflow-y-auto rounded-2xl bg-slate-50 p-3">
          {items.map((item, index) => {
            const name = item.file?.name || item.name || t("File {number}", { number: index + 1 });
            const size = item.file?.size ?? item.size;
            return (
              <li key={`${name}-${index}`} className="flex items-center justify-between gap-3 rounded-xl bg-white px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="block truncate font-black text-slate-900" title={name}>
                    {name}
                  </span>
                  {Number.isFinite(Number(size)) && size > 0 && <span className="block text-[11px] font-bold text-slate-400">{formatBytes(size)}</span>}
                </span>
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-50 px-2.5 py-1 text-xs font-black text-red-600">
                  <Clock size={12} /> {formatSeconds(item.duration)}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}
