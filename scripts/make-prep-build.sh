#!/usr/bin/env bash

set -e
source build/envsetup.sh
export OFFICIAL_BUILD=true
# Equivalent to 2025-06-29 12:00 UTC+0
export BUILD_DATETIME=1751155200
export BUILD_NUMBER=2025062900
lunch ${1}-cur-user
m
