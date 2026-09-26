import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createBatch, digest, type Batch, type BatchItem } from "../image/extension/luna-factory/core/batch.ts";
import { requiredChecks, packageCheckScripts } from "../image/extension/luna-factory/omp/batch-checks.ts";
import { sandboxPreflight } from "../image/extension/luna-factory/omp/batch-native.ts";
import { BatchService } from "../image/extension/luna-factory/omp/batch-service.ts";

function fixture(preflight: typeof sandboxPreflight = sandboxPreflight) {
 const root = mkdtempSync(join(tmpdir(), "factory-corrective-"));
 const batch = createBatch([{ key: "org/repo#1", repo: "org/repo", number: 1, kind: "pr", action: "patch", overlaps: [], acceptanceRevision: "r1", head: "a".repeat(40), base: "a".repeat(40) }], { id: "batch-abcdef", capacity: 1, maxAttempts: 3, maxTotalAttempts: 3, mode: "retain" });
 const service = new BatchService(root, { assertFresh: async () => {}, snapshot: async (x: unknown) => x } as never, undefined, {} as never, 1, root, preflight);
 service.store.acquire(); service.store.write(batch);
 const item = batch.items[0]!;
 const path = join(root, "workspaces", batch.id, digest(item.selected.key).slice(0, 16));
 return { root, batch, item, path, service, cleanup: async () => { await service.shutdown(); rmSync(root,{recursive:true,force:true}); } };
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], {cwd,encoding:"utf8"}).trim();
function ready(f: ReturnType<typeof fixture>) {
 mkdirSync(f.path,{recursive:true}); git(f.path,"init","-q");writeFileSync(join(f.path,"value.txt"),"retained\n");git(f.path,"add",".");git(f.path,"commit","-qm","fixture");git(f.path,"remote","add","origin","https://github.com/org/repo");
 const head=git(f.path,"rev-parse","HEAD");f.item.selected.head=head;f.item.selected.base=head;f.item.ledger.subject={repo:"org/repo",base:head,head};f.item.workspace=f.path;
}
function intent(f: ReturnType<typeof fixture>, state: "not-applied" | "unknown" = "not-applied") {
 return {id:`${f.batch.id}:${f.item.selected.key}:work`,owner:`${f.batch.id}:${f.item.selected.key}`,generation:f.item.ledger.generation,subject:f.item.ledger.subject,effect:"repository-work" as const,phase:"worker" as const,state};
}

test("retained path with archived no-start proof can resume absent preparation without resetting identity",async()=>{
 const f=fixture();try {
  f.item.workspace=f.path;f.item.operations.push(intent(f));
  let clones=0;
  const internals=f.service as unknown as { cloneWorkspace(item:BatchItem,path:string,signal:AbortSignal):Promise<void>; prepareWorkspace(batch:Batch,item:BatchItem,signal:AbortSignal):Promise<string> };
  internals.cloneWorkspace=async()=>{clones++;ready(f);};
  await internals.prepareWorkspace(f.batch,f.item,new AbortController().signal);
  assert.equal(clones,1);assert.equal(f.item.workspace,f.path);assert.equal(f.item.attempts,0);assert.equal(f.item.operations.length,1);assert.equal(f.item.preparation?.phase,"ready");
 }finally{await f.cleanup();}
});
test("missing retained workspace without positive no-start proof is not reconstructed",async()=>{
 const f=fixture();try{
  f.item.workspace=f.path;
  const internals=f.service as unknown as { prepareWorkspace(batch:Batch,item:BatchItem,signal:AbortSignal):Promise<string> };
  await assert.rejects(()=>internals.prepareWorkspace(f.batch,f.item,new AbortController().signal),/no-worker-start|initialization evidence/);
 }finally{await f.cleanup();}
});
test("ready retained checkout and worker modifications are preserved without clone or checkout",async()=>{
 const f=fixture();try{
  ready(f);f.item.attempts=1;writeFileSync(join(f.path,"value.txt"),"worker content\n");
  const internals=f.service as unknown as { prepareWorkspace(batch:Batch,item:BatchItem,signal:AbortSignal):Promise<string> };
  await internals.prepareWorkspace(f.batch,f.item,new AbortController().signal);
  assert.equal(readFileSync(join(f.path,"value.txt"),"utf8"),"worker content\n");assert.equal(f.item.attempts,1);
 }finally{await f.cleanup();}
});
test("partial repository preserves unrelated files and gives a precise preparation blocker",async()=>{
 const f=fixture();try{
  mkdirSync(f.path,{recursive:true});git(f.path,"init","-q");git(f.path,"remote","add","origin","https://github.com/org/repo");writeFileSync(join(f.path,"sentinel"),"keep");f.item.workspace=f.path;f.item.operations.push(intent(f));
  const internals=f.service as unknown as { prepareWorkspace(batch:Batch,item:BatchItem,signal:AbortSignal):Promise<string> };
  await assert.rejects(()=>internals.prepareWorkspace(f.batch,f.item,new AbortController().signal),/partial.*files|preserve/i);
  assert.equal(readFileSync(join(f.path,"sentinel"),"utf8"),"keep");
 }finally{await f.cleanup();}
});
test("SDK/model preflight refuses dispatch before preparation and attempt allocation",async()=>{
 const f=fixture();try{
  await f.service.resume(f.batch.id,{});await f.service.waitForIdle();const item=f.service.store.read(f.batch.id).items[0]!;
  assert.equal(item.attempts,0);assert.equal(item.workspace,undefined);assert.equal(item.stage,"BLOCKED");assert.match(item.blocker!,/SDK/);
 }finally{await f.cleanup();}
});

test("an independent rejection survives queue clearing and reaches the bounded repair worker",async()=>{
 const f=fixture();let workers=0;let reviews=0;const prompts:string[]=[];
 try{
  ready(f);f.item.selected.action="inspect";f.item.ledger.goal.permittedEffects=["read"];
  const sdk={Settings:{isolated:()=>({})},SessionManager:{create:()=>({})},AgentRegistry:class{},async createAgentSession(options:Record<string,unknown>){
   const tools=options.customTools as Array<{name:string;execute(id:string,args:unknown):Promise<unknown>}>;
   const report=tools.find(t=>t.name==="factory_report")!;const path=join(f.root,`session-${workers+reviews}.jsonl`);writeFileSync(path,"session\n");
   const listeners=new Set<(event:{type:string})=>void>();
   return {session:{sessionFile:path,subscribe(fn:(event:{type:string})=>void){listeners.add(fn);return ()=>listeners.delete(fn);},async prompt(prompt:string){
    for(const fn of listeners)fn({type:"turn_start"});
    const worker=prompt.startsWith("Implement/inspect");if(worker){workers++;prompts.push(prompt);}else reviews++;
    const accepted=worker||reviews>1;
    await report.execute("report",{report:accepted?"checked original acceptance":"DISTINCTIVE_REJECTION: boundary value zero is still wrong",tests:[],accepted,semanticOutcome:worker?"no-finding":"none",predicates:[{item:"original acceptance",ok:accepted,note:accepted?"observed":"zero boundary failed"}],publicationBlocker:""});
   },async abort(){},async dispose(){}}};
  }};
  // Only the provider is simulated here. Real dispatcher, Git, store and reducer execute.
  await f.service.shutdown();
  const service=new BatchService(f.root,{assertFresh:async()=>{}} as never,sdk as never,{object:()=>({}),string:()=>({}),array:()=>({}),number:()=>({}),boolean:()=>({})} as never,1);
  service.store.acquire();service.store.write(f.batch);
  await service.resume(f.batch.id,{model:{},modelRegistry:{authStorage:{},hasConfiguredAuth:()=>true}});await service.waitForIdle();
  const final=service.store.read(f.batch.id).items[0]!;
  assert.equal(workers,2);assert.equal(reviews,2);assert.match(prompts[1]!,/DISTINCTIVE_REJECTION/);assert.equal(final.attempts,2);assert.equal(final.ledger.tasks[0]!.attempts.length,2);
  await service.shutdown();
 }finally{await f.cleanup();}
});

test("resuming a second batch cannot replace an in-flight attempt's model binding",async()=>{
 const f=fixture();try{
  const second=createBatch([{...f.item.selected,key:"org/other#2",repo:"org/other",number:2}],{id:"batch-bbcdef",capacity:1,maxAttempts:2,maxTotalAttempts:2,mode:"retain"});
  f.service.store.write(second);
  const firstStarted=Promise.withResolvers<void>();const release=Promise.withResolvers<void>();
  const seen:string[]=[];
  const internal=f.service as unknown as {execute(batch:Batch,item:BatchItem,signal:AbortSignal,binding:{model:{id:string}}):Promise<void>};
  internal.execute=async(batch,item,_signal,binding)=>{if(batch.id===f.batch.id){firstStarted.resolve();await release.promise;}seen.push(`${batch.id}:${binding.model.id}`);item.stage="BLOCKED";};
  let model={id:"model-A"};const ctx=Object.create({get model(){return model;},modelRegistry:{authStorage:{},hasConfiguredAuth:()=>true}});
  await f.service.resume(f.batch.id,ctx);await firstStarted.promise;
  model={id:"model-B"};await f.service.resume(second.id,ctx);release.resolve();await f.service.waitForIdle();
  assert.deepEqual(seen,[`${f.batch.id}:model-A`,`${second.id}:model-B`]);
 }finally{await f.cleanup();}
});

test("a fetch failure after clone resumes exact preparation without recloning",async()=>{
 const f=fixture();try{
  const seed=join(f.root,"seed");mkdirSync(seed);git(seed,"init","-q");writeFileSync(join(seed,"value.txt"),"original\n");git(seed,"add",".");git(seed,"commit","-qm","seed");
  const head=git(seed,"rev-parse","HEAD");f.item.selected.head=head;f.item.selected.base=head;f.item.ledger.subject={repo:f.item.selected.repo,head,base:head};
  const internal=f.service as unknown as {cloneWorkspace(item:BatchItem,path:string,signal:AbortSignal):Promise<void>;git(path:string,args:string[],signal?:AbortSignal):Promise<string>;prepareWorkspace(batch:Batch,item:BatchItem,signal:AbortSignal):Promise<string>};
  let clones=0;let fetches=0;const originalGit=internal.git.bind(f.service);
  internal.cloneWorkspace=async(_item,path)=>{clones++;execFileSync("git",["clone","--quiet","--no-checkout",seed,path]);git(path,"remote","set-url","origin","https://github.com/org/repo");};
  internal.git=async(path,args,signal)=>{if(args[0]==="fetch"){fetches++;if(fetches===1)throw new Error("injected fetch-after-clone failure");return "";}return originalGit(path,args,signal);};
  await assert.rejects(()=>internal.prepareWorkspace(f.batch,f.item,new AbortController().signal),/fetch-after-clone/);
  f.item.operation!.state="not-applied";f.service.store.write(f.batch);
  await internal.prepareWorkspace(f.batch,f.item,new AbortController().signal);
  assert.equal(clones,1);assert.equal(fetches,2);assert.equal(f.item.attempts,0);assert.equal(readFileSync(join(f.path,"value.txt"),"utf8"),"original\n");assert.equal(f.item.workspace,f.path);
 }finally{await f.cleanup();}
});


test("captured mandatory checks survive repository test-script edits and are copied",async()=>{
 const f=fixture();try{
  ready(f);writeFileSync(join(f.path,"package.json"),JSON.stringify({scripts:{test:"node --test"}}));
  f.item.selected.requiredChecks=requiredChecks(f.item.selected,f.path);f.item.checkScripts=packageCheckScripts(f.path);
  writeFileSync(join(f.path,"package.json"),JSON.stringify({scripts:{test:"true"}}));
  const next=requiredChecks(f.item.selected,f.path);next.push("true");
  assert.deepEqual(f.item.selected.requiredChecks,["npm test"]);assert.notEqual(packageCheckScripts(f.path),f.item.checkScripts);
 }finally{await f.cleanup();}
});
test("changed mandatory checks block retained work without an automatic second worker attempt",async()=>{
 const f=fixture(async (_workspace, requiredExecutables) => ({available:["bash", ...requiredExecutables], missing:[], scope:"executable-presence-only"}));let workers=0;try{
  ready(f);writeFileSync(join(f.path,"package.json"),JSON.stringify({scripts:{test:"node --test"}}));
  f.item.attempts=1;f.item.selected.requiredChecks=["npm test"];f.item.checkScripts=packageCheckScripts(f.path);
  const sdk={Settings:{isolated:()=>({})},SessionManager:{create:()=>({})},AgentRegistry:class{},async createAgentSession(options:Record<string,unknown>){
   const tools=options.customTools as Array<{name:string;execute(id:string,args:unknown):Promise<unknown>}>;
   const report=tools.find(t=>t.name==="factory_report")!;const sessionFile=join(f.root,"worker-session.jsonl");writeFileSync(sessionFile,"session\n");
   const listeners=new Set<(event:{type:string})=>void>();
   return {session:{sessionFile,subscribe(fn:(event:{type:string})=>void){listeners.add(fn);return ()=>listeners.delete(fn);},async prompt(){
    workers++;for(const fn of listeners)fn({type:"turn_start"});
    writeFileSync(join(f.path,"package.json"),JSON.stringify({scripts:{test:"true"}}));
    await report.execute("worker-report",{report:"changed the captured test contract",tests:[],accepted:true,semanticOutcome:"none",predicates:[{item:"selected acceptance",ok:true,note:"worker inspected the selected subject"}],publicationBlocker:""});
   },async abort(){},async dispose(){}}};
  }};
  Object.defineProperty(f.service,"sdk",{value:sdk,writable:true});
  await f.service.resume(f.batch.id,{model:{},modelRegistry:{authStorage:{},hasConfiguredAuth:()=>true}});await f.service.waitForIdle();
  const final=f.service.store.read(f.batch.id).items[0]!;
  assert.equal(workers,1);assert.equal(final.stage,"BLOCKED");assert.match(final.blocker!,/changed the captured mandatory package test scripts/);
  assert.equal(final.workspace,f.path);assert.equal(JSON.parse(readFileSync(join(f.path,"package.json"),"utf8")).scripts.test,"true");
 }finally{await f.cleanup();}
});
test("known unprepared dependency sets block before any implementation attempt",async()=>{
 const f=fixture();try{
  ready(f);writeFileSync(join(f.path,"go.mod"),"module fixture\nrequire example.org/dependency v1.0.0\n");
  assert.throws(()=>requiredChecks(f.item.selected,f.path),/dependencies are not prepared/);
  assert.equal(f.item.attempts,0);
 }finally{await f.cleanup();}
});


test("preparation refuses a symlink parent before creating anything outside its workspace root",async()=>{
 const f=fixture();const outside=mkdtempSync(join(tmpdir(),"factory-outside-"));try{
  writeFileSync(join(outside,"sentinel"),"unchanged");symlinkSync(outside,join(f.root,"workspaces"));
  const internal=f.service as unknown as {prepareWorkspace(batch:Batch,item:BatchItem,signal:AbortSignal):Promise<string>};
  await assert.rejects(()=>internal.prepareWorkspace(f.batch,f.item,new AbortController().signal),/symlink/);
  assert.deepEqual(readdirSync(outside),["sentinel"]);assert.equal(readFileSync(join(outside,"sentinel"),"utf8"),"unchanged");
 }finally{await f.cleanup();rmSync(outside,{recursive:true,force:true});}
});


test("fetch alone receives the scoped GitHub helper and credential without ambient environment",async()=>{
 const f=fixture();const oldPath=process.env.PATH;const oldSentinel=process.env.FACTORY_UNRELATED_SECRET;
 try{
  const bin=join(f.root,"bin");mkdirSync(bin);const executable=join(bin,"git");
  writeFileSync(executable,`#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),credential:process.env.GH_TOKEN==='fixture-secret',ambient:Boolean(process.env.FACTORY_UNRELATED_SECRET)}));\n`);chmodSync(executable,0o700);
  process.env.PATH=`${bin}:${oldPath}`;process.env.FACTORY_UNRELATED_SECRET="must-not-pass";
  (f.service.github as unknown as {token:string}).token="fixture-secret";
  const internal=f.service as unknown as {git(path:string,args:string[]):Promise<string>};
  const local=JSON.parse(await internal.git(f.root,["status","--porcelain"]));
  const remote=JSON.parse(await internal.git(f.root,["fetch","origin","pull/1/head"]));
  assert.equal(local.credential,false);assert.equal(local.ambient,false);assert.equal(remote.ambient,false);assert.equal(remote.credential,true);
  assert.ok(remote.args.includes("credential.https://github.com.helper=!gh auth git-credential"));
  assert.ok(remote.args.includes("protocol.file.allow=never"));
 }finally{
  if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;
  if(oldSentinel===undefined)delete process.env.FACTORY_UNRELATED_SECRET;else process.env.FACTORY_UNRELATED_SECRET=oldSentinel;
  await f.cleanup();
 }
});
