import type { ReactNode } from "react";
import { cn } from "../lib/utils";

// Every route renders inside this container. The width and padding are the only
// approved values — a page that sets its own `max-w-*` makes the sidebar-to-content
// gutter jump as you move between tabs, which is what this component exists to stop.
export function Page({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("mx-auto max-w-7xl p-6", className)}>{children}</div>;
}

// Title row for a route. `badge` sits beside the title (page-level state, e.g. dry run);
// `children` are the page's actions and align to the right.
export function PageHeader({ title, badge, children }: { title: string; badge?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-6 flex items-center justify-between gap-4 max-[820px]:flex-col max-[820px]:items-stretch">
      <div className="flex items-center gap-2.5">
        <h1 className="font-headline text-2xl font-bold text-on-surface">{title}</h1>
        {badge}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2 max-[820px]:justify-start">{children}</div>}
    </div>
  );
}

export function PageLoading({ label }: { label: string }) {
  return <div className="grid min-h-[220px] place-items-center text-on-surface-variant">{label}</div>;
}

export function ErrorBanner({ message, className }: { message: string; className?: string }) {
  return <div className={cn("mb-4 rounded-lg border border-error/35 bg-error/12 px-3.5 py-3 text-error", className)} role="alert">{message}</div>;
}
