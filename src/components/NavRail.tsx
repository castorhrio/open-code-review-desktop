import { History, Moon, ScanSearch, Settings, Sun, MonitorSmartphone, Inbox } from "lucide-react";
import { useStore, type View } from "@/store";
import { Tooltip } from "@/components/ui/overlay";
import { cn } from "@/lib/cn";
import { readPref, savePref, applyPref, watchSystem, type ThemePref } from "@/lib/theme";
import { useEffect, useState } from "react";

const ITEMS: { view: View; label: string; icon: typeof ScanSearch }[] = [
  { view: "review", label: "审查", icon: ScanSearch },
  { view: "results", label: "结果", icon: Inbox },
  { view: "history", label: "历史", icon: History },
  { view: "settings", label: "设置", icon: Settings },
];

const CYCLE: ThemePref[] = ["system", "dark", "light"];
const THEME_LABEL: Record<ThemePref, string> = { system: "跟随系统", dark: "深色", light: "浅色" };
const THEME_ICON = { system: MonitorSmartphone, dark: Moon, light: Sun };

export function NavRail() {
  const { view, setView, comments, running } = useStore();
  const [pref, setPref] = useState<ThemePref>(() => readPref());

  useEffect(() => {
    applyPref(pref);
    return watchSystem(() => applyPref(readPref()));
  }, [pref]);

  const Icon = THEME_ICON[pref];

  return (
    <nav className="flex w-14 shrink-0 flex-col items-center border-r border-line bg-rail py-2">
      <div className="mb-2 flex size-8 items-center justify-center">
        <span className="size-2.5 rounded-full bg-accent shadow-[0_0_12px_2px_var(--accent-soft)]" />
        <span className="sr-only">Open Code Review</span>
      </div>

      <div className="flex flex-col items-center gap-1">
        {ITEMS.map(({ view: v, label, icon: ItemIcon }) => {
          const active = view === v;
          return (
            <Tooltip key={v} content={label}>
              <button
                onClick={() => setView(v)}
                aria-label={label}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex size-9 items-center justify-center rounded-md transition-colors duration-150",
                  active ? "bg-accent-soft text-accent" : "text-faint hover:bg-hover hover:text-ink"
                )}
              >
                <ItemIcon className="size-[17px]" strokeWidth={active ? 2.2 : 1.9} />
                {v === "review" && running && (
                  <span className="absolute right-1 top-1 size-1.5 animate-pulse rounded-full bg-accent" />
                )}
                {v === "results" && comments.length > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 min-w-[16px] rounded-full bg-accent-solid px-1 text-center text-meta font-semibold leading-4 text-accent-ink tnum">
                    {comments.length > 99 ? "99+" : comments.length}
                  </span>
                )}
              </button>
            </Tooltip>
          );
        })}
      </div>

      <div className="mt-auto flex flex-col items-center gap-1">
        <Tooltip content={`主题：${THEME_LABEL[pref]}（点击切换）`}>
          <button
            onClick={() => {
              const next = CYCLE[(CYCLE.indexOf(pref) + 1) % CYCLE.length];
              setPref(next);
              savePref(next);
            }}
            aria-label="切换主题"
            className="flex size-9 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-ink"
          >
            <Icon className="size-[17px]" />
          </button>
        </Tooltip>
      </div>
    </nav>
  );
}
