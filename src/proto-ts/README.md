To update carrier config related protos, run
`protoc --plugin=vendor/adevtool/node_modules/.bin/protoc-gen-ts_proto --ts_proto_out vendor/adevtool/src/proto-ts packages/apps/CarrierConfig2/src/com/google/carrier/carrier_{settings,list}.proto`
