#!/usr/bin/env bash

set -e
LZ4=$1
TOYBOX=$2
INPUT=$3
OUTPUT_DIR=$4

cd $OUTPUT_DIR

$LZ4 -d < $INPUT | $TOYBOX cpio --no-preserve-owner -i
