AB_OTA_POSTINSTALL_CONFIG += \
	RUN_POSTINSTALL_system=true \
	POSTINSTALL_PATH_system=system/bin/otapreopt_script \
	FILESYSTEM_TYPE_system=ext4 \
POSTINSTALL_OPTIONAL_system=true

# Set Vendor SPL to match platform
VENDOR_SECURITY_PATCH = $(PLATFORM_SECURITY_PATCH)

# Set boot SPL
BOOT_SECURITY_PATCH = $(PLATFORM_SECURITY_PATCH)

LOCAL_KERNEL := $(TARGET_KERNEL_DIR)/Image.lz4

# Enforce the Product interface
PRODUCT_PRODUCT_VNDK_VERSION := current
PRODUCT_ENFORCE_PRODUCT_PARTITION_INTERFACE := true

TARGET_USES_VULKAN = true

# Init files
PRODUCT_COPY_FILES += \
	$(LOCAL_KERNEL):kernel

# Insmod config files
PRODUCT_COPY_FILES += \
	$(call find-copy-subdir-files,init.insmod.*.cfg,$(TARGET_KERNEL_DIR),$(TARGET_COPY_OUT_VENDOR_DLKM)/etc)

# For creating dtbo image
PRODUCT_HOST_PACKAGES += \
	mkdtimg

# Enable project quotas and casefolding for emulated storage without sdcardfs
$(call inherit-product, $(SRC_TARGET_DIR)/product/emulated_storage.mk)

# Enforce generic ramdisk allow list
$(call inherit-product, $(SRC_TARGET_DIR)/product/generic_ramdisk.mk)

# use the Natural display color mode by default
PRODUCT_PROPERTY_OVERRIDES += \
	persist.sys.sf.color_saturation=1.0

PRODUCT_CHARACTERISTICS := nosdcard

WIFI_PRIV_CMD_UPDATE_MBO_CELL_STATUS := enabled

# Trusty (KM, GK, Storage)
$(call inherit-product, system/core/trusty/trusty-storage.mk)
$(call inherit-product, system/core/trusty/trusty-base.mk)

PRODUCT_USE_DYNAMIC_PARTITIONS := true

SIM_COUNT := 2

# pKVM
$(call inherit-product, packages/modules/Virtualization/apex/product_packages.mk)
PRODUCT_BUILD_PVMFW_IMAGE := true

PRODUCT_COPY_FILES += \
      vendor/adevtool/config/mk/google_devices/common/init.pixel.grapheneos.rc:$(TARGET_COPY_OUT_VENDOR)/etc/init/init.pixel.grapheneos.rc

ifneq ($(BOARD_WITHOUT_RADIO),true)
    PRODUCT_PACKAGES += CarrierConfig2 GosTelephonyProviderOverlay GosTelephonyOverlay
endif

# lynx uses Qualcomm wlan.ko, and tangorpro uses synadhd.ko. This helper only
# drives the Broadcom DHD induce_error iovar used by the other Pixel Wi-Fi drivers.
ifeq ($(filter lynx tangorpro,$(TARGET_PRODUCT)),)
    PRODUCT_PACKAGES_DEBUG += gos-dhdutil
endif

PRODUCT_PACKAGES += restrict-pixel-health-association
