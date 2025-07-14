#!/usr/bin/env bash

set -e
export ANDROID_QUIET_BUILD=true
export OUT_DIR=$2
source build/envsetup.sh
lunch ${1}
m "${@:3}"
