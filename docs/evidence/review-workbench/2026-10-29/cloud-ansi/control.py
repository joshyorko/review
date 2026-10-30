import base64, json, sys, time
from pathlib import Path

run = Path(sys.argv[1])
actions = json.loads(sys.stdin.read())
keys = {'<ESC>': '\x1b', '<ALT-B>': '\x1bb', '<RIGHT>': '\x1b[C',
        '<DOWN>': '\x1b[B', '<UP>': '\x1b[A', '<TAB>': '\t', '<ENTER>': '\r'}
for action in actions:
    if 'input' in action:
        value = action['input']
        for key, data in keys.items():
            value = value.replace(key, data)
        command = {'action': 'input', 'data': base64.b64encode(value.encode()).decode(),
                   'label': action.get('label', action['input'])}
    elif 'capture' in action:
        command = {'action': 'capture', 'name': action['capture']}
    elif 'quit' in action:
        command = {'action': 'quit'}
    else:
        raise ValueError(action)
    with (run / 'commands.jsonl').open('a') as f:
        f.write(json.dumps(command) + '\n')
    time.sleep(action.get('wait', .35))
    if 'capture' in action:
        path = run / 'screenshots' / action['capture']
        until = time.monotonic() + 8
        while not path.exists() and time.monotonic() < until:
            time.sleep(.1)
        if not path.exists():
            raise RuntimeError(f'capture missing: {path}')
        print(path, flush=True)
