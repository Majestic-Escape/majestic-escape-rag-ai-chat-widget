import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X, Check, Info } from "lucide-react";
import type { Draft, FilterOp, NumRange, SearchFilters } from "./types";

// The filter editor (a sheet over the chat) and the draft card. Both produce a `FilterOp` that the server
// applies without a model: the guest's own buttons are the authority, never a model's reading.

const AMENITIES: [string, string][] = [
  ["pool", "Pool"], ["wifi", "Wi-Fi"], ["air-conditioning", "AC"], ["kitchen", "Kitchen"], ["free-parking", "Free parking"],
  ["tv", "TV"], ["workspace", "Workspace"], ["washing", "Washing machine"], ["bbq", "BBQ"], ["firepit", "Fire pit / bonfire"],
  ["outdoor-dining", "Outdoor dining"], ["patio", "Patio"], ["beach", "Beach access"], ["lake", "Lakeside"],
  ["pool-table", "Pool table"], ["first-aid", "First aid kit"], ["smoke-alarm", "Smoke alarm"], ["fire-extinguisher", "Fire extinguisher"],
];
const TYPES: [string, string][] = [["", "Any"], ["villa", "Villa"], ["apartment", "Apartment"], ["house", "House"], ["guesthouse", "Guesthouse / homestay"], ["hotel", "Hotel"], ["farmhouse", "Farmhouse"], ["tent", "Tent"]];
const PLACE_TYPES: [string, string][] = [["", "Any"], ["entire", "Entire place"], ["room", "A room"]];
const CANCELLATION: [string, string][] = [["", "Any"], ["flexible", "Flexible"], ["moderate", "Moderate"], ["strict", "Strict"]];

interface Form {
  place: string; guests: string; priceMin: string; priceMax: string; bedrooms: string; bathrooms: string;
  propertyType: string; placeType: string; cancellation: string; amenities: string[];
  petsAllowed: boolean; instantBook: boolean; selfCheckIn: boolean;
}
const n = (r: NumRange | undefined, end: "min" | "max") => (r?.[end] !== undefined ? String(r[end]) : "");
export const formOf = (s: SearchFilters): Form => ({
  place: s.place ?? "",
  guests: n(s.guests, "min") || n(s.guests, "max"),
  priceMin: n(s.price, "min"), priceMax: n(s.price, "max"),
  bedrooms: n(s.bedrooms, "min") || n(s.bedrooms, "max"),
  bathrooms: n(s.bathrooms, "min") || n(s.bathrooms, "max"),
  propertyType: s.propertyType ?? "", placeType: s.placeType ?? "", cancellation: s.cancellation ?? "",
  amenities: [...(s.amenitiesAll ?? [])],
  petsAllowed: !!s.petsAllowed, instantBook: !!s.instantBook, selfCheckIn: !!s.selfCheckIn,
});

const inr = (x: number) => `₹${x.toLocaleString("en-IN")}`;
const label = (k: string, list: [string, string][]) => list.find(([v]) => v === k)?.[1] ?? k;

/** The change from `a` to `b` as one op (only what the guest changed), with a readable summary.
 *  An edited value replaces the old one exactly: unset, then set. */
export function diffOp(a: Form, b: Form): { op: FilterOp; changes: string[] } | { error: string } {
  const op: Required<Pick<FilterOp, "set" | "unset" | "remove">> = { set: {}, unset: [], remove: [] };
  const changes: string[] = [];
  const int = (s: string, max: number, name: string): number | undefined | string => {
    if (!s.trim()) return undefined;
    const v = Number(s);
    return Number.isInteger(v) && v >= 0 && v <= max ? v : `${name} must be a whole number up to ${max.toLocaleString("en-IN")}.`;
  };
  const scalar = (field: string, before: string, after: string, value: unknown, text: string) => {
    if (before === after) return;
    op.unset.push(field);
    if (after) { op.set[field] = value; changes.push(text); } else changes.push(`${text.split(":")[0]}: any`);
  };
  const place = b.place.trim();
  scalar("place", a.place.trim(), place, place, `Location: ${place}`);
  for (const [field, key, max, word] of [["guests", "guests", 50, "Guests"], ["bedrooms", "bedrooms", 30, "Bedrooms"], ["bathrooms", "bathrooms", 30, "Bathrooms"]] as const) {
    const v = int(b[key], max, word);
    if (typeof v === "string") return { error: v };
    if (v === 0 && field === "guests") return { error: "Guests must be at least 1." };
    scalar(field, a[key].trim(), b[key].trim(), { min: v }, field === "guests" ? `Guests: ${v}` : `${word}: ${v}+`);
  }
  if (a.priceMin.trim() !== b.priceMin.trim() || a.priceMax.trim() !== b.priceMax.trim()) {
    const lo = int(b.priceMin, 10_000_000, "The budget");
    const hi = int(b.priceMax, 10_000_000, "The budget");
    if (typeof lo === "string") return { error: lo };
    if (typeof hi === "string") return { error: hi };
    if (lo !== undefined && hi !== undefined && lo > hi) return { error: "The lowest price must not be above the highest." };
    op.unset.push("price");
    if (lo === undefined && hi === undefined) changes.push("Budget: any");
    else {
      op.set.price = { ...(lo !== undefined ? { min: lo } : {}), ...(hi !== undefined ? { max: hi } : {}) };
      changes.push(`Budget: ${lo !== undefined && hi !== undefined ? `${inr(lo)}–${inr(hi)}` : hi !== undefined ? `up to ${inr(hi)}` : `from ${inr(lo!)}`}/night`);
    }
  }
  scalar("propertyType", a.propertyType, b.propertyType, b.propertyType, `Type: ${label(b.propertyType, TYPES).toLowerCase()}`);
  scalar("placeType", a.placeType, b.placeType, b.placeType, `Place: ${label(b.placeType, PLACE_TYPES).toLowerCase()}`);
  scalar("cancellation", a.cancellation, b.cancellation, b.cancellation, `Cancellation: ${b.cancellation}`);
  for (const [field, text] of [["petsAllowed", "Pets allowed"], ["instantBook", "Instant book"], ["selfCheckIn", "Self check-in"]] as const) {
    if (a[field] === b[field]) continue;
    if (b[field]) { op.set[field] = true; changes.push(text); } else { op.unset.push(field); changes.push(`${text}: not needed`); }
  }
  const added = b.amenities.filter((x) => !a.amenities.includes(x));
  const removed = a.amenities.filter((x) => !b.amenities.includes(x));
  if (added.length) { op.set.amenitiesAll = added; changes.push(`Add ${added.map((x) => label(x, AMENITIES)).join(", ")}`); }
  if (removed.length) { op.remove.push(...removed); changes.push(`Remove ${removed.map((x) => label(x, AMENITIES)).join(", ")}`); }
  const out: FilterOp = {};
  if (Object.keys(op.set).length) out.set = op.set;
  if (op.unset.length) out.unset = op.unset;
  if (op.remove.length) out.remove = op.remove;
  return { op: out, changes };
}

const field = "w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-[14px] text-graphite focus:outline-none focus:border-primaryGreen focus:ring-1 focus:ring-primaryGreen";
const caption = "block text-[12px] font-semibold text-gray-600 mb-1";

export const FilterEditor: React.FC<{
  isOpen: boolean;
  initial: SearchFilters;
  /** Things the form cannot edit but the search still has ("private pool", "no TV"): shown, kept. */
  others: string[];
  returnFocusRef: React.RefObject<HTMLElement | null>;
  onApply: (op: FilterOp, summary: string) => void;
  onReset: () => void;
  onClose: () => void;
}> = ({ isOpen, initial, others, returnFocusRef, onApply, onReset, onClose }) => {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const [start, setStart] = useState<Form>(() => formOf(initial));
  const [form, setForm] = useState<Form>(start);
  const [error, setError] = useState<string | null>(null);

  // Each opening starts from the search as it is now.
  useEffect(() => {
    if (!isOpen) return;
    const f = formOf(initial);
    setStart(f);
    setForm(f);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  // Focus into the sheet when it opens (a modal dialog), back to the opener when it closes.
  const wasOpen = useRef(isOpen);
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet || isOpen === wasOpen.current) return;
    wasOpen.current = isOpen;
    if (isOpen) sheet.focus({ preventScroll: true });
    else if (sheet.contains((sheet.getRootNode() as Document | ShadowRoot).activeElement)) returnFocusRef.current?.focus({ preventScroll: true });
  }, [isOpen, returnFocusRef]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => { setForm((f) => ({ ...f, [k]: v })); setError(null); };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const d = diffOp(start, form);
    if ("error" in d) { setError(d.error); return; }
    if (!d.changes.length) { onClose(); return; }
    onApply(d.op, d.changes.join(" · "));
  };
  const num = (k: "guests" | "priceMin" | "priceMax" | "bedrooms" | "bathrooms", text: string, hint?: string) => (
    <label className="block">
      <span className={caption}>{text}</span>
      <input inputMode="numeric" pattern="[0-9]*" value={form[k]} onChange={(e) => set(k, e.target.value.replace(/[^0-9]/g, ""))} placeholder={hint ?? "Any"} className={field} />
    </label>
  );
  // Pick-one chips, styled like "Must have". Native dropdowns opened an OS list (blue, wider than the panel on
  // Windows) that no CSS reaches. Real radio inputs keep the group semantics and arrow-key movement.
  const choice = (k: "propertyType" | "placeType" | "cancellation", text: string, options: [string, string][]) => (
    <fieldset>
      <legend className={caption}>{text}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map(([v, t]) => {
          const on = form[k] === v;
          return (
            <label key={v} className="relative cursor-pointer">
              <input type="radio" name={`mc-filter-${k}`} value={v} checked={on} onChange={() => set(k, v)} className="peer sr-only" />
              <span
                className={`inline-flex items-center gap-1 rounded-full border text-[12px] font-medium px-2.5 py-1 min-h-[32px] whitespace-nowrap peer-focus-visible:ring-2 peer-focus-visible:ring-primaryGreen peer-focus-visible:ring-offset-1 ${
                  on ? "border-primaryGreen bg-lightGreen/50 text-primaryGreen" : "border-gray-200 text-gray-600 hover:bg-gray-50"
                }`}
              >
                {on && <Check className="w-3 h-3" aria-hidden="true" />}
                {t}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );

  // The sheet waits below the panel while closed. `overflow-clip` (not `hidden`) on this wrapper: clip makes no
  // scroll container, so the parked sheet adds no scroll room to the panel. With it, any scroll-into-view (focus,
  // autofill, a test driver) scrolled the whole panel up and left a blank band under the message box.
  return (
    <div className="absolute inset-0 z-40 overflow-clip pointer-events-none">
      <div onClick={onClose} aria-hidden="true" className={`absolute inset-0 bg-graphite/20 transition-opacity duration-200 ${isOpen ? "opacity-100 pointer-events-auto" : "opacity-0"}`} />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mc-filter-title"
        inert={!isOpen}
        tabIndex={-1}
        className={`absolute left-0 right-0 bottom-0 max-h-[92%] flex flex-col outline-none bg-white shadow-xl rounded-t-2xl duration-200 ease-out ${
          isOpen ? "visible translate-y-0 transition-transform pointer-events-auto" : "invisible translate-y-full transition-[transform,visibility]"
        }`}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <h3 id="mc-filter-title" className="font-semibold text-graphite text-[15px]">Your search</h3>
          <button type="button" onClick={onClose} aria-label="Close filters" className="p-1.5 hover:bg-gray-100 rounded-full text-gray-500 hover:text-gray-800 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={submit} className="flex flex-col min-h-0 flex-1">
          <div data-mc-scroll className="overflow-y-auto overscroll-contain px-4 py-3 flex flex-col gap-3">
            <label className="block">
              <span className={caption}>Where</span>
              <input value={form.place} onChange={(e) => set("place", e.target.value.slice(0, 80))} placeholder="City, area or stay name" autoComplete="off" className={field} />
            </label>
            <div className="grid grid-cols-2 gap-3">
              {num("guests", "Guests")}
              {num("bedrooms", "Bedrooms (at least)")}
              {num("bathrooms", "Bathrooms (at least)")}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {num("priceMin", "Min ₹ per night")}
              {num("priceMax", "Max ₹ per night")}
            </div>
            <p className="text-[11px] text-gray-500 -mt-1">Nightly base price, before taxes and fees. The stay page shows the total for your dates.</p>
            {choice("propertyType", "Type", TYPES)}
            {choice("placeType", "Entire place or room", PLACE_TYPES)}
            {choice("cancellation", "Cancellation", CANCELLATION)}
            <fieldset>
              <legend className={caption}>Must have</legend>
              <div className="flex flex-wrap gap-1.5">
                {AMENITIES.map(([k, t]) => {
                  const on = form.amenities.includes(k);
                  return (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={on}
                      onClick={() => set("amenities", on ? form.amenities.filter((x) => x !== k) : [...form.amenities, k])}
                      className={`inline-flex items-center gap-1 rounded-full border text-[12px] font-medium px-2.5 py-1 min-h-[32px] ${
                        on ? "border-primaryGreen bg-lightGreen/50 text-primaryGreen" : "border-gray-200 text-gray-600 hover:bg-gray-50"
                      }`}
                    >
                      {on && <Check className="w-3 h-3" aria-hidden="true" />}
                      {t}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <fieldset className="flex flex-col gap-1.5">
              <legend className={caption}>Options</legend>
              {([["petsAllowed", "Pets allowed"], ["instantBook", "Instant book"], ["selfCheckIn", "Self check-in"]] as const).map(([k, t]) => (
                <label key={k} className="flex items-center gap-2 text-[14px] text-graphite min-h-[32px]">
                  <input type="checkbox" checked={form[k]} onChange={(e) => set(k, e.target.checked)} className="w-4 h-4 accent-primaryGreen" />
                  {t}
                </label>
              ))}
            </fieldset>
            {others.length > 0 && (
              <p className="text-[12px] text-gray-500">Also in your search (remove them with × on their chips): {others.join(", ")}.</p>
            )}
            {error && <p role="alert" className="text-[13px] text-red-600">{error}</p>}
          </div>
          <div className="flex items-center gap-2 px-4 py-3 border-t border-gray-100">
            <button type="button" onClick={onReset} className="rounded-full border border-gray-200 text-gray-600 text-[13px] font-medium px-3 py-2 hover:bg-gray-50">Clear all</button>
            <button type="submit" className="ml-auto rounded-full bg-primaryGreen hover:bg-brightGreen text-white text-[13px] font-semibold px-5 py-2">Show stays</button>
          </div>
        </form>
      </div>
    </div>
  );
};

/** Several confirmed draft lines as one op: removals and sets together, a reset first. */
export function mergeOps(ops: FilterOp[]): FilterOp {
  const out: FilterOp = {};
  const join = (k: "unset" | "remove" | "unsupported" | "soft") => { const v = ops.flatMap((o) => o[k] ?? []); if (v.length) out[k] = [...new Set(v)]; };
  join("unset"); join("remove"); join("unsupported"); join("soft");
  const set: Record<string, unknown> = {};
  for (const o of ops) for (const [k, v] of Object.entries(o.set ?? {})) {
    set[k] = Array.isArray(v) && Array.isArray(set[k]) ? [...new Set([...(set[k] as unknown[]), ...v])] : v;
  }
  if (Object.keys(set).length) out.set = set;
  if (ops.some((o) => o.reset)) out.reset = true;
  return out;
}

const KIND_STYLE: Record<string, string> = {
  remove: "text-red-700", change: "text-amber-800", reset: "text-red-700 font-semibold", unverified: "text-gray-600 italic", soft: "text-gray-600",
};

/** A typed message read as changes. Nothing is applied until the guest taps Apply; each line can be left out. */
export const DraftCard: React.FC<{
  draft: Draft;
  /** Only the newest draft can be applied; older ones are a record. */
  live: boolean;
  disabled: boolean;
  onApply: (op: FilterOp, summary: string) => void;
  onEdit: (opener: HTMLElement) => void;
  onDiscard: () => void;
}> = ({ draft, live, disabled, onApply, onEdit, onDiscard }) => {
  const [keep, setKeep] = useState<boolean[]>(() => draft.lines.map(() => true));
  const chosen = draft.lines.filter((_, i) => keep[i]);
  return (
    <div className="flex flex-col gap-2 text-[14px]">
      <p className="text-[12px] text-gray-500">You wrote: <span className="text-graphite">“{draft.said}”</span></p>
      {draft.lines.length > 0 ? (
        <fieldset disabled={!live} className="flex flex-col gap-1">
          <legend className="text-[13px] font-semibold text-graphite mb-1">Changes to apply:</legend>
          {draft.lines.map((l, i) => (
            <label key={i} className={`flex items-start gap-2 ${KIND_STYLE[l.kind] ?? "text-graphite"}`}>
              <input type="checkbox" checked={keep[i]} onChange={(e) => setKeep((k) => k.map((x, j) => (j === i ? e.target.checked : x)))} className="mt-1 w-4 h-4 accent-primaryGreen shrink-0" />
              <span>{l.label}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="text-graphite">I couldn't find a change to your search in that. You can set it with the filters.</p>
      )}
      {draft.notes.length > 0 && (
        <ul className="flex flex-col gap-1">
          {draft.notes.map((note, i) => (
            <li key={i} className="flex items-start gap-1.5 text-[13px] text-amber-900 bg-amber-50 rounded-lg px-2 py-1.5">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
              <span>Please check: {note}</span>
            </li>
          ))}
        </ul>
      )}
      {live && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {draft.lines.length > 0 && (
            <button
              type="button"
              aria-disabled={disabled || chosen.length === 0}
              onClick={() => !disabled && chosen.length > 0 && onApply(mergeOps(chosen.map((l) => l.op)), chosen.map((l) => l.label).join(" · "))}
              className="rounded-full bg-primaryGreen hover:bg-brightGreen text-white text-[12px] font-semibold px-3.5 py-1.5 aria-disabled:opacity-50"
            >
              Apply {chosen.length === draft.lines.length ? "" : `${chosen.length} of ${draft.lines.length}`}
            </button>
          )}
          <button type="button" aria-disabled={disabled} onClick={(e) => !disabled && onEdit(e.currentTarget)} className="rounded-full border border-primaryGreen/40 text-primaryGreen text-[12px] font-medium px-3 py-1.5 hover:bg-lightGreen/40">
            Edit filters
          </button>
          <button type="button" aria-disabled={disabled} onClick={() => !disabled && onDiscard()} className="rounded-full border border-gray-200 text-gray-600 text-[12px] font-medium px-3 py-1.5 hover:bg-gray-50">
            Discard
          </button>
        </div>
      )}
    </div>
  );
};
