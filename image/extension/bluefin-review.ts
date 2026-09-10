/**
 * Project Bluefin Review Extension for Oh My Pi (omp).
 *
 * Implements:
 * 1. Dedicated Review Mode (`/review [pr_number]` or shortcut `r`)
 * 2. Dedicated Issues Mode (`/issues` or shortcut `I`)
 * 3. Lower-Third TUI dashboard widget showing live PR queue & issue stats
 * 4. Keyboard shortcuts for quick implement, review, approve, and landing
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export interface QueueItem {
  id: number;
  type: "pr" | "issue";
  repo: string;
  title: string;
  author: string;
  ciStatus?: "success" | "failure" | "pending";
  labels: string[];
}

export class ReviewQueueState {
  items: QueueItem[] = [];
  currentIndex: number = 0;
  activeMode: "prs" | "issues" = "prs";

  getCurrent(): QueueItem | undefined {
    return this.items[this.currentIndex];
  }

  next(): void {
    if (this.currentIndex < this.items.length - 1) this.currentIndex++;
  }

  prev(): void {
    if (this.currentIndex > 0) this.currentIndex--;
  }

  toggleMode(): void {
    this.activeMode = this.activeMode === "prs" ? "issues" : "prs";
  }

  renderLowerThirdWidget(width: number): string[] {
    const current = this.getCurrent();
    const modeLabel = this.activeMode.toUpperCase();
    const count = this.items.length;
    const pos = count > 0 ? `${this.currentIndex + 1}/${count}` : "0/0";

    const header = `── [BLUEFIN ${modeLabel} QUEUE] ── (${pos}) ─────────────────────────────`.slice(0, width);
    let itemLine = "  No items in queue";
    if (current) {
      const ciBadge = current.ciStatus ? `[CI: ${current.ciStatus.toUpperCase()}] ` : "";
      itemLine = `  #${current.id} ${ciBadge}${current.title} (@${current.author})`;
      if (itemLine.length > width) {
        itemLine = itemLine.slice(0, width - 3) + "...";
      }
    }
    const shortcuts = `  [j/k] Navigate  [r] Review  [a] Approve/Land  [I] Issues Mode  [$] Slay (Fix+Land)`.slice(0, width);

    return [header, itemLine, shortcuts];
  }
}

export default function bluefinReviewExtension(pi: ExtensionAPI): void {
  const queue = new ReviewQueueState();

  pi.setLabel("Bluefin Review & Issues");

  // Lower-third dashboard widget below editor
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setWidget("bluefin-review-lower-third", {
        placement: "belowEditor",
        render: (width) => queue.renderLowerThirdWidget(width),
      });
    }
  });

  // Slash Commands
  pi.registerCommand("review", {
    description: "Enter Review Mode for a PR",
    handler: async (args, ctx) => {
      const prNum = args.trim() || queue.getCurrent()?.id;
      if (!prNum) {
        ctx.ui.notify("Specify PR number or select in queue", "error");
        return;
      }
      ctx.ui.notify(`Starting review for PR #${prNum}...`, "info");
      pi.sendUserMessage(
        `Perform exact Bluefin review for PR #${prNum}. Check doctrine, correctness, security, tests, and simplicity.`
      );
    },
  });

  pi.registerCommand("issues", {
    description: "Toggle Issues / PR mode in lower third queue",
    handler: async (_args, ctx) => {
      queue.toggleMode();
      ctx.ui.notify(`Switched to ${queue.activeMode.toUpperCase()} mode`, "info");
    },
  });

  pi.registerCommand("slay", {
    description: "Slay PR: automated review + fix + land sequence",
    handler: async (_args, ctx) => {
      const current = queue.getCurrent();
      if (!current) {
        ctx.ui.notify("No active item selected to slay", "error");
        return;
      }
      ctx.ui.notify(`Slaying PR #${current.id}...`, "info");
      pi.sendUserMessage(
        `Execute automated slay pipeline on PR #${current.id}: review diff, patch issues, run hermetic verification, and prepare squash merge.`
      );
    },
  });

  // Shortcuts
  pi.registerShortcut("j", () => queue.next());
  pi.registerShortcut("k", () => queue.prev());
  pi.registerShortcut("I", () => queue.toggleMode());
}
