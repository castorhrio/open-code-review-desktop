import { useEffect, useRef, useState } from "react";
import { ChevronRight, ClipboardCopy, Eraser } from "lucide-react";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/layout";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";

export function LogDrawer() {
  const { log, running, clearLog } = useStore();
  const [open, setOpen] = useState(false);
  const revealed = useRef(false);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (running) revealed.current = false;
  }, [running]);

  useEffect(() => {
    // The running screen carries the live feed now, so the drawer no longer has
    // to open itself for the app to look alive — and while it did, it took 170px
    // away from that feed on every single run. It still opens on its own for
    // output that looks like trouble, which is the one thing the feed truncates.
    if (log.length && !revealed.current && /error|warning|失败|无法|✗/i.test(log[log.length - 1])) {
      revealed.current = true;
      setOpen(true);
    }
    if (open && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [log, open]);

  return (
    <section className="shrink-0 border-t border-line bg-surface">
      <div className="flex h-8 items-center gap-2 px-4">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 text-meta text-muted transition-colors hover:text-ink"
        >
          <ChevronRight className={cn("size-3.5 transition-transform duration-150", open && "rotate-90")} />
          运行日志
          <span className="tnum text-faint">{log.length}</span>
        </button>
        {log.length > 0 && (
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => void copyText(log.join("\n"), ` ${log.length} 行运行日志`)}>
              <ClipboardCopy />
              复制全部
            </Button>
            <Button variant="ghost" size="sm" onClick={clearLog}>
              <Eraser />
              清空
            </Button>
          </div>
        )}
      </div>
      {open && (
        <ScrollArea
          grow={false}
          tone="canvas"
          className="max-h-40 border-t border-line bg-canvas"
          bodyClassName="px-4 py-2"
          scrollerRef={body}
        >
          <pre className="font-mono text-meta text-muted selectable">{log.length ? log.join("\n") : "（暂无输出）"}</pre>
        </ScrollArea>
      )}
    </section>
  );
}
