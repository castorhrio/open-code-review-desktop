import { useEffect } from "react";
import { Toaster } from "sonner";
import { api } from "@/lib/api";
import { useStore } from "@/store";
import { NavRail } from "@/components/NavRail";
import { TopBar } from "@/components/TopBar";
import { LogDrawer } from "@/components/LogDrawer";
import { ReviewPanel } from "@/components/ReviewPanel";
import { ResultsPanel } from "@/components/ResultsPanel";
import { HistoryPanel } from "@/components/HistoryPanel";
import { SettingsPanel } from "@/components/SettingsPanel";

export function App() {
  const { view, pickRepo, refreshHistory } = useStore();

  useEffect(() => api.onMenuOpenRepo(() => void pickRepo()), [pickRepo]);
  useEffect(() => {
    if (view === "history") void refreshHistory();
  }, [view, refreshHistory]);

  return (
    <div className="flex h-full overflow-hidden">
      <NavRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="min-h-0 flex-1 overflow-hidden bg-canvas">
          {view === "review" && <ReviewPanel />}
          {view === "results" && <ResultsPanel />}
          {view === "history" && <HistoryPanel />}
          {view === "settings" && <SettingsPanel />}
        </main>
        <LogDrawer />
      </div>
      <Toaster
        theme="system"
        position="bottom-center"
        closeButton
        toastOptions={{
          style: { background: "var(--surface)", border: "1px solid var(--line)", color: "var(--ink)", fontSize: "12.5px" } as React.CSSProperties,
        }}
      />
    </div>
  );
}
