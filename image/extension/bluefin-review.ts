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

interface GraphQlSearchNode {
  number: number;
  title: string;
  author?: { login: string };
  repository?: { nameWithOwner: string };
  commits?: {
    nodes?: Array<{
      commit?: {
        statusCheckRollup?: { state: string };
      };
    }>;
  };
  labels?: { nodes?: Array<{ name: string }> };
}

interface GraphQlSearchPayload {
  data?: {
    search?: {
      nodes?: GraphQlSearchNode[];
    };
  };
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

  setItems(newItems: QueueItem[]): void {
    this.items = newItems;
    if (this.currentIndex >= this.items.length) {
      this.currentIndex = Math.max(0, this.items.length - 1);
    }
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

export const GITHUB_ORG = "projectbluefin";

export const ORG_QUEUE_QUERY = `
query($endCursor: String) {
  search(query: "org:projectbluefin is:pr is:open archived:false", type: ISSUE, first: 100, after: $endCursor) {
    nodes {
      ... on PullRequest {
        number
        title
        author { login }
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        labels(first: 20) { nodes { name } }
      }
    }
  }
}
`;

export const ORG_ISSUES_QUERY = `
query($endCursor: String) {
  search(query: "org:projectbluefin is:issue is:open archived:false", type: ISSUE, first: 100, after: $endCursor) {
    nodes {
      ... on Issue {
        number
        title
        author { login }
        repository { nameWithOwner }
        labels(first: 20) { nodes { name } }
      }
    }
  }
}
`;

export async function fetchLiveQueue(mode: "prs" | "issues", token?: string): Promise<QueueItem[]> {
  const query = mode === "prs" ? ORG_QUEUE_QUERY : ORG_ISSUES_QUERY;
  const headers: Record<string, string> = {
    "User-Agent": "Bluefin-Review-OMP",
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  try {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
    });
    if (!res.ok) return [];
    const payload = (await res.json()) as GraphQlSearchPayload;
    const nodes = payload.data?.search?.nodes ?? [];

    return nodes.map((node) => {
      const ciState = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state?.toLowerCase();
      let ciStatus: "success" | "failure" | "pending" | undefined;
      if (ciState === "success") ciStatus = "success";
      else if (ciState === "failure" || ciState === "error") ciStatus = "failure";
      else if (ciState) ciStatus = "pending";

      return {
        id: node.number,
        type: mode === "prs" ? "pr" : "issue",
        repo: node.repository?.nameWithOwner ?? GITHUB_ORG,
        title: node.title,
        author: node.author?.login ?? "unknown",
        ciStatus,
        labels: (node.labels?.nodes ?? []).map((l) => l.name),
      };
    });
  } catch {
    return [];
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

      // Background refresh queue
      const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
      fetchLiveQueue(queue.activeMode, token).then((items) => {
        if (items.length > 0) queue.setItems(items);
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
      const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
      fetchLiveQueue(queue.activeMode, token).then((items) => {
        queue.setItems(items);
      });
      ctx.ui.notify(`Switched to ${queue.activeMode.toUpperCase()} mode`, "info");
    },
  });
  pi.registerCommand("approve", {
    description: "Approve the selected PR after evidence verification",
    handler: async (args, ctx) => {
      const prNum = args.trim() || queue.getCurrent()?.id;
      if (!prNum) {
        ctx.ui.notify("No PR selected to approve", "error");
        return;
      }
      ctx.ui.notify(`Approving PR #${prNum}...`, "info");
      pi.sendUserMessage(
        `Verify all checks and approve PR #${prNum} using gh pr review ${prNum} --approve.`
      );
    },
  });

  pi.registerCommand("diff", {
    description: "Inspect diff for the selected PR",
    handler: async (args, ctx) => {
      const prNum = args.trim() || queue.getCurrent()?.id;
      if (!prNum) {
        ctx.ui.notify("No PR selected", "error");
        return;
      }
      pi.sendUserMessage(`Show bounded git diff for PR #${prNum}.`);
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

  pi.registerCommand("landing-batch", {
    description: "Inspect or queue multi-PR landing batches",
    handler: async (_args, ctx) => {
      const prs = queue.items.filter((i) => i.type === "pr");
      if (prs.length === 0) {
        ctx.ui.notify("No PRs in queue to batch", "info");
        return;
      }
      const batchSummary = prs.slice(0, 5).map((p) => `#${p.id}`).join(", ");
      ctx.ui.notify(`Landing batch candidate: ${batchSummary}`, "info");
      pi.sendUserMessage(
        `Examine landing batch candidate for PRs: ${batchSummary}. Verify CI status and build exact BatchActionPlan.`
      );
    },
  });

  pi.registerCommand("tui-evidence", {
    description: "Capture and report current TUI evidence manifest",
    handler: async (_args, ctx) => {
      const current = queue.getCurrent();
      const itemDetails = current
        ? `Item #${current.id} (${current.type}) in repo ${current.repo}`
        : "No active queue item";
      ctx.ui.notify(`TUI Evidence captured: ${itemDetails}`, "info");
    },
  });

  // Shortcuts
  pi.registerShortcut("j", () => queue.next());
  pi.registerShortcut("k", () => queue.prev());
  pi.registerShortcut("I", () => queue.toggleMode());
  pi.registerShortcut("a", () => {
    const current = queue.getCurrent();
    if (current && current.type === "pr") {
      pi.sendUserMessage(`Approve and queue PR #${current.id} for landing.`);
    }
  });
  pi.registerShortcut("r", () => {
    const current = queue.getCurrent();
    if (current && current.type === "pr") {
      pi.sendUserMessage(`Start exact review for PR #${current.id}.`);
    }
  });
}
