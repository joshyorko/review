#!/usr/bin/env bash
# Compatibility source for Just recipes. bin/bluefin is the standalone application
# and the single implementation of launcher behavior.
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../bin/bluefin
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bin/bluefin"
