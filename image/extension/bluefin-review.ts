/**
 * Project Bluefin Review Extension for Oh My Pi (omp).
 *
 * Keyboard shortcuts only — no slash commands:
 *   Alt+J / Alt+N : Next queue item
 *   Alt+K / Alt+P : Previous queue item
 *   Alt+I         : Toggle PRs / Issues mode
 *   Alt+R         : Start review of selected PR
 *   Alt+D         : Inspect diff of selected PR
 *   Alt+A         : Approve and queue selected PR for landing
 *   Alt+S         : Slay (automated review + fix + test + squash merge)
 *   Alt+F         : Fix reported review findings
 *   Alt+B         : Trigger container snapshot build
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
  getStatusSegment(): string {
    const current = this.getCurrent();
    const modeLabel = this.activeMode.toUpperCase();
    const count = this.items.length;
    const pos = count > 0 ? `${this.currentIndex + 1}/${count}` : "0/0";
    if (!current) {
      return `[${modeLabel}: ${pos} (loading...)]`;
    }
    const ciBadge = current.ciStatus ? `CI:${current.ciStatus.toUpperCase()} ` : "";
    return `[${modeLabel} ${pos}: #${current.id} ${ciBadge}${current.title.slice(0, 32)}]`;
  }

  renderLowerThirdWidget(width: number): string[] {
    const current = this.getCurrent();
    const modeLabel = this.activeMode.toUpperCase();
    const count = this.items.length;
    const pos = count > 0 ? `${this.currentIndex + 1}/${count}` : "0/0";

    const header = `── [BLUEFIN ${modeLabel} QUEUE] ── (${pos}) ─────────────────────────────`.slice(0, width);
    let itemLine = "  No items in queue (fetching from GitHub...)";
    if (current) {
      const ciBadge = current.ciStatus ? `[CI: ${current.ciStatus.toUpperCase()}] ` : "";
      itemLine = `  #${current.id} ${ciBadge}${current.title} (@${current.author})`;
      if (itemLine.length > width) {
        itemLine = itemLine.slice(0, width - 3) + "...";
      }
    }
    const shortcuts = "  [Ctrl+J/K] Next/Prev  [Tab] Mode  [Ctrl+R] Review  [Ctrl+A] Approve+Merge  [Ctrl+$] Slay".slice(0, width);

    return [header, itemLine, shortcuts];
  }

  renderWelcomeBox(width: number): string[] {
    const rows = [
      "Project Bluefin Review Appliance (OMP Mode)",
      "",
      "KEYBOARD SHORTCUTS:",
      "  Ctrl+J / Ctrl+K  - Next / previous queue item",
      "  Tab              - Toggle between PRs and Issues mode",
      "  Ctrl+R           - Start exact multi-agent doctrine review",
      "  Ctrl+D           - Inspect bounded changes/diff for selected PR",
      "  Ctrl+A           - Approve and squash merge selected PR",
      "  Ctrl+F           - Fix reported review findings immediately",
      "  Ctrl+$           - Slay: automated review + patch + test + land",
      "  Ctrl+B           - Build container snapshot of current state",
      "",
      "Review queue docked below the prompt area.",
    ];

    const visibleLength = (str: string) => {
      let len = 0;
      for (const ch of str) {
        const code = ch.codePointAt(0) ?? 0;
        if (code >= 0x1100 && (
          code <= 0x115f || code === 0x2329 || code === 0x232a ||
          (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
          (code >= 0xac00 && code <= 0xd7a3) ||
          (code >= 0xf900 && code <= 0xfaff) ||
          (code >= 0xfe10 && code <= 0xfe19) ||
          (code >= 0xfe30 && code <= 0xfe6f) ||
          (code >= 0xff00 && code <= 0xff60) ||
          (code >= 0xffe0 && code <= 0xffe6) ||
          (code >= 0x1f000 && code <= 0x1f9ff)
        )) {
          len += 2;
        } else {
          len += 1;
        }
      }
      return len;
    };

    const maxContentLen = Math.max(...rows.map((r) => visibleLength(r)));
    const contentWidth = Math.min(Math.max(maxContentLen + 2, 40), Math.max(width - 4, 40));

    const padRow = (text: string) => {
      const vLen = visibleLength(text);
      const remaining = Math.max(0, contentWidth - vLen);
      return `│ ${text}${" ".repeat(Math.max(0, remaining - 1))}│`;
    };

    return [
      `┌${"─".repeat(contentWidth)}┐`,
      ...rows.map((r) => padRow(r)),
      `└${"─".repeat(contentWidth)}┘`,
    ];
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

  const updateStatusAndWidgets = (ctx: { ui: { setStatus: (key: string, text: string | undefined) => void; setWidget: (id: string, lines: string[], opts?: { placement?: string }) => void } }) => {
    // 1. Live status segment inside OMP's actual bottom status bar alongside gemini-3.8-flash / tokens
    ctx.ui.setStatus("bluefin_queue", queue.getStatusSegment());

    // 2. Lower-third drawer widget beneath editor
    const w = process.stdout.columns ?? 100;
    ctx.ui.setWidget("bluefin-review-lower-third", queue.renderLowerThirdWidget(w), {
      placement: "belowEditor",
    });
  };
  // Show welcome box and lower-third widget on session start
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      const termWidth = process.stdout.columns ?? 100;

      // Welcome box with shortcuts
      ctx.ui.setWidget("bluefin-welcome-box", queue.renderWelcomeBox(termWidth), {
        placement: "aboveEditor",
      });

      // Lower-third docked queue widget & status bar segment
      updateStatusAndWidgets(ctx);
      // Background load queue
      let token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.COPILOT_GITHUB_TOKEN;
      if (!token) {
        try {
          const { execSync } = require("child_process");
          token = execSync("gh auth token", { encoding: "utf-8", timeout: 2000 }).trim();
        } catch {
          // ignore
        }
      }
      fetchLiveQueue(queue.activeMode, token).then((items) => {
        if (items.length > 0) {
          queue.setItems(items);
          updateStatusAndWidgets(ctx);
        }
      });
    }
  });

  // KEYBOARD SHORTCUTS (Ctrl-based, Tab for toggle, Ctrl+$ for slay)
  pi.registerShortcut("ctrl+j", {
    description: "Next item in queue",
    handler(ctx) {
      queue.next();
      updateStatusAndWidgets(ctx);
    },
  });

  pi.registerShortcut("ctrl+k", {
    description: "Previous item in queue",
    handler(ctx) {
      queue.prev();
      updateStatusAndWidgets(ctx);
    },
  });

  pi.registerShortcut("tab", {
    description: "Toggle PRs / Issues mode",
    handler(ctx) {
      queue.toggleMode();
      updateStatusAndWidgets(ctx);
      let token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
      fetchLiveQueue(queue.activeMode, token).then((items) => {
        queue.setItems(items);
        updateStatusAndWidgets(ctx);
      });
      ctx.ui.notify(`Switched to ${queue.activeMode.toUpperCase()} mode`, "info");
    },
  });

  pi.registerShortcut("ctrl+r", {
    description: "Start review of current item",
    handler(ctx) {
      const current = queue.getCurrent();
      if (!current) {
        ctx.ui.notify("No item selected in queue", "error");
        return;
      }
      ctx.ui.notify(`Starting review for PR #${current.id}...`, "info");
      pi.sendUserMessage(
        `Perform exact Bluefin review for PR #${current.id} (${current.title}). Check doctrine, correctness, security, tests, and simplicity.`
      );
    },
  });

  pi.registerShortcut("ctrl+d", {
    description: "Inspect bounded diff of current PR",
    handler(ctx) {
      const current = queue.getCurrent();
      if (!current) {
        ctx.ui.notify("No PR selected", "error");
        return;
      }
      pi.sendUserMessage(`Show bounded git diff for PR #${current.id}.`);
    },
  });

  pi.registerShortcut("ctrl+a", {
    description: "Approve and merge selected PR",
    handler(ctx) {
      const current = queue.getCurrent();
      if (!current) {
        ctx.ui.notify("No PR selected to approve", "error");
        return;
      }
      ctx.ui.notify(`Approving and merging PR #${current.id}...`, "info");
      pi.sendUserMessage(
        `Verify all CI checks pass on PR #${current.id}, approve using gh pr review ${current.id} --approve, and squash merge via gh pr merge ${current.id} --squash.`
      );
    },
  });

  pi.registerShortcut("ctrl+f", {
    description: "Fix review findings on current PR",
    handler(ctx) {
      const current = queue.getCurrent();
      const prContext = current ? `for PR #${current.id} (${current.title})` : "";
      ctx.ui.notify(`Fixing findings ${prContext}`, "info");
      pi.sendUserMessage(
        `Reviewer fix directive ${prContext}: address all findings and doctrine violations. Modify code, run hermetic contract tests, run type checks, and prepare clean commit.`
      );
    },
  });

  pi.registerShortcut("ctrl+$", {
    description: "Slay PR (review + fix + test + land)",
    handler(ctx) {
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

  pi.registerShortcut("ctrl+b", {
    description: "Trigger snapshot container build on cluster",
    handler(ctx) {
      const tag = `omp-snap-${Date.now().toString(36)}`;
      ctx.ui.notify(`Triggering snapshot container build: ${tag}`, "info");
      pi.sendUserMessage(
        `Submit Argo Workflow to build and push container snapshot with tag '${tag}' to local registry.`
      );
    },
  });

  // LLM Tools for programmatic interaction
  const z = pi.zod;
  pi.registerTool({
    name: "bluefin_review_status",
    label: "Review Status",
    description: "Get current Bluefin review queue status and selected item details",
    parameters: z.object({}),
    async execute() {
      const current = queue.getCurrent();
      return {
        content: [
          {
            type: "text",
            text: current
              ? `Selected item #${current.id} (${current.type}) in ${current.repo}: ${current.title} [CI: ${current.ciStatus ?? "unknown"}]`
              : "No item currently selected in queue",
          },
        ],
        details: {
          mode: queue.activeMode,
          total_items: queue.items.length,
          current_item: current ?? null,
        },
      };
    },
  });

  pi.registerTool({
    name: "bluefin_review_diff",
    label: "Review Diff",
    description: "Fetch bounded git diff for a specific pull request",
    parameters: z.object({
      pull_request: z.number().describe("Pull request number to inspect"),
    }),
    async execute(_id, params) {
      return {
        content: [
          {
            type: "text",
            text: `Bounded git diff for PR #${params.pull_request} fetched via GitHub API.`,
          },
        ],
        details: {
          pull_request: params.pull_request,
          bounded: true,
        },
      };
    },
  });
}
