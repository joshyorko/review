from pathlib import Path
import json, os, shutil, sys, yaml

root = Path(__file__).parent
source = root / 'final-source'
name, scenario = sys.argv[1:3]
run = root / name
run.mkdir()
for directory in ['home', 'work', 'probe', 'tmp']:
    (run / directory).mkdir()
agent = run / 'home/.omp/profiles/review-visual/agent'
agent.mkdir(parents=True)
shutil.copyfile(source / 'tests/fixtures/luna-factory-omp-probe-models.yml', agent / 'models.yml')
config = yaml.safe_load((source / 'image/appliance/config.yml').read_text())
probe_config = yaml.safe_load((source / 'tests/fixtures/luna-factory-omp-probe-config.yml').read_text())
for key, value in probe_config.items():
    if isinstance(value, dict) and isinstance(config.get(key), dict):
        config[key].update(value)
    else:
        config[key] = value
config['startup'] = {'checkUpdate': False, 'setupWizard': False}
if scenario in ['recovery', 'pilot']:
    config['task'].pop('structured', None)
else:
    config['task']['structured'] = True
(run / 'config.yml').write_text(yaml.safe_dump(config, sort_keys=False))
probe = (source / 'docs/evidence/review-workbench/2026-10-29/g2-notice-refresh/wip-audit/normal-final/probe/visual-probe.ts').read_text()
probe = probe.replace('/usr/share/review/source', str(source / 'image/extension')).replace('/probe/', str(run / 'probe') + '/')
probe = probe.replace('async function fixtureFetch(url, init) {', '''async function fixtureFetch(url, init) {
  const target = new URL(String(url));
  if (target.pathname === "/repos/fixture/review/pulls/42/files") {
    return new Response(JSON.stringify([{filename:"README.md",status:"modified",additions:1,deletions:0,patch:"@@ -1 +1,2 @@\\n # Review\\n+Fixture visual evidence"}]), {status:200});
  }
  if (target.pathname === "/repos/fixture/review/pulls/42") {
    return new Response(JSON.stringify({number:42,title:reviewPr.title,body:"Deterministic PR fixture; no live GitHub request.",html_url:reviewPr.url,user:{login:"fixture"},head:{sha:reviewPr.headRefOid},base:{sha:"b".repeat(40)},changed_files:1}), {status:200});
  }
  if (target.pathname.endsWith("/comments") || target.pathname.endsWith("/reviews") || target.pathname.endsWith("/timeline")) {
    return new Response("[]", {status:200});
  }
  if (target.pathname === "/repos/fixture/review/issues/42") {
    return new Response(JSON.stringify({number:42,title:"fixture: browser issue",body:"Deterministic issue fixture; no live GitHub request.",html_url:"https://github.com/fixture/review/issues/42",user:{login:"fixture"},labels:[],state:"open",created_at:new Date().toISOString()}), {status:200});
  }''')
probe = probe.replace('  const execute = pi.exec.bind(pi);', '''
  pi.registerCommand("visual-arm-dashboard-failure", {
    description: "Reject one native custom UI call for the audit",
    handler: (_args, ctx) => {
      const custom = ctx.ui.custom.bind(ctx.ui);
      let rejectOnce = true;
      ctx.ui.custom = (...args) => {
        if (rejectOnce) {
          rejectOnce = false;
          return Promise.reject(new Error("fixture native dashboard opening failure"));
        }
        return custom(...args);
      };
    },
  });
  const execute = pi.exec.bind(pi);''')
probe = probe.replace('  const sendUserMessage = pi.sendUserMessage.bind(pi);', '')
# Record the actual editor state through OMP's public UI API, without editing it.
probe = probe.replace('  const appendEntry = pi.appendEntry.bind(pi);', f'''
  pi.registerCommand("visual-record-draft", {{
    description: "Record the current editor draft without changing it",
    handler: (_args, ctx) => {{
      appendFileSync({json.dumps(str(run / 'probe/draft-inspections.jsonl'))}, JSON.stringify({{draft: ctx.ui.getEditorText?.() ?? null}}) + "\\n");
    }},
  }});
  const appendEntry = pi.appendEntry.bind(pi);''')
(run / 'probe/visual-probe.ts').write_text(probe)
bun = '/workspace/.review-dev/visual-install/bun/bun-linux-x64-baseline/bun'
argv = [bun, str(root / 'omp-lifecycle/packages/coding-agent/src/cli.ts'),
        '--profile', 'review-visual', '--cwd', str(run / 'work'),
        '--config', str(run / 'config.yml')]
if scenario != 'factory-missing':
    argv += ['--extension', str(source / 'image/extension/luna-factory')]
argv += ['--extension', str(run / 'probe/visual-probe.ts'), '--no-skills', '--no-rules',
         '--no-context-files', '--no-lsp', '--no-title', '--no-pty', '--model', 'local-probe/deterministic']
(run / 'argv.json').write_text(json.dumps(argv, indent=2) + '\n')
env = {k: os.environ[k] for k in ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'] if k in os.environ}
env.update({'PATH': str(Path(bun).parent) + ':/workspace/.review-dev/tools/node_modules/.bin:/usr/bin:/bin',
    'HOME': str(run / 'home'), 'XDG_CONFIG_HOME': str(run / 'home/.config'),
    'XDG_STATE_HOME': str(run / 'home/.local/state'), 'XDG_CACHE_HOME': str(run / 'home/.cache'),
    'TMPDIR': str(run / 'tmp'), 'TERM': 'xterm-256color', 'COLORTERM': 'truecolor',
    'GH_TOKEN': '', 'GITHUB_TOKEN': '', 'REVIEW_MODE': 'review', 'REVIEW_DEFAULT_SCOPE': 'fixture/review',
    'LUNA_FACTORY_ENABLED': '1', 'LUNA_FACTORY_STATE_ROOT': str(run / 'home/.local/state/luna-factory'),
    'LUNA_FACTORY_CLAIMS_ROOT': str(run / 'home/.local/state/review-claims')})
(run / 'child-env.json').write_text(json.dumps(env))
(run / 'run.json').write_text(json.dumps({'scenario': scenario, 'source_sha': '369957ec05c9647685256627f4df37a2d647d364',
    'fresh_home_before_spawn': not any((run / 'home/.local').glob('*')),
    'real_omp': '18.13.3 pinned source plus shipped session-lifecycle.patch, existing SDK dependencies; not packaged SIF', 'model_handoffs': 'intercepted before provider calls'}, indent=2) + '\n')
print(run)
