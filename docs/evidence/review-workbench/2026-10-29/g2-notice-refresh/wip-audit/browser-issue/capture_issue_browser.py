import os,signal,subprocess,fcntl,struct,json,time,gi
from pathlib import Path
gi.require_version('Gtk','4.0');gi.require_version('Vte','3.91')
from gi.repository import Gtk,Vte,GLib,Pango
root='/tmp/review-ui-audit-20261029-TopExq/final-516b289/browser-issue';snap='/tmp/review-ui-audit-20261029-TopExq/final-516b289/snapshot';sif='/home/linuxbrew/.linuxbrew/opt/review/libexec/launcher/review.sif';cols,rows=80,24;cellw,cellh=10,19;w,h=cols*cellw+2,rows*cellh+2
cmd=['/home/linuxbrew/.linuxbrew/bin/apptainer','exec','--containall','--cleanenv','--home',f'{root}/home:/home/review','--bind',f'{root}/tmp:/tmp:rw','--bind',f'{snap}/image/extension:/usr/share/review/source:ro','--bind',f'{root}/probe:/probe:rw','--env','TMPDIR=/tmp','--env','TERM=xterm-256color','--env','COLORTERM=truecolor','--env','REVIEW_MODE=review','--env','REVIEW_DEFAULT_SCOPE=fixture/review','--env','GH_TOKEN=','--env','GITHUB_TOKEN=','--env','LUNA_FACTORY_ENABLED=1','--env','LUNA_FACTORY_STATE_ROOT=/home/review/.local/state/luna-factory','--env','LUNA_FACTORY_CLAIMS_ROOT=/home/review/.local/state/review-claims',sif,'/usr/bin/omp','--profile','review-visual','--issues','--config','/usr/share/review/appliance-config.yml','--extension','/usr/share/review/luna-factory','--extension','/probe/visual-probe.ts','--no-skills','--no-rules','--no-pty','--model','local-probe/deterministic']
env=['PATH=/usr/bin:/bin:/home/linuxbrew/.linuxbrew/bin',f'HOME={root}/home',f'TMPDIR={root}/tmp','TERM=xterm-256color','COLORTERM=truecolor','GH_TOKEN=','GITHUB_TOKEN=']
Gtk.init();win=Gtk.Window(title='Review final recovery audit');win.set_resizable(False);term=Vte.Terminal.new();term.set_scrollback_lines(1000);term.set_font(Pango.FontDescription.from_string('Monospace 12'));term.set_size(cols,rows);win.set_child(term);win.set_default_size(w,h);state={'pid':None,'exited':False};loop=GLib.MainLoop()
def exited(_t,status):
 state['exited']=True;print('child_exited',status,flush=True)
 if loop.is_running():loop.quit()
term.connect('child-exited',exited);win.present();term.grab_focus();ok,pid=term.spawn_sync(Vte.PtyFlags.DEFAULT,f'{root}/home',cmd,env,GLib.SpawnFlags.DEFAULT);state['pid']=pid;print('spawned',ok,'pid',pid,'DISPLAY',os.environ.get('DISPLAY'),'VTE',term.get_column_count(),term.get_row_count(),'cell',term.get_char_width(),term.get_char_height(),flush=True)
def cap(name):
 pty=term.get_pty();ws=struct.unpack('HHHH',fcntl.ioctl(pty.get_fd(),0x5413,struct.pack('HHHH',0,0,0,0)));g={'file':name,'timestamp':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'target':[cols,rows],'vte':[term.get_column_count(),term.get_row_count()],'pty_ioctl':[ws[1],ws[0]],'cell_px':[term.get_char_width(),term.get_char_height()],'alloc_px':[term.get_allocated_width(),term.get_allocated_height()]};Path(f'{root}/geometry.jsonl').open('a').write(json.dumps(g)+'\n');print('geometry',g,flush=True)
 if g['vte']!=[cols,rows] or g['pty_ioctl']!=[cols,rows]:raise RuntimeError(f'geometry mismatch {g}')
 path=f'{root}/screenshots/{name}';subprocess.run(['/usr/bin/ffmpeg','-nostdin','-loglevel','error','-f','x11grab','-video_size',f'{w}x{h}','-i',os.environ['DISPLAY'],'-frames:v','1','-y',path],check=True)
 try:
  visible=term.get_text_format(Vte.Format.TEXT)
  Path(f'{root}/text/{name}.txt').parent.mkdir(parents=True,exist_ok=True)
  Path(f'{root}/text/{name}.txt').write_text(visible or '')
 except Exception as e: print('text_capture_error',repr(e),flush=True)
 print('capture',path,flush=True)
def feed(data,label):term.feed_child(data);print('input',label,flush=True)
def at(ms,label,fn):
 def run():print('event',label,flush=True);fn();return GLib.SOURCE_REMOVE
 GLib.timeout_add(ms,run)
def exit_app():
 print('event graceful /exit',flush=True);term.feed_child(b'/exit\r');return GLib.SOURCE_REMOVE
def stop():
 print('event stop isolated process',flush=True);term.feed_child(b'\x03');GLib.timeout_add(900,loop.quit);return GLib.SOURCE_REMOVE
at(4200,'baseline dashboard',lambda:cap('01-issue-dashboard-baseline.png'))
at(5400,'close dashboard',lambda:feed(b'q','q'))
at(6500,'type an unfinished PR review draft',lambda:feed(b'Unsent PR review notes must remain here.','draft text'))
at(8200,'editor draft before browser action',lambda:cap('02-issue-editor-draft-before.png'))
at(9300,'open dashboard',lambda:feed(b'\x1bb','Alt+B'))
at(11000,'dashboard with fixture PR',lambda:cap('03-dashboard-issue.png'))
at(11900,'open PR reader',lambda:feed(b'v','v'))
at(14100,'reader before browser action',lambda:cap('04-issue-reader-before-browser.png'))
at(14800,'open browser failure through production handler',lambda:feed(b'o','o'))
at(16900,'browser warning and link draft',lambda:cap('05-issue-browser-warning-reader.png'))
at(17800,'close reader',lambda:feed(b'q','q'))
at(18600,'close dashboard',lambda:feed(b'q','q'))
at(20400,'editor draft after browser failure',lambda:cap('06-issue-editor-draft-after.png'))
at(21900,'stop',stop)
loop.run();win.destroy()
