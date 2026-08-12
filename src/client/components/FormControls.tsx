import { Children, cloneElement, isValidElement, useId, type InputHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";

export const primaryButtonClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-transparent bg-primary-dim px-3.5 text-on-surface transition-colors hover:bg-primary";
export const secondaryButtonClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-outline-variant/30 bg-background-container-high px-3.5 text-on-surface";
export const compactPrimaryButtonClass = "inline-flex min-h-8 items-center justify-center gap-2 rounded-lg border border-transparent bg-primary-dim px-2.5 text-xs text-on-surface";
export const compactSecondaryButtonClass = "inline-flex min-h-8 items-center justify-center gap-2 rounded-lg border border-outline-variant/30 bg-background-container-high px-2.5 text-xs text-on-surface";
export const dangerButtonClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-outline-variant/30 bg-background-container-high px-3.5 text-error";

export function SectionCard({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-outline-variant/30 bg-background-container p-5">
      <div className="mb-5">
        <h2 className="font-headline mb-1 text-lg font-semibold">{title}</h2>
        {description && <p className="text-on-surface-variant">{description}</p>}
      </div>
      <div className="grid gap-5">{children}</div>
    </section>
  );
}

export function Field({ label, hint, id, children }: { label: string; hint?: string; id?: string; children: ReactNode }) {
  const generatedId = useId();
  const child = Children.only(children);
  const childId = isValidElement(child) ? (child.props as { id?: string }).id : undefined;
  const resolvedId = id ?? childId ?? generatedId;
  const hintId = hint ? `${resolvedId}-hint` : undefined;
  const existingDescribedBy = isValidElement(child) ? (child.props as { "aria-describedby"?: string })["aria-describedby"] : undefined;
  const describedBy = [existingDescribedBy, hintId].filter(Boolean).join(" ") || undefined;
  const childWithId = isValidElement(child)
    ? cloneElement(child as ReactElement<{ id?: string; "aria-describedby"?: string }>, { id: resolvedId, "aria-describedby": describedBy })
    : child;
  return (
    <div>
      <label className="mb-1.5 mt-0 block text-[13px] font-bold text-on-surface" htmlFor={resolvedId}>{label}</label>
      {hint && <p id={hintId} className="mb-2 text-xs leading-relaxed text-on-surface-variant">{hint}</p>}
      {childWithId}
    </div>
  );
}

type TextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
};

export function TextInput({ value, onChange, className = "", ...rest }: TextInputProps) {
  return (
    <input
      {...rest}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn("w-full rounded-lg border border-outline-variant/30 bg-background px-3 py-2.5 text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary", className)}
    />
  );
}

type SelectInputProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange"> & {
  value: string | number;
  onChange: (value: string) => void;
  children: ReactNode;
};

export function SelectInput({ value, onChange, className = "", children, ...rest }: SelectInputProps) {
  return (
    <select
      {...rest}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn("w-full rounded-lg border border-outline-variant/30 bg-background px-3 py-2.5 text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary", className)}
    >
      {children}
    </select>
  );
}

// Geometry matches hubarr's toggle exactly: a 40x24 borderless track with a 16px knob
// inset by 4px. The previous version added a border and used an 18px knob, which left the
// knob visually crowding the track edge.
export function ToggleField({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input className="peer sr-only" type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className={`relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary ${checked ? "bg-primary-dim" : "bg-outline-variant"}`}>
        <span className={`absolute top-1 size-4 rounded-full transition-all ${checked ? "translate-x-5 bg-on-surface" : "translate-x-1 bg-on-surface-variant"}`} />
      </span>
      <span>
        <strong className="block text-sm font-medium text-on-surface">{label}</strong>
        {hint && <small className="mt-0.5 block text-xs leading-relaxed text-on-surface-variant">{hint}</small>}
      </span>
    </label>
  );
}

/**
 * A number input with its unit beside it, rather than "(days)" tacked onto the label.
 * Doesn't reuse Field: Field clones its single child to attach the id, which would put
 * the label's htmlFor on the flex wrapper instead of the input.
 */
export function NumberField({ label, hint, unit, value, onChange, min = 0, step = 1, id }: {
  label: string;
  hint?: string;
  unit: string;
  value: number | string;
  onChange: (value: string) => void;
  min?: number;
  step?: number;
  id?: string;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  return (
    <div>
      <label className="mb-1.5 mt-0 block text-[13px] font-bold text-on-surface" htmlFor={inputId}>{label}</label>
      {hint && <p id={hintId} className="mb-2 text-xs leading-relaxed text-on-surface-variant">{hint}</p>}
      <div className="flex items-center gap-2">
        <TextInput id={inputId} aria-describedby={hintId} className="w-28" type="number" min={min} step={step} value={String(value)} onChange={onChange} />
        <span className="text-sm text-on-surface-variant">{unit}</span>
      </div>
    </div>
  );
}

export interface TestConnectionState {
  testing: boolean;
  disabled: boolean;
  result: { ok: boolean; message: string } | null;
  onTest: () => void;
}

/**
 * The footer for every settings form. The three integration tabs used to hand-roll this
 * markup and had drifted apart (only one of them had a chevron on its save button), so
 * the optional connection test lives here too rather than in each tab.
 */
export function SaveBar({ saving, success, error, label, onSave, test, saveDisabled = false, divider = true }: {
  saving: boolean;
  success: boolean;
  error: string | null;
  label: string;
  onSave: () => void;
  test?: TestConnectionState;
  saveDisabled?: boolean;
  /** Off when the bar is its own card rather than the last row inside one. */
  divider?: boolean;
}) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-4 max-[820px]:flex-col max-[820px]:items-stretch", divider && "border-t border-outline-variant/30 pt-4")}>
      <div className="flex flex-wrap items-center gap-2">
        {test && (
          <>
            <button type="button" className={secondaryButtonClass} disabled={test.testing || test.disabled} onClick={test.onTest}>
              {test.testing ? "Testing..." : "Test connection"}
            </button>
            <span aria-live="polite">{test.result && <span className={`text-[13px] font-bold ${test.result.ok ? "text-success" : "text-error"}`}>{test.result.message}</span>}</span>
          </>
        )}
        <span aria-live="polite">{success && <span className="text-[13px] font-bold text-success">Saved</span>}{error && <span className="text-[13px] font-bold text-error">{error}</span>}</span>
      </div>
      <button type="button" className={primaryButtonClass} disabled={saving || saveDisabled} aria-busy={saving} onClick={onSave}>
        {saving ? "Saving..." : label}
        {!saving && <ChevronRight size={15} />}
      </button>
    </div>
  );
}
