import { Children, cloneElement, isValidElement, useId, type InputHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes } from "react";
import { cn } from "../lib/utils";

export const primaryButtonClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-transparent bg-primary-dim px-3.5 text-on-surface transition-colors hover:bg-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-primary-dim";
export const secondaryButtonClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-outline-variant/30 bg-background-container-high px-3.5 text-on-surface transition-colors hover:bg-background-bright disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-background-container-high";
export const compactPrimaryButtonClass = "inline-flex min-h-8 items-center justify-center gap-2 rounded-lg border border-transparent bg-primary-dim px-2.5 text-xs text-on-surface transition-colors hover:bg-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-primary-dim";
export const compactSecondaryButtonClass = "inline-flex min-h-8 items-center justify-center gap-2 rounded-lg border border-outline-variant/30 bg-background-container-high px-2.5 text-xs text-on-surface transition-colors hover:bg-background-bright disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-background-container-high";
/** For per-row actions repeated down a list, where a filled button would outweigh the row's data. */
export const compactGhostButtonClass = "inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg border border-transparent bg-transparent px-2 text-xs font-medium text-on-surface-variant transition-colors hover:bg-background-bright hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-on-surface-variant";
export const dangerButtonClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-outline-variant/30 bg-background-container-high px-3.5 text-error transition-colors hover:bg-background-bright disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-background-container-high";
export const iconButtonClass = "inline-flex size-10 items-center justify-center rounded-lg border border-outline-variant/30 bg-background-container-high text-on-surface transition-colors hover:bg-background-bright disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-background-container-high";

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
// knob visually crowding the track edge. Renders the input and its track as siblings so
// the track can follow the input's focus through `peer`.
function Switch({ checked, onChange, labelledBy, describedBy }: { checked: boolean; onChange: (value: boolean) => void; labelledBy?: string; describedBy?: string }) {
  return (
    <>
      <input className="peer sr-only" type="checkbox" checked={checked} aria-labelledby={labelledBy} aria-describedby={describedBy} onChange={(event) => onChange(event.target.checked)} />
      <span className={`relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary ${checked ? "bg-primary-dim" : "bg-outline-variant"}`}>
        <span className={`absolute top-1 size-4 rounded-full transition-all ${checked ? "translate-x-5 bg-on-surface" : "translate-x-1 bg-on-surface-variant"}`} />
      </span>
    </>
  );
}

/** A switch with its label beside it, for filters and dialogs. Settings pages use SettingToggle. */
export function ToggleField({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <Switch checked={checked} onChange={onChange} />
      <span>
        <strong className="block text-sm font-medium text-on-surface">{label}</strong>
        {hint && <small className="mt-0.5 block text-xs leading-relaxed text-on-surface-variant">{hint}</small>}
      </span>
    </label>
  );
}

const settingLabelClass = "block text-sm font-medium text-on-surface";
// About 65 characters, so a hint wraps into a readable line rather than running the
// full width of a desktop card.
const settingHintClass = "mt-0.5 block max-w-[65ch] text-xs leading-relaxed text-on-surface-variant";
// The control sits at the far edge of a wide desktop card, so the hover band ties it
// to its label. The negative margins let the band bleed past the row without changing
// its spacing.
const settingRowClass = "-mx-3 -my-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2 rounded-lg px-3 py-2 transition-colors hover:bg-background-container-high has-[:disabled]:hover:bg-transparent";

/**
 * The layout every settings row shares: label and hint on the left, the control on the
 * right, so the left edge and the rhythm stay the same whatever the control is. Wide
 * controls (text inputs) drop under the label from tablet width down; compact ones (a
 * number box) only on a phone.
 */
function SettingRowFrame({ label, hint, controlId, hintId, wide, children }: {
  label: string;
  hint?: ReactNode;
  /** Omitted for an action row, whose button names itself and can't take a <label>. */
  controlId?: string;
  hintId?: string;
  wide: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn(settingRowClass, wide ? "max-[820px]:grid-cols-1" : "max-[480px]:grid-cols-1")}>
      <div>
        {controlId ? <label className={settingLabelClass} htmlFor={controlId}>{label}</label> : <span className={settingLabelClass}>{label}</span>}
        {hint && <p id={hintId} className={settingHintClass}>{hint}</p>}
      </div>
      <div className={cn(wide && "w-80 max-w-full max-[820px]:w-full")}>{children}</div>
    </div>
  );
}

/**
 * A settings row around a single control, which gets the label's id and the hint's
 * aria-describedby. When the control sits inside a wrapper (a select with a button
 * beside it), pass `htmlFor` instead: the child is left alone, and the control should
 * take `${htmlFor}-hint` as its aria-describedby. For a button that runs an action,
 * pass `action`: the label is plain text, since a button can't be labelled, and the
 * button keeps its own name but still gets the hint as its description.
 */
export function SettingRow({ label, hint, wide = false, htmlFor, action = false, children }: {
  label: string;
  hint?: ReactNode;
  wide?: boolean;
  htmlFor?: string;
  action?: boolean;
  children: ReactNode;
}) {
  const generatedId = useId();
  const child = Children.only(children);
  const childId = isValidElement(child) ? (child.props as { id?: string }).id : undefined;
  const controlId = htmlFor ?? childId ?? generatedId;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const control = !htmlFor && isValidElement(child)
    ? cloneElement(child as ReactElement<{ id?: string; "aria-describedby"?: string }>, action ? { "aria-describedby": hintId } : { id: controlId, "aria-describedby": hintId })
    : child;
  return <SettingRowFrame label={label} hint={hint} controlId={action ? undefined : controlId} hintId={hintId} wide={wide}>{control}</SettingRowFrame>;
}

/**
 * A toggle setting. The whole row is the label, so clicking the text flips the switch;
 * the switch keeps to the right even on a phone, where it's small enough not to crowd.
 */
export function SettingToggle({ label, hint, checked, onChange }: { label: string; hint?: ReactNode; checked: boolean; onChange: (value: boolean) => void }) {
  const id = useId();
  const labelId = `${id}-label`;
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <label className={cn(settingRowClass, "cursor-pointer has-[:disabled]:cursor-not-allowed")}>
      <span>
        <span id={labelId} className={settingLabelClass}>{label}</span>
        {hint && <span id={hintId} className={settingHintClass}>{hint}</span>}
      </span>
      <span className="flex">
        <Switch checked={checked} onChange={onChange} labelledBy={labelId} describedBy={hintId} />
      </span>
    </label>
  );
}

/**
 * A compact number box with its unit inside it, rather than "(days)" tacked onto the
 * label. Doesn't reuse SettingRow: that clones its single child to attach the id, which
 * would put the label's htmlFor on the flex wrapper instead of the input.
 */
export function SettingNumber({ label, hint, unit, value, onChange, min = 0, step = 1, id }: {
  label: string;
  hint?: ReactNode;
  unit?: string;
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
    <SettingRowFrame label={label} hint={hint} controlId={inputId} hintId={hintId} wide={false}>
      {/* The unit sits inside the box, so every box is the same width and shares the
          toggles' right edge, whatever the unit's length. */}
      <div className="flex w-44 items-center overflow-hidden rounded-lg border border-outline-variant/30 bg-background focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary">
        <input id={inputId} aria-describedby={hintId} className="w-full min-w-0 border-0 bg-transparent px-3 py-2 text-on-surface focus:outline-none" type="number" min={min} step={step} value={String(value)} onChange={(event) => onChange(event.target.value)} />
        {unit && <span className="shrink-0 pr-3 text-sm text-on-surface-variant">{unit}</span>}
      </div>
    </SettingRowFrame>
  );
}

/**
 * Options that only mean something while a parent toggle is on. They sit under the
 * parent behind a left rule, and are disabled rather than hidden while it is off, so
 * the page doesn't jump about and you can see what turning it on would add.
 */
export function DependentSettings({ enabled, label, children }: { enabled: boolean; label: string; children: ReactNode }) {
  return (
    <fieldset disabled={!enabled} aria-label={label} className={cn("-mt-2 grid min-w-0 gap-5 border-l-2 border-outline-variant/30 pl-4 transition-opacity", !enabled && "opacity-50")}>
      {children}
    </fieldset>
  );
}

export interface TestConnectionState {
  testing: boolean;
  disabled: boolean;
  result: { ok: boolean; message: string } | null;
  onTest: () => void;
}

/** The last row of an integration's connection card. It tests the values as entered, saved or not. */
export function TestConnection({ testing, disabled, result, onTest }: TestConnectionState) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-outline-variant/30 pt-4">
      <button type="button" className={secondaryButtonClass} disabled={testing || disabled} onClick={onTest}>
        {testing ? "Testing..." : "Test connection"}
      </button>
      <span aria-live="polite">{result && <span className={`text-[13px] font-bold ${result.ok ? "text-success" : "text-error"}`}>{result.message}</span>}</span>
    </div>
  );
}

/**
 * The one save model for every settings tab: edits stay local until saved, and this bar
 * pins to the bottom of the viewport once something has changed, so the save is never a
 * scroll away and it's clear there is something unsaved. After a save it stays just
 * long enough to confirm it; an error stays until the next save, or until the
 * form is back at its saved values.
 */
export function UnsavedChangesBar({ dirty, saving, success, error, onSave, onDiscard, saveDisabled = false }: {
  dirty: boolean;
  saving: boolean;
  success: boolean;
  error: string | null;
  onSave: () => void;
  onDiscard: () => void;
  saveDisabled?: boolean;
}) {
  const visible = dirty || saving || success || error !== null;
  return (
    <div className={cn("sticky bottom-4 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-outline-variant/30 bg-background-container-highest px-4 py-3 shadow-2xl max-[480px]:flex-col max-[480px]:items-stretch", !visible && "hidden")}>
      <span aria-live="polite" className="text-[13px] font-bold">
        {error ? <span className="text-error">{error}</span>
          : saving ? <span className="text-on-surface">Saving...</span>
            : dirty ? <span className="text-on-surface">You have unsaved changes</span>
              : success ? <span className="text-success">Saved</span>
                : null}
      </span>
      <div className="flex flex-wrap items-center gap-2 max-[480px]:justify-end">
        <button type="button" className={secondaryButtonClass} disabled={saving || !dirty} onClick={onDiscard}>Discard</button>
        <button type="button" className={primaryButtonClass} disabled={saving || !dirty || saveDisabled} aria-busy={saving} onClick={onSave}>
          {saving ? "Saving..." : "Save changes"}
        </button>
      </div>
    </div>
  );
}
