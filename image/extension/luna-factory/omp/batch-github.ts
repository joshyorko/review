import { digest, type SelectedItem } from "../core/batch.ts";
import { deadlineSignal } from "../../bluefin-review/deadline.ts";

interface Connection<T> { nodes: T[]; pageInfo: { hasNextPage: boolean } }
interface Link { number: number; state?: string; repository: { nameWithOwner: string } }
interface GitHubItem {
	id: string; __typename: string; title: string; body: string; closed: boolean; merged?: boolean; url: string;
	baseRefOid?: string; headRefOid?: string; baseRefName?: string; labels: Connection<{ name: string }>;
	files?: Connection<{ path: string }>; closingIssuesReferences?: Connection<Link>;
	timelineItems?: Connection<{ source?: Link }>;
}
interface SnapshotResponse {
	data?: { repository?: { id: string; nameWithOwner: string; defaultBranchRef?: { name: string; target: { oid: string } }; issueOrPullRequest?: GitHubItem } };
}

/** Uses the existing Review credential, never a per-repository substitute. */
export class BatchGitHub {
	readonly token: string | undefined;
	readonly fetchImpl: typeof fetch;
	constructor(token: string | undefined, fetchImpl: typeof fetch = fetch) { this.token = token; this.fetchImpl = fetchImpl; }
	async request<T>(path: string, body?: unknown): Promise<T> {
		if (!this.token) throw new Error("no GitHub credential; configure the existing Review connection and resume");
		const response = await this.fetchImpl(`https://api.github.com/${path}`, {
			method: body === undefined ? "GET" : "POST", redirect: "error", signal: deadlineSignal(30_000),
			headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok) throw new Error(`GitHub ${response.status}; affected item blocked, restore access/rate limit then resume`);
		const result: unknown = await response.json();
		if (!result || typeof result !== "object") throw new Error("invalid GitHub response");
		if ("errors" in result && Array.isArray(result.errors) && result.errors.length) throw new Error("GitHub returned incomplete item evidence; restore access then resume");
		return result as T;
	}
	async snapshot(selected: SelectedItem): Promise<SelectedItem> {
		if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(selected.repo) || !Number.isSafeInteger(selected.number) || selected.number < 1 || selected.kind === "unknown") throw new Error("resolve selected canonical repository, number and kind in Review");
		const [owner, name] = selected.repo.split("/");
		const result = await this.request<SnapshotResponse>("graphql", { query: `query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ id nameWithOwner defaultBranchRef{name target{oid}} issueOrPullRequest(number:$number){ __typename ... on Issue{id title body closed url labels(first:100){nodes{name} pageInfo{hasNextPage}} timelineItems(first:100,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{... on CrossReferencedEvent{source{... on PullRequest{number state repository{nameWithOwner}}}}} pageInfo{hasNextPage}}} ... on PullRequest{id title body closed merged url baseRefOid headRefOid baseRefName labels(first:100){nodes{name} pageInfo{hasNextPage}} files(first:100){nodes{path} pageInfo{hasNextPage}} closingIssuesReferences(first:100){nodes{number repository{nameWithOwner}} pageInfo{hasNextPage}}}}}}`, variables: { owner, name, number: selected.number } });
		const repo = result.data?.repository;
		const item = repo?.issueOrPullRequest;
		if (!repo || !item) throw new Error("selected repository/item unavailable; restore access or explicitly revise scope");
		if (typeof repo.id !== "string" || typeof repo.nameWithOwner !== "string" || typeof item.id !== "string" || typeof item.title !== "string" || typeof item.body !== "string" || !Array.isArray(item.labels?.nodes)) throw new Error("malformed canonical item evidence");
		if (repo.nameWithOwner.toLowerCase() !== selected.repo.toLowerCase()) throw new Error(`repository renamed to ${repo.nameWithOwner}; explicitly reselect canonical identity`);
		if ((selected.kind === "pr" ? "PullRequest" : "Issue") !== item.__typename) throw new Error("selected item kind changed; explicitly reselect");
		if (selected.repositoryId && selected.repositoryId !== repo.id || selected.itemId && selected.itemId !== item.id) throw new Error("canonical identity changed; refusing to bind another repository/item");
		if (item.closed && !item.merged) throw new Error("selected item is closed; inspect and explicitly revise scope");
		if (item.labels.pageInfo.hasNextPage || item.files?.pageInfo.hasNextPage || item.closingIssuesReferences?.pageInfo.hasNextPage || item.timelineItems?.pageInfo.hasNextPage) throw new Error("incomplete policy/overlap evidence; resolve item before dispatch");
		if (item.labels.nodes.some((label: { name: string }) => ["hold", "blocked"].includes(label.name))) throw new Error("selected item has hold/blocked policy label");
		if (selected.action === "pr-ready" && item.files?.nodes.some((file: { path: string }) => file.path.startsWith(".github/workflows/"))) throw new Error("workflow-changing PR remains inspectable; Factory refuses workflow push/landing");
		const base = item.baseRefOid ?? repo.defaultBranchRef?.target.oid;
		const head = item.headRefOid ?? repo.defaultBranchRef?.target.oid;
		const baseRef = item.baseRefName ?? repo.defaultBranchRef?.name;
		if (!base || !head || !baseRef || !/^[a-f0-9]{40,64}$/.test(base) || !/^[a-f0-9]{40,64}$/.test(head)) throw new Error("selected repository subject unavailable; resolve its base/head before execution");
		const overlaps = [
			...(item.closingIssuesReferences?.nodes ?? []).map((issue) => `${issue.repository.nameWithOwner}#${issue.number}`.toLowerCase()),
			...(item.timelineItems?.nodes ?? []).flatMap((entry) => entry.source?.state === "OPEN" ? [`${entry.source.repository.nameWithOwner}#${entry.source.number}`.toLowerCase()] : []),
		];
		return { ...selected, repo: repo.nameWithOwner.toLowerCase(), key: `${repo.nameWithOwner.toLowerCase()}#${selected.number}`, repositoryId: repo.id, itemId: item.id, url: item.url, acceptance: `${item.title}\n\n${item.body}`, acceptanceRevision: digest(`${item.title}\n${item.body}`), base, head, baseRef, overlaps, blocker: undefined };
	}
	async assertFresh(selected: SelectedItem): Promise<void> {
		const current = await this.snapshot(selected);
		const currentOverlaps = [...new Set(current.overlaps.map((overlap) => overlap.toLowerCase()))].sort();
		const selectedOverlaps = [...new Set(selected.overlaps.map((overlap) => overlap.toLowerCase()))].sort();
		if (current.acceptanceRevision !== selected.acceptanceRevision || current.head !== selected.head || current.base !== selected.base || JSON.stringify(currentOverlaps) !== JSON.stringify(selectedOverlaps)) throw new Error("selected head/base/acceptance or overlap scope changed; proof stale, explicitly rebase/reselect instead of chasing moving work");
	}
}
