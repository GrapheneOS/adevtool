#!/usr/bin/env bash

set -e
source build/envsetup.sh
export OFFICIAL_BUILD=true
lunch ${1}-ap2a-user
m
