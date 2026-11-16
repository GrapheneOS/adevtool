$(call inherit-product, vendor/adevtool/config/mk/google_devices/platform/gs101/product-common.mk)

$(call soong_config_set,grapheneos,framework_res_id_map,cp3a)

TARGET_KERNEL_DIR ?= $(RELEASE_KERNEL_RAVEN_DIR)
TARGET_BOARD_KERNEL_HEADERS ?= $(RELEASE_KERNEL_RAVEN_DIR)/kernel-headers

include vendor/adevtool/config/mk/google_devices/platform/gs101/device.mk
