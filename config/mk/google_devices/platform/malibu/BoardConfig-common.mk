include build/make/target/board/BoardConfigMainlineCommon.mk
include build/make/target/board/BoardConfigPixelCommon.mk

include vendor/adevtool/config/mk/google_devices/common/BoardConfig-armv9.mk

include vendor/adevtool/config/mk/google_devices/common/BoardConfig-common-gs201-plus.mk

BOARD_SUPER_PARTITION_SIZE := 10737418240
# Set size to BOARD_SUPER_PARTITION_SIZE - overhead (4MiB) (b/182237294)
BOARD_GOOGLE_DYNAMIC_PARTITIONS_SIZE := 10733223936
# Set error limit to BOARD_SUPER_PARTITION_SIZE - 500MB
BOARD_SUPER_PARTITION_ERROR_LIMIT := 10213130240

BOARD_PRODUCTIMAGE_FILE_SYSTEM_TYPE := erofs
BOARD_SYSTEM_DLKMIMAGE_FILE_SYSTEM_TYPE := erofs
BOARD_SYSTEM_EXTIMAGE_FILE_SYSTEM_TYPE := erofs
BOARD_SYSTEMIMAGE_FILE_SYSTEM_TYPE := erofs
BOARD_VENDOR_DLKMIMAGE_FILE_SYSTEM_TYPE := erofs
BOARD_VENDORIMAGE_FILE_SYSTEM_TYPE := erofs

SYSTEM_EXT_PUBLIC_SEPOLICY_DIRS += vendor/adevtool/config/mk/google_devices/platform/malibu/sepolicy/system_ext/public
SYSTEM_EXT_PRIVATE_SEPOLICY_DIRS += vendor/adevtool/config/mk/google_devices/platform/malibu/sepolicy/system_ext/private
