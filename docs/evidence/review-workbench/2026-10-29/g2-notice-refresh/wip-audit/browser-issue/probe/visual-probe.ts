import { appendFileSync, readFileSync } from "node:fs";
import { createReviewExtension, NOTICE_ENTRY, taskSchemaSupportsStructuredOutput } from "/usr/share/review/source/review/extension.ts";
import { rawKeyMatcher } from "/usr/share/review/source/review/keys.ts";
const reviewPr = {
  number: 42, title: "fixture: incomplete file evidence", url: "https://github.com/fixture/review/pull/42",
  updatedAt: new Date().toISOString(), isDraft: false, mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED",
  additions: 1, deletions: 0, changedFiles: 1, author: { login: "fixture" }, headRefOid: "a".repeat(40),
  repository: { nameWithOwner: "fixture/review" }, files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "README.md" }] },
  labels: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
};
let failNextRefresh = false;
let rejectNextSend = false;
function jsonResponse(data) { return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } }); }
async function fixtureFetch(url, init) {
  if (String(url).includes("/graphql")) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.variables?.search !== undefined) {
      if (failNextRefresh) {
        failNextRefresh = false;
        const detail = "fixture returned an incomplete structured reviewer response; ".repeat(7);
        return new Response("{}", { status: 503, statusText: `deterministic refresh failure: ${detail}` });
      }
      const isIssue = String(body.variables.search).includes("is:issue");
      const item = isIssue ? { ...reviewPr, title: "fixture: browser issue", url: "https://github.com/fixture/review/issues/42" } : reviewPr;
      return jsonResponse({ viewer: { login: "fixture" }, search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [item] } });
    }
    if (typeof body.query === "string" && body.query.includes("w0: repository(")) {
      return jsonResponse({ w0: { issueOrPullRequest: { ...reviewPr, closed: false } } });
    }
    return jsonResponse({});
  }
  return jsonResponse({});
}
export default function load(pi) {
  const execute = pi.exec.bind(pi);
  pi.exec = async (command, args, options) => {
    if (command === "gh" && args.includes("--web")) {
      return { stdout: "", stderr: `deterministic browser failure: ${"provider returned an incomplete structured reviewer response; ".repeat(8)}`, code: 127, killed: false };
    }
    return execute(command, args, options);
  };
  const sendUserMessage = pi.sendUserMessage.bind(pi);
  pi.sendUserMessage = (message, options) => {
    const targets = [...new Set(String(message).match(/fixture\/review#\d+/g) ?? [])];
    appendFileSync("/probe/send-attempts.jsonl", JSON.stringify({ targets, waveId: options?.waveId, rejected: rejectNextSend }) + "\n");
    if (rejectNextSend) {
      rejectNextSend = false;
      throw new Error("fixture intercepted an uncertain OMP handoff before a model request");
    }
    // Simulate OMP accepting the handoff while preventing any model or worker request.
  };
  const appendEntry = pi.appendEntry.bind(pi);
  pi.appendEntry = (customType, data) => {
    if (customType === NOTICE_ENTRY) appendFileSync("/probe/notice-customentries.jsonl", JSON.stringify({ customType, data }) + "\n");
    return appendEntry(customType, data);
  };
  const env = { ...process.env, GH_TOKEN: "visual-probe-only", GITHUB_TOKEN: "", REVIEW_MODE: "review" };
  createReviewExtension(pi, { org: "fixture", fetchImpl: fixtureFetch, env, matchKey: rawKeyMatcher });
  pi.registerCommand("visual-arm-refresh-failure", { description: "Arm one deterministic in-memory queue failure", handler: () => { failNextRefresh = true; } });
  pi.registerCommand("visual-info", { description: "Show a routine information notice", handler: (_args, ctx) => ctx.ui.notify("An unrelated fixture item completed", "info") });
  pi.registerCommand("visual-reject-next-send", { description: "Make the next OMP handoff fail before any model request", handler: () => { rejectNextSend = true; } });
  pi.registerCommand("visual-task-check", { description: "Record current task capability", handler: () => {
    const task = pi.getAllTools().find(tool => tool.name === "task");
    appendFileSync("/probe/task-schema-events.jsonl", JSON.stringify({ productionGuard: taskSchemaSupportsStructuredOutput(task?.parameters), apiVersion: pi.sessionShutdownLifecycleVersion ?? null }) + "\n");
  } });
  pi.registerCommand("visual-inspect-notice-entry", { description: "Record a bounded view of the saved notice custom entry", handler: (_args, ctx) => {
    const file = ctx.sessionManager.getSessionFile();
    try {
      const text = readFileSync(file, "utf8");
      const fileEntries = text.split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return undefined; } }).filter(Boolean);
      const memoryEntries = ctx.sessionManager.getEntries();
      const entry = memoryEntries.filter((item) => item.type === "custom" && item.customType === NOTICE_ENTRY).at(-1);
      const fileEntry = fileEntries.filter((item) => item.type === "custom" && item.customType === NOTICE_ENTRY).at(-1);
      const data = entry?.data;
      appendFileSync("/probe/persisted-notice-inspection.jsonl", JSON.stringify({ sessionFile: file, memoryCustomCount: memoryEntries.filter((item) => item.type === "custom" && item.customType === NOTICE_ENTRY).length, jsonlCustomCount: fileEntries.filter((item) => item.type === "custom" && item.customType === NOTICE_ENTRY).length, inMemoryKeys: data ? Object.keys(data) : [], jsonlKeys: fileEntry?.data ? Object.keys(fileEntry.data) : [], title: data?.title, outcome: data?.outcome, action: data?.action, steps: data?.steps, diagnosticPreview: typeof data?.details === "string" ? data.details.slice(0, 180) : null }) + "\n");
    } catch (error) {
      appendFileSync("/probe/persisted-notice-inspection.jsonl", JSON.stringify({ sessionFile: file, readError: String(error) }) + "\n");
    }
  } });
  pi.on("session_start", (_event, ctx) => {
    const setWidget = ctx.ui.setWidget.bind(ctx.ui);
    const getFocused = ctx.ui.getFocused?.bind(ctx.ui);
    ctx.ui.setWidget = (key, content, options) => {
      const beforeDraft = ctx.ui.getEditorText?.() ?? null;
      const beforeFocus = getFocused?.();
      setWidget(key, content, options);
      const afterDraft = ctx.ui.getEditorText?.() ?? null;
      const afterFocus = getFocused?.();
      if (key === "review-native-notice") appendFileSync("/probe/notice-events.jsonl", JSON.stringify({ key, cleared: content === undefined, beforeDraft, afterDraft, focusInspectable: typeof getFocused === "function", focusStayedSame: typeof getFocused === "function" ? beforeFocus === afterFocus : null }) + "\n");
    };
  });
}
