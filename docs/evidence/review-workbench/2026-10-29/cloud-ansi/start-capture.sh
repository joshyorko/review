#!/bin/bash
set -eu
root=/tmp/pr94-ansi-1di33tyt
/workspace/.review-dev/venv/bin/python "$root/setup-run.py" "$1" "$3"
export DISPLAY=:82 GSK_RENDERER=cairo XDG_CACHE_HOME="$root/driver-cache"
export GI_TYPELIB_PATH=/workspace/.review-dev/visual-install/root/usr/lib/x86_64-linux-gnu/girepository-1.0
export LD_LIBRARY_PATH=/workspace/.review-dev/visual-install/root/usr/lib/x86_64-linux-gnu
export XDG_DATA_DIRS=/workspace/.review-dev/visual-install/root/usr/share:/usr/share
export GSETTINGS_SCHEMA_DIR=/workspace/.review-dev/visual-install/root/usr/share/glib-2.0/schemas
/usr/bin/python3 "$root/capture.py" "$root/$1" "$2" > "$root/$1/driver.log" 2>&1
