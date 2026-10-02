import { digest, type SelectedItem } from "../core/batch.ts";
import { deadlineSignal } from "../../bluefin-review/deadline.ts";
import type { GraphNodeObservation, GraphRelation, WorkGraphObservation } from "../core/graph.ts";

interface Connection<T> { nodes: T[]; pageInfo: { hasNextPage: boolean } }
interface Link { number: number; state?: string; repository: { nameWithOwner: string }; id?: string; merged?: boolean; baseRefOid?: string; headRefOid?: string; baseRefName?: string; closingIssuesReferences?: Connection<Link> }
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
		if (Array.isArray(result) && response.headers?.get("link")?.includes('rel="next"')) throw new Error("incomplete paginated relationship evidence; bounded observation cannot prove absence");
		if (!result || typeof result !== "object") throw new Error("invalid GitHub response");
		if ("errors" in result && Array.isArray(result.errors) && result.errors.length) throw new Error("GitHub returned incomplete item evidence; restore access then resume");
		return result as T;
	}
		async snapshot(selected: SelectedItem, dependencyObservation = false): Promise<SelectedItem> {
		if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(selected.repo) || !Number.isSafeInteger(selected.number) || selected.number < 1 || selected.kind === "unknown") throw new Error("resolve selected canonical repository, number and kind in Review");
		const [owner, name] = selected.repo.split("/");
		const result = await this.request<SnapshotResponse>("graphql", { query: `query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ id nameWithOwner defaultBranchRef{name target{oid}} issueOrPullRequest(number:$number){ __typename ... on Issue{id title body closed url labels(first:100){nodes{name} pageInfo{hasNextPage}} timelineItems(first:100,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{... on CrossReferencedEvent{source{... on PullRequest{id number state merged baseRefOid headRefOid baseRefName repository{nameWithOwner} closingIssuesReferences(first:100){nodes{number repository{nameWithOwner}} pageInfo{hasNextPage}}}}}} pageInfo{hasNextPage}}} ... on PullRequest{id title body closed merged url baseRefOid headRefOid baseRefName labels(first:100){nodes{name} pageInfo{hasNextPage}} files(first:100){nodes{path} pageInfo{hasNextPage}} closingIssuesReferences(first:100){nodes{number repository{nameWithOwner}} pageInfo{hasNextPage}}}}}}`, variables: { owner, name, number: selected.number } });
		const repo = result.data?.repository;
		const item = repo?.issueOrPullRequest;
		if (!repo || !item) throw new Error("selected repository/item unavailable; restore access or explicitly revise scope");
		if (typeof repo.id !== "string" || typeof repo.nameWithOwner !== "string" || typeof item.id !== "string" || typeof item.title !== "string" || typeof item.body !== "string" || !Array.isArray(item.labels?.nodes)) throw new Error("malformed canonical item evidence");
		if (repo.nameWithOwner.toLowerCase() !== selected.repo.toLowerCase()) throw new Error(`repository renamed to ${repo.nameWithOwner}; explicitly reselect canonical identity`);
		if ((selected.kind === "pr" ? "PullRequest" : "Issue") !== item.__typename) throw new Error("selected item kind changed; explicitly reselect");
		if (selected.repositoryId && selected.repositoryId !== repo.id || selected.itemId && selected.itemId !== item.id) throw new Error("canonical identity changed; refusing to bind another repository/item");
		if (item.closed && !item.merged && !dependencyObservation) throw new Error("selected item is closed; inspect and explicitly revise scope");
		if (item.labels.pageInfo.hasNextPage || item.files?.pageInfo.hasNextPage || item.closingIssuesReferences?.pageInfo.hasNextPage || item.timelineItems?.pageInfo.hasNextPage) throw new Error("incomplete policy/overlap evidence; resolve item before dispatch");
		if (item.labels.nodes.some((label: { name: string }) => ["hold", "blocked"].includes(label.name))) throw new Error("selected item has hold/blocked policy label");
		if (selected.action === "pr-ready" && item.files?.nodes.some((file: { path: string }) => file.path.startsWith(".github/workflows/"))) throw new Error("workflow-changing PR remains inspectable; Factory refuses workflow push/landing");
		let base = item.baseRefOid ?? repo.defaultBranchRef?.target.oid;
		let head = item.headRefOid ?? repo.defaultBranchRef?.target.oid;
		let baseRef = item.baseRefName ?? repo.defaultBranchRef?.name;
		if (selected.targetRef !== undefined) {
			if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(selected.targetRef) || selected.targetRef.includes("..") || selected.targetRef.endsWith(".lock")) throw new Error("explicit target ref is unsupported");
			if (selected.kind === "pr" && selected.targetRef !== item.baseRefName) throw new Error("selected PR targets a different branch; explicit target authority cannot be redirected");
			const target = await this.request<{ object: { sha: string } }>(`repos/${selected.repo}/git/ref/heads/${encodeURIComponent(selected.targetRef)}`);
			if (!target.object || !/^[a-f0-9]{40,64}$/.test(target.object.sha)) throw new Error("explicit target branch subject is unavailable");
			baseRef = selected.targetRef;
			base = target.object.sha;
			if (selected.kind === "issue") head = target.object.sha;
		}
		if (!base || !head || !baseRef || !/^[a-f0-9]{40,64}$/.test(base) || !/^[a-f0-9]{40,64}$/.test(head)) throw new Error("selected repository subject unavailable; resolve its base/head before execution");
		const sourcePullRequests: NonNullable<SelectedItem["sourcePullRequests"]> = [];
		if (selected.graphObservation) for (const entry of item.timelineItems?.nodes ?? []) {
			const pull = entry.source;
			if (!pull) continue;
			if (!pull.id || !pull.baseRefOid || !pull.headRefOid || !pull.baseRefName || !pull.closingIssuesReferences || pull.closingIssuesReferences.pageInfo.hasNextPage) throw new Error("incomplete PR implementation relationship evidence");
			sourcePullRequests.push({ key: `${pull.repository.nameWithOwner.toLowerCase()}#${pull.number}`, identity: pull.id, base: pull.baseRefOid, head: pull.headRefOid, baseRef: pull.baseRefName,
				state: pull.merged ? "merged" : pull.state === "OPEN" ? "open" : "closed", implements: pull.closingIssuesReferences.nodes.some((issue) => issue.number === selected.number && issue.repository.nameWithOwner.toLowerCase() === selected.repo.toLowerCase()) });
		}
		const overlaps = [
			...(item.closingIssuesReferences?.nodes ?? []).map((issue) => `${issue.repository.nameWithOwner}#${issue.number}`.toLowerCase()),
			...(selected.graphObservation ? sourcePullRequests.filter((pull) => pull.implements && pull.state === "open").map((pull) => pull.key) : (item.timelineItems?.nodes ?? []).flatMap((entry) => entry.source?.state === "OPEN" ? [`${entry.source.repository.nameWithOwner}#${entry.source.number}`.toLowerCase()] : [])),
		];
		return { ...selected, repo: repo.nameWithOwner.toLowerCase(), key: `${repo.nameWithOwner.toLowerCase()}#${selected.number}`, repositoryId: repo.id, itemId: item.id, url: item.url, acceptance: `${item.title}\n\n${item.body}`, acceptanceRevision: digest(`${item.title}\n${item.body}`), base, head, baseRef, overlaps, ...(selected.graphObservation ? { sourcePullRequests, sourceDefaultRef: repo.defaultBranchRef?.name } : {}), sourceState: item.merged ? "merged" : item.closed ? "closed" : "open", blocker: undefined };
	}

	/** Bounded named observation. External prerequisites are read-only nodes, never membership. */
	async observeGraph(selected: readonly SelectedItem[], generation: string): Promise<WorkGraphObservation> {
		const nodes = new Map<string, GraphNodeObservation>();
		const relations: GraphRelation[] = [];
		const selectedKeys = new Set(selected.map((item) => item.key));
		const observe = async (item: SelectedItem): Promise<SelectedItem | undefined> => {
			if (nodes.size >= 42 && !nodes.has(item.key)) throw new Error("bounded prerequisite observation exceeded; unresolved lanes remain unknown");
			try {
				const current = await this.snapshot({ ...item, graphObservation: true }, !selectedKeys.has(item.key));
				const implementation = !selectedKeys.has(item.key) ? current.sourcePullRequests?.find((pull) => pull.implements && pull.state === "merged" && pull.baseRef === current.baseRef) : undefined;
				const proven = current.kind === "pr" && current.sourceState === "merged" || implementation !== undefined;
				nodes.set(current.key, { key: current.key, generation, acceptanceRevision: current.acceptanceRevision, subject: { repo: current.repo, base: current.base!, head: current.head }, required: selectedKeys.has(current.key), target: current.observe ?? "merged-upstream", state: proven ? "DONE" : current.sourceState === "closed" ? "UNKNOWN" : "QUEUED", proof: proven ? "merged-upstream" : undefined, proofCurrent: proven, blocker: current.sourceState === "closed" && !proven ? "closed issue alone does not prove implementation; observe its actual outcome" : undefined });
				for (const pull of current.sourcePullRequests ?? []) {
					if (!nodes.has(pull.key)) nodes.set(pull.key, { key: pull.key, generation, subject: { repo: pull.key.split("#")[0]!, base: pull.base, head: pull.head }, required: selectedKeys.has(pull.key), target: "merged-upstream", state: pull.state === "merged" ? "DONE" : pull.state === "open" ? "QUEUED" : "UNKNOWN", proof: pull.state === "merged" ? "merged-upstream" : undefined, proofCurrent: pull.state === "merged" });
					relations.push({ from: pull.key, to: current.key, kind: "implements", authority: pull.implements ? "authoritative" : "inferred", source: `github:closing-reference:${pull.identity}` });
					if (pull.implements && pull.state === "open") relations.push({ from: current.key, to: pull.key, kind: "overlaps", authority: "authoritative", source: `github:open-implementation:${pull.identity}` });
				}
				if (current.kind === "pr") for (const key of current.overlaps) {
					relations.push({ from: current.key, to: key, kind: "implements", authority: "authoritative", source: `github:closing-reference:${current.itemId}` });
					if (!nodes.has(key) && nodes.size < 42) { const [repo, number] = key.split("#"); await observe({ key, repo: repo!, number: Number(number), kind: "issue", action: "inspect", overlaps: [] }); }
				}
				if (current.kind === "pr" && current.sourceDefaultRef && current.baseRef !== current.sourceDefaultRef) {
					const lower = await this.request<Array<{ number: number; head: { sha: string } }>>(`repos/${current.repo}/pulls?state=open&head=${encodeURIComponent(`${current.repo.split("/")[0]}:${current.baseRef}`)}&per_page=100`);
					if (!Array.isArray(lower) || lower.length > 1) throw new Error("stack ancestry is ambiguous; restore canonical base-branch observation");
					const ancestor = lower[0];
					if (ancestor) {
						if (ancestor.head.sha !== current.base || !Number.isSafeInteger(ancestor.number)) throw new Error("stack base ancestry does not match captured PR base");
						const key = `${current.repo}#${ancestor.number}`;
						relations.push({ from: current.key, to: key, kind: "stacked-on", authority: "authoritative", stage: "merged-upstream", source: `github:base-head-ancestry:${current.itemId}:${current.base}` });
						if (!nodes.has(key)) await observe({ key, repo: current.repo, number: ancestor.number, kind: "pr", action: "inspect", overlaps: [] });
					}
				}
				return current;
			} catch (error) {
				nodes.set(item.key, { key: item.key, generation, required: selectedKeys.has(item.key), target: "merged-upstream", state: "UNKNOWN", blocker: error instanceof Error ? error.message : String(error) });
				return undefined;
			}
		};
		for (const item of selected) {
			const current = await observe(item);
			if (!current || item.kind !== "issue") continue;
			try {
				for (const [endpoint, kind] of [["dependencies/blocked_by", "requires"], ["sub_issues", "contains"]] as const) {
					const entries = await this.request<Array<{ number: number; repository_url: string }>>(`repos/${item.repo}/issues/${item.number}/${endpoint}?per_page=100`);
					if (!Array.isArray(entries) || entries.length >= 100) throw new Error("incomplete bounded relationship evidence; restore coverage before dispatch");
					for (const entry of entries) {
						const repo = /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/.exec(entry.repository_url)?.[1]?.toLowerCase();
						if (!repo || !Number.isSafeInteger(entry.number) || entry.number < 1) throw new Error("malformed canonical relationship evidence");
						const key = `${repo}#${entry.number}`;
						relations.push({ from: item.key, to: key, kind, authority: "authoritative", source: `github:${endpoint}:${current.itemId}`, ...(kind === "requires" ? { stage: "merged-upstream" as const } : {}) });
						if (!nodes.has(key)) await observe({ key, repo, number: entry.number, kind: "issue", action: "inspect", overlaps: [], ...(repo === item.repo ? { targetRef: current.baseRef } : {}) });
					}
				}
			} catch (error) {
				const node = nodes.get(item.key)!;
				nodes.set(item.key, { ...node, state: "UNKNOWN", blocker: error instanceof Error ? error.message : String(error) });
			}
		}
		return { generation, nodes: [...nodes.values()], relations };
	}
	async assertFresh(selected: SelectedItem): Promise<void> {
		const current = await this.snapshot(selected);
		const currentOverlaps = [...new Set(current.overlaps.map((overlap) => overlap.toLowerCase()))].sort();
		const selectedOverlaps = [...new Set(selected.overlaps.map((overlap) => overlap.toLowerCase()))].sort();
		if (current.acceptanceRevision !== selected.acceptanceRevision || current.head !== selected.head || current.base !== selected.base || JSON.stringify(currentOverlaps) !== JSON.stringify(selectedOverlaps)) throw new Error("selected head/base/acceptance or overlap scope changed; proof stale, explicitly rebase/reselect instead of chasing moving work");
	}
}
