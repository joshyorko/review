#!/usr/bin/env bash
# Stage the Fedora runtime closure for the review appliance.
#
# Runs inside the shell-enabled Fedora builder and copies an explicit allowlist of
# binaries plus the shared libraries they actually resolve into a rootfs tree the
# final distroless stage overlays. Nothing here installs a package: the image is
# assembled from named files, so its contents are the allowlist and nothing else.
#
# Two binaries earn their place:
#   bash — omp's `bash` tool spawns a shell; without one the agent cannot run gh.
#   git  — the fix and land paths patch code and push it.
set -euo pipefail

dest="${1:?usage: stage-runtime <destdir>}"
shift

# Executables copied verbatim into /usr/bin.
#
# bash and git are the load-bearing pair: omp's `bash` tool spawns a shell, and
# the fix and land paths patch code and push it. The rest is the handful of
# utilities that every shell one-liner an agent writes assumes exists. The
# distroless base no longer supplies coreutils, so stage those commands from
# the same pinned builder as bash and git.
python3_real="$(command -v python3 || true)"
[[ -n "$python3_real" ]] && python3_real="$(readlink -f "$python3_real")"
python3_ver=""
if [[ -n "$python3_real" && -x "$python3_real" ]]; then
  python3_ver="$("$python3_real" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || true)"
fi

binaries=(
  /usr/bin/basename
  /usr/bin/cat
  /usr/bin/chmod
  /usr/bin/cp
  /usr/bin/cut
  /usr/bin/date
  /usr/bin/dirname
  /usr/bin/env
  /usr/bin/head
  /usr/bin/id
  /usr/bin/install
  /usr/bin/ln
  /usr/bin/ls
  /usr/bin/mkdir
  /usr/bin/mktemp
  /usr/bin/mv
  /usr/bin/pwd
  /usr/bin/readlink
  /usr/bin/realpath
  /usr/bin/rm
  /usr/bin/rmdir
  /usr/bin/sha256sum
  /usr/bin/sha512sum
  /usr/bin/sleep
  /usr/bin/sort
  /usr/bin/stat
  /usr/bin/tail
  /usr/bin/tee
  /usr/bin/timeout
  /usr/bin/touch
  /usr/bin/tr
  /usr/bin/uname
  /usr/bin/wc
  /usr/bin/bash
  /usr/bin/git
  /usr/bin/curl
  /usr/bin/diff
  /usr/bin/find
  /usr/bin/gawk
  /usr/bin/grep
  /usr/bin/gzip
  /usr/bin/less
  /usr/bin/ldd
  /usr/bin/sed
  /usr/bin/tar
  /usr/bin/xargs
)
if [[ -n "$python3_real" && -x "$python3_real" ]]; then
  binaries+=("$python3_real")
fi
if [[ ! -x /usr/bin/bwrap ]]; then
  echo "stage-runtime: /usr/bin/bwrap is required from the pinned Fedora builder; no substitute is permitted" >&2
  exit 1
fi
binaries+=(/usr/bin/bwrap)

# Callers may name additional absolute executables after the destination. Their
# ELF closures are staged by the same ldd path as the appliance's fixed base.
for binary in "$@"; do
  [[ "$binary" == /* ]] || {
    echo "stage-runtime: extra executable must be absolute: $binary" >&2
    exit 1
  }
  binaries+=("$binary")
done

# git's helpers live on GIT_EXEC_PATH. Keep the HTTPS remote helper for GitHub
# and upload-pack for local bare clones used by the packaged Factory workflow.
helpers=(
  /usr/libexec/git-core/git-remote-http
  /usr/libexec/git-core/git-upload-pack
)

# Libraries the distroless base already ships as part of its own glibc. Copying
# a second copy of the loader's core over itself is how a container starts
# failing in ways that look like corruption.

# Copy every library an ELF binary resolves, under its soname. ldd reports the
# path the loader picked, which is what has to exist in the final image; naming
# the copy after the soname keeps that resolution working without dragging the
# whole symlink chain along.
stage_libraries() {
  local binary="$1" soname resolved
  while read -r soname _arrow resolved _address; do
    [[ "$soname" == linux-vdso.so.* ]] && continue
    # ldd prints the loader itself without a "=>" arrow.
    if [[ -z "${resolved:-}" || "$resolved" != /* ]]; then
      [[ "$soname" == /* ]] || continue
      resolved="$soname"
      soname="$(basename "$soname")"
    fi
    [[ -e "$resolved" ]] || continue
    local libdir target
    resolved="$(readlink -f "$resolved")"
    libdir="$(dirname "$resolved")"
    target="${dest}${libdir}/${soname}"
    [[ -e "$target" ]] && continue
    install -D -m 0755 "$resolved" "$target"
  done < <(ldd "$binary" 2>/dev/null || true)
}

install -d -m 0755 "${dest}/usr/bin" "${dest}/usr/libexec/git-core"

for binary in "${binaries[@]}" "${helpers[@]}"; do
  [[ -x "$binary" ]] || {
    echo "stage-runtime: missing $binary" >&2
    exit 1
  }
done

for binary in "${binaries[@]}"; do
  install -m 0755 "$binary" "${dest}/usr/bin/$(basename "$binary")"
  stage_libraries "$binary"
done

for helper in "${helpers[@]}"; do
  install -m 0755 "$helper" "${dest}/usr/libexec/git-core/$(basename "$helper")"
  stage_libraries "$helper"
done

# git dispatches to `git-remote-https` by name; upstream ships it as a link to
# the same binary rather than a second copy.
ln -sf git-remote-http "${dest}/usr/libexec/git-core/git-remote-https"

# /bin is a symlink to /usr/bin in this base, so one link covers every caller
# that hardcodes /bin/sh.
ln -sf bash "${dest}/usr/bin/sh"

# `awk` is spelled that way in every script ever written.
ln -sf gawk "${dest}/usr/bin/awk"
if [[ -n "$python3_real" && -x "$python3_real" ]]; then
  ln -sf "$(basename "$python3_real")" "${dest}/usr/bin/python3"
  ln -sf "$(basename "$python3_real")" "${dest}/usr/bin/python"
  for python_libdir in "/usr/lib/python${python3_ver}" "/usr/lib64/python${python3_ver}"; do
    [[ -d "$python_libdir" ]] || continue
    install -d -m 0755 "${dest}$(dirname "$python_libdir")"
    cp -a "$python_libdir" "${dest}${python_libdir}"
    rm -rf "${dest}${python_libdir}/test" "${dest}${python_libdir}/idlelib" \
      "${dest}${python_libdir}/tkinter" "${dest}${python_libdir}/turtle"*
    find "${dest}${python_libdir}" -type d -name __pycache__ -exec rm -rf {} +
    while IFS= read -r -d '' so; do
      stage_libraries "$so"
    done < <(find "${dest}${python_libdir}" -type f -name '*.so' -print0)
  done
fi

# git init warns on every invocation without its template directory, and a tool
# that greets the maintainer with a warning it cannot act on is noise.
if [[ -d /usr/share/git-core/templates ]]; then
  install -d -m 0755 "${dest}/usr/share/git-core"
  cp -a /usr/share/git-core/templates "${dest}/usr/share/git-core/templates"
fi

printf 'staged %s binaries, %s libraries\n' \
  "$((${#binaries[@]} + ${#helpers[@]}))" \
  "$(find "${dest}/usr/lib" -type f -name '*.so*' 2>/dev/null | wc -l)"

# Scratch has no filesystem layout, trust anchors, timezone or terminal data.
ln -s usr/bin "${dest}/bin"
ln -s usr/lib64 "${dest}/lib64"
ln -s usr/lib "${dest}/lib"
for tree in /etc/pki /usr/share/pki /usr/share/zoneinfo /usr/share/terminfo /usr/share/licenses; do
  if [[ -d "$tree" ]]; then
    install -d "${dest}$(dirname "$tree")"
    cp -a "$tree" "${dest}$(dirname "$tree")/"
  fi
done
for config in /etc/nsswitch.conf /etc/hosts /etc/resolv.conf; do
  [[ ! -f "$config" ]] || install -D -m 0644 "$config" "${dest}${config}"
done
# Native OMP and GitHub CLI may resolve libraries beyond the shell closure.
for binary in "${dest}/usr/bin/omp" "${dest}/usr/bin/gh" "${dest}/usr/bin/rtk"; do
  stage_libraries "$binary"
done
