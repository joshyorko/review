import assert from "node:assert/strict";
import test from "node:test";
import { createBatch } from "../image/extension/luna-factory/core/batch.ts";
import { projectItem } from "../image/extension/luna-factory/ui/projection.ts";
import { itemOverview } from "../image/extension/luna-factory/ui/operator.ts";
const batch = () => createBatch([{ key: "acme/app#195", repo: "acme/app", number: 195, action: "patch", kind: "issue", overlaps: [], base: "a", head: "a", acceptanceRevision: "r1" }], { id: "batch-a", capacity: 2, maxAttempts: 3, maxTotalAttempts: 3, mode: "retain" });
test("operator overview explains ownership without exposing claim internals", () => {
 const b = batch(); b.items[0]!.stage = "BLOCKED";
 const item = projectItem(b,b.items[0]!,{claims:[{resource:"repo:acme/app",owner:"review:batch-mugs4x61:0",status:"unknown",createdAt:"now"}]});
 const view = itemOverview(item); assert.equal(view.heading,"Repository locked");assert.equal(view.needsYou,true);
 assert.doesNotMatch(JSON.stringify(view),/mugs4x61|repo:|\/state/);
});
test("observed work and unconfirmed persisted running state are not conflated", () => {
 const b = batch();b.items[0]!.stage="RUNNING";const item=projectItem(b,b.items[0]!);
 assert.equal(itemOverview(item,true).needsYou,false);assert.equal(itemOverview(item,false).needsYou,true);
 assert.match(itemOverview(item,false).explanation,/No current worker/);
});
test("unknown external effect puts reconciliation ahead of retry", () => {
 const b=batch();const i=b.items[0]!;i.stage="UNKNOWN";i.operation={id:"operation-a",generation:i.ledger.generation,subject:i.ledger.subject,effect:"git-push",phase:"push",state:"unknown"};
 const view=itemOverview(projectItem(b,i));assert.match(view.next,/Reconcile/);assert.doesNotMatch(view.next,/retry/i);
});

test("repository command failures keep paths and raw stderr behind debug", () => {
 const b = batch(); const item = b.items[0]!;
 item.stage = "BLOCKED";
 item.blocker = "Command failed: gh repo clone acme/app /home/operator/state/batch-uuid/workspace\nraw git stderr";
 const projected = projectItem(b, item);
 const view = itemOverview(projected);
 assert.equal(view.caption, "repository setup failed");
	assert.match(view.next, /Inspect the recorded error/);
 assert.doesNotMatch(JSON.stringify(view), /batch-uuid|raw git stderr|\/home/);
 assert.equal(projected.blocker, item.blocker);
});
