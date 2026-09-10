kind: oci

description: |
  Project Bluefin Review Appliance built with BuildStream (bst).
  Packages omp (Oh My Pi), GitHub CLI, and the Bluefin Review & Issues extension
  with the lower-third dashboard widget.

sources:
  - kind: local
    path: image/extension/bluefin-review.ts
    directory: /opt/bluefin/extensions
  - kind: local
    path: image/harness/omp.py
    directory: /opt/bluefin/harness

build-depends:
  - components/nodejs.bst
  - components/bun.bst

depends:
  - components/omp.bst
  - components/gh.bst
  - components/git.bst
  - components/tui-fonts.bst

config:
  entrypoint:
    - /usr/local/bin/omp-review
  env:
    PI_EXTENSIONS: /opt/bluefin/extensions/bluefin-review.ts
    BLUEFIN_REVIEW_MODE: dashboard
    TERM: xterm-256color
  labels:
    io.projectbluefin.review.appliance: "true"
    io.projectbluefin.review.harness: "omp"
