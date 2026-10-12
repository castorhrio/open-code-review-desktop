import { useEffect } from "react";
import { Toaster } from "sonner";
import { api } from "@/lib/api";
import { useResolvedTheme } from "@/lib/theme";
import { useStore } from "@/store";
import { NavRail } from "@/components/NavRail";
import { TopBar } from "@/components/TopBar";
import { LogDrawer } from "@/components/LogDrawer";
import { ReviewPanel } from "@/components/ReviewPanel";
import { UpdateBanner } from "@/components/UpdateBanner";
import { ResultsPanel } from "@/components/ResultsPanel";
import { ReportView } from "@/components/ReportView";
import { HistoryPanel } from "@/components/HistoryPanel";
import { SettingsPanel } from "@/components/SettingsPanel";

export function App() {
  const { view, pickRepo, refreshHistory } = useStore();
  const theme = useResolvedTheme();

  useEffect(() => api.onMenuOpenRepo(() => void pickRepo()), [pickRepo]);
  useEffect(() => {
    if (view === "history") void refreshHistory();
  }, [view, refreshHistory]);

  return (
    <div className="flex h-full overflow-hidden">
      <NavRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <UpdateBanner />
        <main className="min-h-0 flex-1 overflow-hidden bg-canvas">
          {view === "review" && <ReviewPanel />}
          {view === "results" && <ResultsPanel />}
          {view === "report" && <ReportView />}
          {view === "history" && <HistoryPanel />}
          {view === "settings" && <SettingsPanel />}
        </main>
        <LogDrawer />
      </div>
      <Toaster
        theme={theme}
        position="bottom-center"
        closeButton
        toastOptions={{
          // Toasts are this app's only failure surface — CLI errors, rejected
          // refs, "cannot open <path>" — and `body` sets `user-select: none`,
          // so without this the one piece of text a user needs to copy (to
          // paste into an issue, or to search for) is the one they cannot.
          className: "selectable",
          style: { background: "var(--surface)", border: "1px solid var(--line)", color: "var(--ink)", fontSize: "12.5px" } as React.CSSProperties,
        }}
      />
    </div>
  );
}
