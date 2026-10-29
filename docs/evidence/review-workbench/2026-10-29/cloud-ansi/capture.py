#!/usr/bin/python3
"""Drive a real GTK4 VTE/OMP audit through a small local command journal."""
import base64
import fcntl
import json
import os
from pathlib import Path
import signal
import struct
import subprocess
import sys
import time

import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Vte', '3.91')
gi.require_version('GdkX11', '4.0')
from gi.repository import Gtk, Vte, GLib, Pango, GdkX11

root = Path(sys.argv[1]).resolve()
cols, rows = map(int, sys.argv[2].split('x'))
argv = json.loads((root / 'argv.json').read_text())
child_env = json.loads((root / 'child-env.json').read_text())
commands = root / 'commands.jsonl'
commands.touch(exist_ok=True)
(root / 'screenshots').mkdir(exist_ok=True)
(root / 'text').mkdir(exist_ok=True)
Gtk.init()
win = Gtk.Window(title=f'PR94 actual ANSI audit {cols}x{rows}')
win.set_decorated(False)
win.set_resizable(False)
term = Vte.Terminal.new()
term.set_scrollback_lines(2000)
term.set_font(Pango.FontDescription.from_string('DejaVu Sans Mono 12'))
term.set_size(cols, rows)
win.set_child(term)
win.set_default_size(cols * 10 + 2, rows * 19 + 2)
loop = GLib.MainLoop()
state = {'offset': 0, 'child_exited': False}

def record(value):
    value['timestamp'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    with (root / 'events.jsonl').open('a') as f:
        f.write(json.dumps(value) + '\n')
    print(json.dumps(value), flush=True)

def child_exited(_term, status):
    state['child_exited'] = True
    record({'event': 'child-exited', 'status': status})

term.connect('child-exited', child_exited)
win.present()
term.grab_focus()
ok, pid = term.spawn_sync(Vte.PtyFlags.DEFAULT, str(root / 'work'), argv,
    [f'{k}={v}' for k, v in child_env.items()], GLib.SpawnFlags.DEFAULT)
record({'event': 'spawn', 'ok': ok, 'pid': pid, 'argv': argv})

def capture(name):
    if Path(name).name != name or not name.endswith('.png'):
        raise ValueError('capture needs a plain .png filename')
    fd = term.get_pty().get_fd()
    ws = struct.unpack('HHHH', fcntl.ioctl(fd, 0x5413, struct.pack('HHHH', 0, 0, 0, 0)))
    g = {'file': name, 'target': [cols, rows],
         'vte': [term.get_column_count(), term.get_row_count()],
         'pty_ioctl': [ws[1], ws[0]],
         'cell_px': [term.get_char_width(), term.get_char_height()],
         'alloc_px': [term.get_allocated_width(), term.get_allocated_height()]}
    if g['vte'] != [cols, rows] or g['pty_ioctl'] != [cols, rows]:
        raise RuntimeError(f'capture rejected: geometry mismatch {g}')
    path = root / 'screenshots' / name
    if path.exists():
        raise RuntimeError('capture names are immutable; choose a fresh name')
    g['window_xid'] = win.get_surface().get_xid()
    subprocess.run(['/usr/bin/import', '-display', os.environ['DISPLAY'],
        '-window', str(g['window_xid']), str(path)], check=True, timeout=8)
    (root / 'text' / (name + '.txt')).write_text(term.get_text_format(Vte.Format.TEXT) or '')
    with (root / 'geometry.jsonl').open('a') as f:
        f.write(json.dumps(g) + '\n')
    record({'event': 'capture', **g})

def poll():
    try:
        with commands.open() as f:
            f.seek(state['offset'])
            for line in f:
                command = json.loads(line)
                if command['action'] == 'input':
                    term.feed_child(base64.b64decode(command['data']))
                    record({'event': 'input', 'label': command.get('label', '')})
                elif command['action'] == 'capture':
                    capture(command['name'])
                elif command['action'] == 'quit':
                    loop.quit()
                else:
                    raise ValueError('unknown action')
            state['offset'] = f.tell()
    except Exception as error:
        record({'event': 'driver-error', 'error': repr(error)})
        loop.quit()
        return GLib.SOURCE_REMOVE
    return GLib.SOURCE_CONTINUE

GLib.timeout_add(100, poll)
loop.run()
if not state['child_exited']:
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
win.destroy()
