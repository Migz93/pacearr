import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { ChevronRight } from "lucide-react";

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
  return (
    <div>
      <label className="mb-1.5 mt-0 block text-[13px] font-bold text-on-surface" htmlFor={id}>{label}</label>
      {hint && <p className="mb-2 text-xs leading-relaxed text-on-surface-variant">{hint}</p>}
      {children}
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
      className={`w-full rounded-lg border border-outline-variant/30 bg-background px-3 py-2.5 text-on-surface ${className}`}
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
      className={`w-full rounded-lg border border-outline-variant/30 bg-background px-3 py-2.5 text-on-surface ${className}`}
    >
      {children}
    </select>
  );
}

export function ToggleField({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input className="sr-only" type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className={`relative mt-0.5 h-6 w-[42px] shrink-0 rounded-full transition-colors ${checked ? "bg-primary-dim" : "bg-background-container-highest"}`}><span className={`absolute top-[3px] left-[3px] size-[18px] rounded-full bg-on-surface transition-transform ${checked ? "translate-x-[18px]" : ""}`} /></span>
      <span>
        <strong className="block text-sm text-on-surface">{label}</strong>
        {hint && <small className="mt-0.5 block text-xs leading-relaxed text-on-surface-variant">{hint}</small>}
      </span>
    </label>
  );
}

export function SaveBar({ saving, success, error, label, onSave }: { saving: boolean; success: boolean; error: string | null; label: string; onSave: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border-t border-outline-variant/30 pt-4 max-[820px]:flex-col max-[820px]:items-stretch">
      <div>{success && <span className="text-[13px] font-bold text-success">Saved</span>}{error && <span className="text-[13px] font-bold text-error">{error}</span>}</div>
      <button className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-transparent bg-primary-dim px-3.5 text-on-surface" disabled={saving} onClick={onSave}>
        {saving ? "Saving..." : label}
        {!saving && <ChevronRight size={15} />}
      </button>
    </div>
  );
}
