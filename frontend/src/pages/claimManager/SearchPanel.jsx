import { useId } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronLeft, ChevronRight, CircleGauge, FileSearch, Filter, RotateCcw, X } from "lucide-react";
import { useI18n } from "../../context/I18nContext";
import { Button, Field, InlineMessage, Select, TextArea, TextInput, Toggle } from "../assetDelivery/shared";
import { cx } from "../assetDelivery/utils";
import { CLAIM_ORIGINS, CLAIM_STATUSES, CONTENT_TYPES, EMPTY_FILTERS, EXPLORE_SORTS, PARTNER_UPLOADED_OPTIONS, SEARCH_MODES } from "./constants";
import { Chip, Kbd, SegmentedControl } from "./shared";
import { countActiveFilters, modeLimit, modeMeta, removeLines, statusLabel, toggleInList } from "./utils";

// Short names in the segmented control (four buttons in a 400 px column); the long label and the hint stay on the input Field.
const MODE_OPTIONS = SEARCH_MODES.map((mode) => ({ value: mode.key, label: mode.shortLabel || mode.label, title: mode.hint }));
const ORIGIN_OPTIONS = CLAIM_ORIGINS.map((origin) => ({ value: origin.value, label: origin.label }));
const INVALID_PREVIEW = 5;

function CmsSelector({ accounts, missing, loading, loaded, selectedIds, onChange, disabled, canOpenNetworks }) {
  const { t } = useI18n();
  const allSelected = accounts.length > 0 && selectedIds.length === accounts.length;
  const missingNames = missing.map((account) => account.name).join(", ");
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-black uppercase tracking-wide text-slate-400">{t("CMS networks")}</span>
        <span className="flex items-center gap-3 text-xs font-black">
          <span className="text-slate-400">
            {t("{selected}/{total} selected", { selected: selectedIds.length, total: accounts.length })}
          </span>
          <button
            type="button"
            disabled={disabled || allSelected || !accounts.length}
            onClick={() => onChange(accounts.map((account) => account.id))}
            className="text-blue-700 hover:underline disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("Select all")}
          </button>
          <button
            type="button"
            disabled={disabled || !selectedIds.length}
            onClick={() => onChange([])}
            className="text-slate-500 hover:underline disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("Clear")}
          </button>
        </span>
      </div>

      {loading && !loaded ? (
        <div className="mt-3 flex flex-wrap gap-2" aria-busy="true">
          {[0, 1, 2].map((item) => (
            <span key={item} className="h-8 w-28 animate-pulse rounded-xl bg-slate-200" />
          ))}
        </div>
      ) : accounts.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {accounts.map((account) => {
            const active = selectedIds.includes(account.id);
            return (
              <Chip
                key={account.id}
                active={active}
                disabled={disabled}
                title={[account.network_code, account.cms_auth_email].filter(Boolean).join(" · ") || account.name}
                onClick={() => onChange(active ? selectedIds.filter((id) => id !== account.id) : [...selectedIds, account.id])}
              >
                {account.name}
                {account.network_code && <span className="ml-1 font-mono text-[10px] font-bold text-slate-400">{account.network_code}</span>}
              </Chip>
            );
          })}
        </div>
      ) : (
        <p className="mt-3 text-xs font-bold text-slate-500">{t("No connected CMS with the YouTube Partner scope.")}</p>
      )}
      <p className="mt-2 text-[11px] text-slate-400">{t("Each selected CMS adds one claim-search read per batch of videos. Keep only the CMS you need.")}</p>

      {missing.length > 0 && (
        <InlineMessage
          tone="warning"
          className="mt-3"
          title={t("{count} CMS without the YouTube Partner scope", { count: missing.length })}
          actions={
            canOpenNetworks ? (
              <Link to="/networks" className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-amber-200 bg-white px-3 text-xs font-black text-amber-700 hover:bg-amber-50">
                {t("Open Networks")}
              </Link>
            ) : null
          }
        >
          {canOpenNetworks
            ? t("{networks}: re-authorize in Settings > Network before claims can be read.", { networks: missingNames })
            : t("{networks}: ask an administrator to re-authorize the CMS in Settings > Network before claims can be read.", { networks: missingNames })}
        </InlineMessage>
      )}
    </div>
  );
}

function FiltersSection({ open, onOpenChange, filters, onChange, mode, disabled }) {
  const { t } = useI18n();
  // One useId() call with suffixes so every control gets a label (htmlFor) without colliding across mounts.
  const baseId = useId();
  const ids = {
    origin: `${baseId}-origin`,
    createdAfter: `${baseId}-created-after`,
    createdBefore: `${baseId}-created-before`,
    modifiedAfter: `${baseId}-modified-after`,
    modifiedBefore: `${baseId}-modified-before`,
    uploader: `${baseId}-uploader`,
    sort: `${baseId}-sort`
  };
  const count = countActiveFilters(filters);
  const update = (patch) => onChange({ ...filters, ...patch });
  const pristine = !count && (filters.sort || "DATE") === "DATE";
  return (
    <div className="rounded-2xl border border-slate-200">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="flex w-full items-center justify-between gap-2 rounded-2xl px-3 py-2.5 text-left hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
      >
        <span className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-wide text-slate-500">
          <Filter size={13} />
          {t("Filters")}
          {count > 0 && <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] text-blue-700">{count}</span>}
        </span>
        <ChevronDown size={16} className={cx("text-slate-400 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="space-y-3 border-t border-slate-100 p-3">
          <Field label={t("Status")}>
            <div role="group" aria-label={t("Status filter")} className="flex flex-wrap gap-1.5">
              {CLAIM_STATUSES.map((status) => (
                <Chip key={status} active={filters.statuses.includes(status)} disabled={disabled} onClick={() => update({ statuses: toggleInList(filters.statuses, status) })}>
                  {t(statusLabel(status))}
                </Chip>
              ))}
            </div>
          </Field>
          <Field label={t("Content type")}>
            <div role="group" aria-label={t("Content type filter")} className="flex flex-wrap gap-1.5">
              {CONTENT_TYPES.map((type) => (
                <Chip key={type.value} active={filters.content_types.includes(type.value)} disabled={disabled} onClick={() => update({ content_types: toggleInList(filters.content_types, type.value) })}>
                  {t(type.label)}
                </Chip>
              ))}
            </div>
          </Field>
          <Field label={t("Origin")} htmlFor={ids.origin}>
            <Select
              id={ids.origin}
              compact
              disabled={disabled}
              value={filters.origins[0] || ""}
              placeholder={t("Any origin")}
              options={ORIGIN_OPTIONS.map((option) => ({ ...option, label: t(option.label) }))}
              onChange={(event) => update({ origins: event.target.value ? [event.target.value] : [] })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t("Created after")} htmlFor={ids.createdAfter}>
              <TextInput id={ids.createdAfter} type="date" compact disabled={disabled} value={filters.created_after} onChange={(event) => update({ created_after: event.target.value })} />
            </Field>
            <Field label={t("Created before")} htmlFor={ids.createdBefore}>
              <TextInput id={ids.createdBefore} type="date" compact disabled={disabled} value={filters.created_before} onChange={(event) => update({ created_before: event.target.value })} />
            </Field>
            <Field label={t("Status modified after")} htmlFor={ids.modifiedAfter}>
              <TextInput
                id={ids.modifiedAfter}
                type="date"
                compact
                disabled={disabled}
                value={filters.status_modified_after}
                onChange={(event) => update({ status_modified_after: event.target.value })}
              />
            </Field>
            <Field label={t("Status modified before")} htmlFor={ids.modifiedBefore}>
              <TextInput
                id={ids.modifiedBefore}
                type="date"
                compact
                disabled={disabled}
                value={filters.status_modified_before}
                onChange={(event) => update({ status_modified_before: event.target.value })}
              />
            </Field>
          </div>
          <Field label={t("Uploader")} htmlFor={ids.uploader}>
            <Select
              id={ids.uploader}
              compact
              disabled={disabled}
              value={filters.partner_uploaded === null || filters.partner_uploaded === undefined ? "" : String(filters.partner_uploaded)}
              options={PARTNER_UPLOADED_OPTIONS.map((option) => ({ ...option, label: t(option.label) }))}
              onChange={(event) => update({ partner_uploaded: event.target.value === "" ? null : event.target.value === "true" })}
            />
          </Field>
          {mode === "explore" && (
            <Field label={t("Sort (Explore)")} htmlFor={ids.sort}>
              <Select id={ids.sort} compact disabled={disabled} value={filters.sort || "DATE"} options={EXPLORE_SORTS.map((option) => ({ ...option, label: t(option.label) }))} onChange={(event) => update({ sort: event.target.value })} />
            </Field>
          )}
          <button
            type="button"
            disabled={disabled || pristine}
            onClick={() => onChange({ ...EMPTY_FILTERS })}
            className="text-xs font-black text-slate-500 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("Reset filters")}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Left column of the "Check claims" tab: CMS selection, search mode, input, filters,
 * details toggle, request-plan estimate and the Search / Cancel / Clear actions.
 */
export default function SearchPanel({
  accounts,
  missingScopeAccounts,
  accountsLoading,
  accountsLoaded,
  canOpenNetworks,
  selectedNetworkIds,
  onNetworkIdsChange,
  mode,
  onModeChange,
  value,
  onValueChange,
  filters,
  onFiltersChange,
  filtersOpen,
  onFiltersOpenChange,
  includeDetails,
  onIncludeDetailsChange,
  limited,
  limits,
  parsed,
  validation,
  attempted,
  plan,
  loading,
  disabled,
  onSearch,
  onCancel,
  onClear,
  explore
}) {
  const { t, tm } = useI18n();
  const inputId = useId();
  const meta = modeMeta(mode);
  const limit = modeLimit(mode, limits);
  const count = parsed.ids.length;
  const over = limit > 0 && count > limit;
  const formDisabled = disabled || loading;
  const showInvalid = mode === "videos" && attempted && parsed.invalid.length > 0;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSearch();
      }}
      className="space-y-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div>
        <h2 className="text-lg font-black text-slate-950">{t("Claim lookup")}</h2>
        <p className="mt-1 text-sm text-slate-500">{t("Pick the CMS networks, choose what to search by and press Search.")}</p>
      </div>

      <CmsSelector
        accounts={accounts}
        missing={missingScopeAccounts}
        loading={accountsLoading}
        loaded={accountsLoaded}
        selectedIds={selectedNetworkIds}
        onChange={onNetworkIdsChange}
        disabled={formDisabled}
        canOpenNetworks={canOpenNetworks}
      />

      <Field label={t("Search by")}>
        <SegmentedControl
          label={t("Search by")}
          options={MODE_OPTIONS.map((option) => ({ ...option, label: t(option.label), title: t(option.title) }))}
          value={mode}
          onChange={onModeChange}
          disabled={formDisabled}
        />
      </Field>

      <Field
        label={t(meta.label)}
        htmlFor={inputId}
        hint={t(meta.hint)}
        actions={
          mode !== "explore" ? (
            <span className={cx("text-xs font-black", over ? "text-red-600" : "text-slate-400")}>
              {t("{count}/{limit} unique {items}", { count, limit, items: t(meta.plural) })}
              {parsed.duplicates > 0 && (
                <span className="font-bold text-slate-400">
                  {" · "}
                  {parsed.duplicates === 1 ? t("{count} duplicate ignored", { count: parsed.duplicates }) : t("{count} duplicates ignored", { count: parsed.duplicates })}
                </span>
              )}
              {parsed.invalid.length > 0 && (
                <span className="font-bold text-amber-600">
                  {" · "}
                  {parsed.invalid.length === 1 ? t("{count} invalid line", { count: parsed.invalid.length }) : t("{count} invalid lines", { count: parsed.invalid.length })}
                </span>
              )}
            </span>
          ) : null
        }
      >
        {mode === "explore" ? (
          <TextInput id={inputId} value={value} disabled={formDisabled} placeholder={t(meta.placeholder)} onChange={(event) => onValueChange(event.target.value)} />
        ) : (
          <TextArea
            id={inputId}
            mono
            rows={meta.rows}
            value={value}
            disabled={formDisabled}
            invalid={over}
            placeholder={t(meta.placeholder)}
            spellCheck={false}
            onChange={(event) => onValueChange(event.target.value)}
          />
        )}
      </Field>

      {showInvalid && (
        <InlineMessage
          tone="warning"
          title={
            parsed.invalid.length === 1
              ? t("{count} line without a video ID (ignored)", { count: parsed.invalid.length })
              : t("{count} lines without a video ID (ignored)", { count: parsed.invalid.length })
          }
          actions={
            <Button size="sm" variant="secondary" icon={X} disabled={formDisabled} onClick={() => onValueChange(removeLines(value, parsed.invalid))}>
              {t("Remove them")}
            </Button>
          }
        >
          <ul className="mt-1 space-y-0.5">
            {parsed.invalid.slice(0, INVALID_PREVIEW).map((line, index) => (
              // The same invalid line can be pasted twice, so the index is part of the key.
              <li key={`${index}-${line}`} className="max-w-full truncate font-mono text-xs" title={line}>
                {line}
              </li>
            ))}
            {parsed.invalid.length > INVALID_PREVIEW && <li className="text-xs">{t("+{count} more", { count: parsed.invalid.length - INVALID_PREVIEW })}</li>}
          </ul>
        </InlineMessage>
      )}

      <FiltersSection open={filtersOpen} onOpenChange={onFiltersOpenChange} filters={filters} onChange={onFiltersChange} mode={mode} disabled={formDisabled} />

      <Toggle
        checked={includeDetails}
        disabled={formDisabled || limited}
        onChange={onIncludeDetailsChange}
        label={t("Load video & asset details")}
        description={
          limited
            ? t("Always on for your role: asset labels are read to enforce your label permissions.")
            : t("Adds YouTube video previews and asset metadata (title, ISRC, UPC, labels). Turn off for the fastest lookup.")
        }
        className="w-full rounded-2xl border border-slate-200 p-3"
      />

      <div className="rounded-2xl bg-blue-50 px-3 py-2.5">
        <p className="flex items-start gap-2 text-xs font-bold text-blue-700">
          <CircleGauge size={14} className="mt-0.5 shrink-0" />
          <span>{plan.text}</span>
        </p>
        <p className="mt-1 text-[11px] text-blue-600/80">{t("Request-count estimate, not quota units.")}</p>
      </div>

      {attempted && validation && <InlineMessage tone="error">{tm(validation)}</InlineMessage>}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" icon={FileSearch} loading={loading} disabled={disabled} className="flex-1">
          {loading ? t("Searching…") : t("Search claims")}
        </Button>
        {loading && (
          <Button variant="secondary" icon={X} onClick={onCancel}>
            {t("Cancel")}
          </Button>
        )}
        <Button variant="ghost" icon={RotateCcw} disabled={formDisabled} onClick={onClear} title={t("Clear the input, the filters and the results")}>
          {t("Clear")}
        </Button>
      </div>
      <p className="text-[11px] text-slate-400">
        {t("Shortcut: {ctrl} / {cmd} + {enter} runs the search.", { ctrl: <Kbd>{t("Ctrl")}</Kbd>, cmd: <Kbd>⌘</Kbd>, enter: <Kbd>{t("Enter")}</Kbd> })}
      </p>

      {mode === "explore" && explore?.visible && (
        <div className="flex items-center justify-between gap-2 rounded-2xl border border-slate-200 p-2">
          <Button size="sm" variant="secondary" icon={ChevronLeft} disabled={!explore.hasPrevious || formDisabled} onClick={explore.onPrevious}>
            {t("Previous")}
          </Button>
          <span className="text-xs font-black text-slate-500">{t("Page {page}", { page: explore.pageIndex })}</span>
          <Button size="sm" variant="secondary" icon={ChevronRight} disabled={!explore.hasNext || formDisabled} onClick={explore.onNext}>
            {t("Next")}
          </Button>
        </div>
      )}
    </form>
  );
}
