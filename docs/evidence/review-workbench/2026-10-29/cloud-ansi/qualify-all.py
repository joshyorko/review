from pathlib import Path
import json,subprocess,time
root=Path(__file__).parent
flows=[('qualified-100x32','100x32','recovery','recovery-actions.json'),('qualified-80x24','80x24','recovery','recovery-actions.json'),('qualified-browser-100x32','100x32','browser','browser-actions.json'),('qualified-browser-80x24','80x24','browser','browser-actions.json'),('qualified-failures-100x32','100x32','failures','failures-actions.json'),('qualified-failures-80x24','80x24','failures','failures-actions.json'),('qualified-factory-100x32','100x32','factory-missing','factory-actions.json'),('qualified-factory-80x24','80x24','factory-missing','factory-actions.json')]
for index,(name,size,scenario,actions) in enumerate(flows):
 process=None
 if index:
  process=subprocess.Popen(['bash',str(root/'start-capture.sh'),name,size,scenario])
  time.sleep(10)
 ready=[{'capture':'00-ready-check.png'}]
 subprocess.run(['python3',str(root/'control.py'),str(root/name)],input=json.dumps(ready),text=True,check=True)
 text=(root/name/'text/00-ready-check.png.txt').read_text()
 if '1/1' not in text or 'WORKBENCH' not in text:
  raise RuntimeError('queue not ready; stop audit '+name)
 subprocess.run(['python3',str(root/'control.py'),str(root/name)],stdin=(root/actions).open(),check=True)
 if process:process.wait(timeout=10)
 print('FLOW COMPLETE '+name,flush=True)
