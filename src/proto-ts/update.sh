#!/bin/bash

set -o errexit -o nounset -o pipefail

protoc --plugin=vendor/adevtool/node_modules/.bin/protoc-gen-ts_proto --ts_proto_out vendor/adevtool/src/proto-ts \
    build/make/tools/aconfig/aconfig_protos/protos/aconfig.proto \
    build/soong/linkerconfig/proto/linker_config.proto \
    frameworks/base/tools/aapt2/BriefPackageInfo.proto \
    packages/apps/CarrierConfig2/src/com/google/carrier/carrier_{settings,list}.proto \
    packages/modules/common/proto/classpaths.proto
    #frameworks/base/proto/src/apk_parser_config.proto

protoc --plugin=vendor/adevtool/node_modules/.bin/protoc-gen-ts_proto --ts_proto_out vendor/adevtool/src/proto-ts \
    vendor/adevtool/assets/request.proto

protoc --plugin=vendor/adevtool/node_modules/.bin/protoc-gen-ts_proto --ts_proto_out vendor/adevtool/src/proto-ts \
    vendor/adevtool/assets/response.proto
