import { useEffect, useRef, useState } from "react";
import { ChevronRight, Eraser } from "lucide-react";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export function LogDrawer() {
  const { log, running, clearLog } = useStore();
  const [open, setOpen] = useState(false);
  const revealed = useRef(false);
  const body = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (running) revealed.current = false;
  }, [running]);

  useEffect(() => {
    if (log.length && !revealed.current) {
      revealed.current = true;
      setOpen(true);
    }
    if (open && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [log, open]);

  return (
    <section className="shrink-0 border-t border-line bg-surface">
      <div className="flex h-8 items-center gap-2 px-3">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 text-[11.5px] text-muted transition-colors hover:text-ink"
        >
          <ChevronRight className={cn("size-3.5 transition-transform duration-150", open && "rotate-90")} />
          运行日志
          <span className="tnum text-faint">{log.length}</span>
        </button>
        {log.length > 0 && (
          <Button variant="ghost" size="sm" className="ml-auto h-6" onClick={clearLog}>
            <Eraser className="size-3" />
            清空
          </Button>
        )}
      </div>
      {open && (
        <pre
          ref={body}
          className="max-h-40 overflow-auto border-t border-line bg-canvas px-3 py-2 font-mono text-[11px] leading-relaxed text-muted selectable"
        >
          {log.length ? log.join("\n") : "（暂无输出）"}
        </pre>
      )}
    </section>
  );
}
