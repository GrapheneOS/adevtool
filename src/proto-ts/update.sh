#!/bin/bash

set -o errexit -o nounset -o pipefail

protoc --plugin=vendor/adevtool/node_modules/.bin/protoc-gen-ts_proto --ts_proto_out vendor/adevtool/src/proto-ts \
    build/make/tools/aconfig/aconfig_protos/protos/aconfig.proto \
    build/soong/linkerconfig/proto/linker_config.proto \
    frameworks/base/tools/aapt2/BriefPackageInfo.proto \
    packages/apps/CarrierConfig2/src/com/google/carrier/carrier_{settings,list}.proto \
    packages/modules/common/proto/classpaths.proto \
    system/apex/proto/apex_manifest.proto
    #frameworks/base/proto/src/apk_parser_config.proto

protoc --plugin=vendor/adevtool/node_modules/.bin/protoc-gen-ts_proto --ts_proto_out vendor/adevtool/src/proto-ts \
    vendor/adevtool/assets/request.proto

protoc --plugin=vendor/adevtool/node_modules/.bin/protoc-gen-ts_proto --ts_proto_out vendor/adevtool/src/proto-ts \
    vendor/adevtool/assets/response.proto

# forceLong=string is required for checkin.proto: the response carries `android_id` (fixed64) and
# `security_token` (fixed64) which exceed Number.MAX_SAFE_INTEGER (2^53). Without forceLong=string
# the generated `CheckinResponse.decode()` calls longToNumber() and throws "Value is larger than
# Number.MAX_SAFE_INTEGER"
#
# noDefaultsForOptionals=true is required because the live checkin server distinguishes absent field
# from "field explicitly equals default", and rejects requests where default-valued scalars (e.g.
# `current_android_id: 0`, `has_hard_keyboard: false`) get stripped from the wire. ts-proto README
# says,
#
# > With `--ts_proto_opt=noDefaultsForOptionals=true``, `undefined`` primitive values will not be
# > defaulted as per the protobuf spec. Additionally unlike the standard behavior, when a field is
# > set to its standard default value, it will be encoded allowing it to be sent over the wire and
# > distinguished from undefined values. For example if a message does not set a boolean value,
# > ordinarily this would be defaulted to `false` which is different to it being undefined.
protoc --plugin=vendor/adevtool/node_modules/.bin/protoc-gen-ts_proto \
    --ts_proto_opt=forceLong=string,noDefaultsForOptionals=true \
    --ts_proto_out vendor/adevtool/src/proto-ts \
    vendor/adevtool/assets/checkin.proto
