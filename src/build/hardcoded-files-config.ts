export interface BackportConfig {
    // The newer build ID where the backports are sourced from
    sourceBuildId: string,
    replaceFiles: string[],
    newFiles?: string[]
}

// Find differences with e.g. for cheetah,
//  diff -rq cheetah-BP1A.250505.005.B1/ cheetah-BP2A.250605.031.A2/ | grep -i ril
export const android16filesforpixels: Record<string, BackportConfig> = {
    "tegu": {
        sourceBuildId: "BP2A.250605.031.A2",
        replaceFiles: [
            'vendor/firmware/brcm/BCM.hcd', // Bluetooth firmware
            'vendor/firmware/brcm/BTFW_B.hcd', // Bluetooth firmware
            'vendor/firmware/fw_bcmdhd.bin', // WiFi firmware
            'vendor/firmware/fw_bcmdhd.bin_4383_a3', // WiFi firmware
            'vendor/firmware/fw_bcmdhd.map', // WiFi firmware
            'vendor/firmware/fw_bcmdhd.map_4383_a3', // WiFi firmware
            'vendor/firmware/google/edgetpu-rio.fw', // TPU
            'vendor/firmware/google/gxp-callisto.fw', // TPU
            'vendor/firmware/gxp_callisto_fw_core0', // TPU
            'vendor/firmware/gxp_callisto_fw_core1', // TPU
            'vendor/firmware/gxp_callisto_fw_core2', // TPU

            'system_ext/priv-app/ril-extension/ril-extension.apk',
            'vendor/bin/hw/rild_exynos',
            'vendor/lib64/libgooglerilmemmonitor.so', // used by rild_exynos
            'vendor/lib64/libgril_oem-google.so',
            'vendor/lib64/libril-aidl.so', // used by rild_exynos
            'vendor/lib64/libril_gfeature.so', // used by rild_exynos
            'vendor/lib64/libril_sitril.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.oemservice@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.oemservice-V1-ndk.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal-V1-ndk.so', // used by rild_exynos
            'system_ext/priv-app/OemRilService/OemRilService.apk',
            'system_ext/app/OemRilHookService/OemRilHookService.apk',
            'system_ext/framework/google-ril.jar',
            'system_ext/framework/oemrilhook.jar',
            'system_ext/priv-app/ShannonIms/ShannonIms.apk',
            'system_ext/priv-app/ShannonRcs/ShannonRcs.apk',
        ],
        newFiles: [
        ],
    },
    "comet": {
        sourceBuildId: "BP2A.250605.031.A3",
        replaceFiles: [
            'vendor/firmware/brcm/BCM_200.hcd', // Bluetooth firmware
            'vendor/firmware/fw_bcmdhd.bin_4390_b1', // WiFi firmware
            'vendor/firmware/fw_bcmdhd.map_4390_b1', // WiFi firmware
            'vendor/firmware/google/edgetpu-rio.fw', // TPU
            'vendor/firmware/google/gxp-callisto.fw', // TPU
            'vendor/firmware/gxp_callisto_fw_core0', // TPU
            'vendor/firmware/gxp_callisto_fw_core1', // TPU
            'vendor/firmware/gxp_callisto_fw_core2', // TPU

            'system_ext/priv-app/ril-extension/ril-extension.apk',
            'vendor/bin/hw/rild_exynos',
            'vendor/lib64/libgooglerilmemmonitor.so', // used by rild_exynos
            'vendor/lib64/libgril_oem-google.so',
            'vendor/lib64/libril-aidl.so', // used by rild_exynos
            'vendor/lib64/libril_gfeature.so', // used by rild_exynos
            'vendor/lib64/libril_sitril.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.oemservice@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.1.so', // used by rild_exynos
            'system_ext/priv-app/OemRilService/OemRilService.apk',
            'system_ext/app/OemRilHookService/OemRilHookService.apk',
            'system_ext/framework/google-ril.jar',
            'system_ext/framework/oemrilhook.jar',
            'system_ext/priv-app/ShannonIms/ShannonIms.apk',
            'system_ext/priv-app/ShannonRcs/ShannonRcs.apk',
        ],
        newFiles: [
        ],
    },
    "komodo": {
        sourceBuildId: "BP2A.250605.031.A2",
        replaceFiles: [
            'vendor/firmware/brcm/BCM_200.hcd', // Bluetooth firmware
            'vendor/firmware/fw_bcmdhd.bin_4390_b1', // WiFi firmware
            'vendor/firmware/fw_bcmdhd.map_4390_b1', // WiFi firmware
            'vendor/firmware/google/edgetpu-rio.fw', // TPU
            'vendor/firmware/google/gxp-callisto.fw', // TPU
            'vendor/firmware/gxp_callisto_fw_core0', // TPU
            'vendor/firmware/gxp_callisto_fw_core1', // TPU
            'vendor/firmware/gxp_callisto_fw_core2', // TPU

            'system_ext/priv-app/ril-extension/ril-extension.apk',
            'vendor/bin/hw/rild_exynos',
            'vendor/lib64/libgooglerilmemmonitor.so', // used by rild_exynos
            'vendor/lib64/libgril_oem-google.so',
            'vendor/lib64/libril-aidl.so', // used by rild_exynos
            'vendor/lib64/libril_gfeature.so', // used by rild_exynos
            'vendor/lib64/libril_sitril.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.oemservice@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.1.so', // used by rild_exynos
            'system_ext/priv-app/OemRilService/OemRilService.apk',
            'system_ext/app/OemRilHookService/OemRilHookService.apk',
            'system_ext/framework/google-ril.jar',
            'system_ext/framework/oemrilhook.jar',
            'system_ext/priv-app/ShannonIms/ShannonIms.apk',
            'system_ext/priv-app/ShannonRcs/ShannonRcs.apk',
        ],
        newFiles: [
        ],
    },
    "caiman": {
        sourceBuildId: "BP2A.250605.031.A2",
        replaceFiles: [
            'vendor/firmware/brcm/BCM_200.hcd', // Bluetooth firmware
            'vendor/firmware/fw_bcmdhd.bin_4390_b1', // WiFi firmware
            'vendor/firmware/fw_bcmdhd.map_4390_b1', // WiFi firmware
            'vendor/firmware/google/gxp-callisto.fw', // TPU
            'vendor/firmware/gxp_callisto_fw_core0', // TPU
            'vendor/firmware/gxp_callisto_fw_core1', // TPU
            'vendor/firmware/gxp_callisto_fw_core2', // TPU

            'system_ext/priv-app/ril-extension/ril-extension.apk',
            'vendor/bin/hw/rild_exynos',
            'vendor/lib64/libgooglerilmemmonitor.so', // used by rild_exynos
            'vendor/lib64/libgril_oem-google.so',
            'vendor/lib64/libril-aidl.so', // used by rild_exynos
            'vendor/lib64/libril_gfeature.so', // used by rild_exynos
            'vendor/lib64/libril_sitril.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.oemservice@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.1.so', // used by rild_exynos
            'system_ext/priv-app/OemRilService/OemRilService.apk',
            'system_ext/app/OemRilHookService/OemRilHookService.apk',
            'system_ext/framework/google-ril.jar',
            'system_ext/framework/oemrilhook.jar',
            'system_ext/priv-app/ShannonIms/ShannonIms.apk',
            'system_ext/priv-app/ShannonRcs/ShannonRcs.apk',
        ],
        newFiles: [
        ],
    },
    "tokay": {
        sourceBuildId: "BP2A.250605.031.A2",
        replaceFiles: [
            'vendor/firmware/brcm/BCM_200.hcd', // Bluetooth firmware
            'vendor/firmware/fw_bcmdhd.bin_4390_b1', // WiFi firmware
            'vendor/firmware/fw_bcmdhd.map_4390_b1', // WiFi firmware
            'vendor/firmware/google/edgetpu-rio.fw', // TPU
            'vendor/firmware/google/gxp-callisto.fw', // TPU
            'vendor/firmware/gxp_callisto_fw_core0', // TPU
            'vendor/firmware/gxp_callisto_fw_core1', // TPU
            'vendor/firmware/gxp_callisto_fw_core2', // TPU

            'system_ext/priv-app/ril-extension/ril-extension.apk',
            'vendor/bin/hw/rild_exynos',
            'vendor/lib64/libgooglerilmemmonitor.so', // used by rild_exynos
            'vendor/lib64/libgril_oem-google.so',
            'vendor/lib64/libril-aidl.so', // used by rild_exynos
            'vendor/lib64/libril_gfeature.so', // used by rild_exynos
            'vendor/lib64/libril_sitril.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.oemservice@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.1.so', // used by rild_exynos
            'system_ext/priv-app/OemRilService/OemRilService.apk',
            'system_ext/app/OemRilHookService/OemRilHookService.apk',
            'system_ext/framework/google-ril.jar',
            'system_ext/framework/oemrilhook.jar',
            'system_ext/priv-app/ShannonIms/ShannonIms.apk',
            'system_ext/priv-app/ShannonRcs/ShannonRcs.apk',
        ],
        newFiles: [
        ],
    },
    "akita": {
        sourceBuildId: "BP2A.250605.031.A2",
        replaceFiles: [
            'vendor/firmware/bcmdhd_clm.blob_4383_a3', // WiFi firmware
            'vendor/firmware/bcmdhd_clm.blob_MMW', // WiFi firmware

            'vendor/firmware/brcm/BCM.hcd', // Bluetooth firmware
            'vendor/firmware/brcm/BTFW_B.hcd', // Bluetooth firmware
            'vendor/firmware/fw_bcmdhd.bin', // WiFi firmware
            'vendor/firmware/fw_bcmdhd.bin_4383_a3', // WiFi firmware
            'vendor/firmware/fw_bcmdhd.map', // WiFi firmware
            'vendor/firmware/fw_bcmdhd.map_4383_a3', // WiFi firmware
            'vendor/firmware/google/edgetpu-rio.fw', // TPU
            'vendor/firmware/google/gxp-callisto.fw', // TPU
            'vendor/firmware/gxp_callisto_fw_core0', // TPU
            'vendor/firmware/gxp_callisto_fw_core1', // TPU
            'vendor/firmware/gxp_callisto_fw_core2', // TPU

            'system_ext/priv-app/ril-extension/ril-extension.apk',
            'vendor/bin/hw/rild_exynos',
            'vendor/lib64/libgooglerilmemmonitor.so', // used by rild_exynos
            'vendor/lib64/libgril_oem-google.so',
            'vendor/lib64/libril-aidl.so', // used by rild_exynos
            'vendor/lib64/libril_gfeature.so', // used by rild_exynos
            'vendor/lib64/libril_sitril.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.oemservice@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.1.so', // used by rild_exynos
            'system_ext/priv-app/OemRilService/OemRilService.apk',
            'system_ext/app/OemRilHookService/OemRilHookService.apk',
            'system_ext/framework/google-ril.jar',
            'system_ext/framework/oemrilhook.jar',
            'system_ext/priv-app/ShannonIms/ShannonIms.apk',
            'system_ext/priv-app/ShannonRcs/ShannonRcs.apk',
        ],
        newFiles: [
            'vendor/firmware/bcmdhd_clm.blob_NA',  // WiFi firmware, only on 16
        ],
    },
    "husky": {
        sourceBuildId: "BP2A.250605.031.A2",
        replaceFiles: [
            'vendor/firmware/brcm/BCM.hcd', // Bluetooth firmware
            'vendor/firmware/brcm/BTFW_B.hcd', // Bluetooth firmware
            'vendor/firmware/fw_bcmdhd.bin_4398_d0', // WiFi firmware
            'vendor/firmware/fw_bcmdhd.map_4398_d0', // WiFi firmware
            'vendor/firmware/google/edgetpu-rio.fw', // TPU
            'vendor/firmware/google/gxp-callisto.fw', // TPU
            'vendor/firmware/gxp_callisto_fw_core0', // TPU
            'vendor/firmware/gxp_callisto_fw_core1', // TPU
            'vendor/firmware/gxp_callisto_fw_core2', // TPU

            'system_ext/priv-app/ril-extension/ril-extension.apk',
            'vendor/bin/hw/rild_exynos',
            'vendor/lib64/libgooglerilmemmonitor.so', // used by rild_exynos
            'vendor/lib64/libgril_oem-google.so',
            'vendor/lib64/libril-aidl.so', // used by rild_exynos
            'vendor/lib64/libril_gfeature.so', // used by rild_exynos
            'vendor/lib64/libril_sitril.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.oemservice@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.1.so', // used by rild_exynos
            'system_ext/priv-app/OemRilService/OemRilService.apk',
            'system_ext/app/OemRilHookService/OemRilHookService.apk',
            'system_ext/framework/google-ril.jar',
            'system_ext/framework/oemrilhook.jar',
            'system_ext/priv-app/ShannonIms/ShannonIms.apk',
            'system_ext/priv-app/ShannonRcs/ShannonRcs.apk',
        ],
        newFiles: [
        ],
    },
    "shiba": {
        sourceBuildId: "BP2A.250605.031.A2",
        replaceFiles: ['vendor/firmware/brcm/BCM.hcd', // Bluetooth firmware
            'vendor/firmware/brcm/BTFW_B.hcd', // Bluetooth firmware
            'vendor/firmware/fw_bcmdhd.bin_4398_d0', // WiFi firmware
            'vendor/firmware/fw_bcmdhd.map_4398_d0', // WiFi firmware
            'vendor/firmware/google/edgetpu-rio.fw', // TPU
            'vendor/firmware/google/gxp-callisto.fw', // TPU
            'vendor/firmware/gxp_callisto_fw_core0', // TPU
            'vendor/firmware/gxp_callisto_fw_core1', // TPU
            'vendor/firmware/gxp_callisto_fw_core2', // TPU

            'system_ext/priv-app/ril-extension/ril-extension.apk',
            'vendor/bin/hw/rild_exynos',
            'vendor/lib64/libgooglerilmemmonitor.so', // used by rild_exynos
            'vendor/lib64/libgril_oem-google.so',
            'vendor/lib64/libril-aidl.so', // used by rild_exynos
            'vendor/lib64/libril_gfeature.so', // used by rild_exynos
            'vendor/lib64/libril_sitril.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.oemservice@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.1.so', // used by rild_exynos
            'system_ext/priv-app/OemRilService/OemRilService.apk',
            'system_ext/app/OemRilHookService/OemRilHookService.apk',
            'system_ext/framework/google-ril.jar',
            'system_ext/framework/oemrilhook.jar',
            'system_ext/priv-app/ShannonIms/ShannonIms.apk',
            'system_ext/priv-app/ShannonRcs/ShannonRcs.apk',
        ],
        newFiles: [
        ],
    },
    "felix": {
        sourceBuildId: "BP2A.250605.031.A2",
        replaceFiles: [
            'vendor/firmware/brcm/BCM.hcd', // Bluetooth firmware
            'vendor/firmware/fw_bcmdhd.bin', // WiFi firmware
            'vendor/firmware/fw_bcmdhd.map', // WiFi firmware
            'vendor/firmware/google/edgetpu-janeiro.fw', // TPU firmware
            'vendor/firmware/gxp_fw_core0', // TPU firmware
            'vendor/firmware/gxp_fw_core1', // TPU firmware
            'vendor/firmware/gxp_fw_core2', // TPU firmware
            'vendor/firmware/gxp_fw_core3', // TPU firmware

            'vendor/bin/hw/rild_exynos',
            'vendor/lib64/libgooglerilmemmonitor.so', // used by rild_exynos
            'vendor/lib64/libgril_oem-google.so',
            'vendor/lib64/libril-aidl.so', // used by rild_exynos
            'vendor/lib64/libril_gfeature.so', // used by rild_exynos
            'vendor/lib64/libril_sitril.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.oemservice@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.1.so', // used by rild_exynos
            'system_ext/priv-app/OemRilService/OemRilService.apk',
            'system_ext/app/OemRilHookService/OemRilHookService.apk',
            'system_ext/framework/google-ril.jar',
            'system_ext/framework/oemrilhook.jar',
            'system_ext/priv-app/ShannonIms/ShannonIms.apk',
            'system_ext/priv-app/ShannonRcs/ShannonRcs.apk',
        ],
        newFiles: [
            'vendor/firmware/brcm/BTFW_D.hcd', // Bluetooth firmware, only on 16
        ],
    },
    "tangorpro": {
        sourceBuildId: "BP2A.250605.031.A2",
        replaceFiles: [ // TODO: No obvious Bluetooth in the diff. Confirm?
            'vendor/firmware/fw_bcmdhd.bin', // WiFi firmware
            'vendor/firmware/fw_bcmdhd.map', // WiFi firmware
            'vendor/firmware/google/edgetpu-janeiro.fw', // TPU firmware
            'vendor/firmware/gxp_fw_core0', // TPU firmware
            'vendor/firmware/gxp_fw_core1', // TPU firmware
            'vendor/firmware/gxp_fw_core2', // TPU firmware
            'vendor/firmware/gxp_fw_core3', // TPU firmware

            'vendor/lib64/libgril_oem-google.so',
            'system_ext/framework/google-ril.jar',
        ]
    },
    "lynx": {
        sourceBuildId: "BP2A.250605.031.A2",
        replaceFiles: [ // TODO: No obvious Wifi, Bluetooth in the diff. Confirm?
            'vendor/firmware/google/edgetpu-janeiro.fw', // TPU firmware
            'vendor/firmware/gxp_fw_core0', // TPU firmware
            'vendor/firmware/gxp_fw_core1', // TPU firmware
            'vendor/firmware/gxp_fw_core2', // TPU firmware
            'vendor/firmware/gxp_fw_core3', // TPU firmware

            'vendor/bin/hw/rild_exynos',
            'vendor/lib64/libgooglerilmemmonitor.so', // used by rild_exynos
            'vendor/lib64/libgril_oem-google.so',
            'vendor/lib64/libril-aidl.so', // used by rild_exynos
            'vendor/lib64/libril_gfeature.so', // used by rild_exynos
            'vendor/lib64/libril_sitril.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.oemservice@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.1.so', // used by rild_exynos
            'system_ext/priv-app/OemRilService/OemRilService.apk',
            'system_ext/app/OemRilHookService/OemRilHookService.apk',
            'system_ext/framework/google-ril.jar',
            'system_ext/framework/oemrilhook.jar',
            'system_ext/priv-app/ShannonIms/ShannonIms.apk',
            'system_ext/priv-app/ShannonRcs/ShannonRcs.apk',
        ],
        newFiles: [
        ],
    },
    "cheetah": {
        sourceBuildId: "BP2A.250605.031.A2",
        replaceFiles: [
            'vendor/firmware/brcm/BCM.hcd', // Bluetooth firmware
            'vendor/firmware/brcm/BTFW_B.hcd', // Bluetooth firmware
            'vendor/firmware/fw_bcmdhd.bin', // WiFi firmware
            'vendor/firmware/fw_bcmdhd.map', // WiFi firmware
            'vendor/firmware/google/edgetpu-janeiro.fw', // TPU firmware
            'vendor/firmware/gxp_fw_core0', // TPU firmware?
            'vendor/firmware/gxp_fw_core1', // TPU firmware?
            'vendor/firmware/gxp_fw_core2', // TPU firmware?
            'vendor/firmware/gxp_fw_core3', // TPU firmware?

            'vendor/bin/hw/rild_exynos',
            'vendor/lib64/libgooglerilmemmonitor.so', // used by rild_exynos
            'vendor/lib64/libgril_oem-google.so',
            'vendor/lib64/libril-aidl.so', // used by rild_exynos
            'vendor/lib64/libril_gfeature.so', // used by rild_exynos
            'vendor/lib64/libril_sitril.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.oemservice@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.1.so', // used by rild_exynos
            'system_ext/priv-app/OemRilService/OemRilService.apk',
            'system_ext/app/OemRilHookService/OemRilHookService.apk',
            'system_ext/framework/google-ril.jar',
            'system_ext/framework/oemrilhook.jar',
            'system_ext/priv-app/ShannonIms/ShannonIms.apk',
            'system_ext/priv-app/ShannonRcs/ShannonRcs.apk',
            // 'vendor/lib64/libsitril.so', // only this is used by rild_exynos via lsof -p $PID, but adding this seems to break telephony
            // showed up in diff
            // 'vendor/lib64/libsitril-ims.so',
            // 'vendor/lib64/libsitril-gps.so',
            // 'vendor/lib64/libsitril-client.so',
            // 'vendor/lib64/libsitril-audio.so',
        ],
        newFiles: [
            'vendor/firmware/brcm/BTFW_D.hcd', // Bluetooth firmware, only on 16
        ],
    },
    "panther": {
        sourceBuildId: "BP2A.250605.031.A2",
        replaceFiles: [
            'vendor/firmware/brcm/BCM.hcd', // Bluetooth firmware
            'vendor/firmware/brcm/BTFW_B.hcd', // Bluetooth firmware
            'vendor/firmware/fw_bcmdhd.bin', // WiFi firmware
            'vendor/firmware/fw_bcmdhd.map', // WiFi firmware
            'vendor/firmware/google/edgetpu-janeiro.fw', // TPU firmware
            'vendor/firmware/gxp_fw_core0', // TPU firmware?
            'vendor/firmware/gxp_fw_core1', // TPU firmware?
            'vendor/firmware/gxp_fw_core2', // TPU firmware?
            'vendor/firmware/gxp_fw_core3', // TPU firmware?

            'vendor/bin/hw/rild_exynos',
            'vendor/lib64/libgooglerilmemmonitor.so', // used by rild_exynos
            'vendor/lib64/libgril_oem-google.so',
            'vendor/lib64/libril-aidl.so', // used by rild_exynos
            'vendor/lib64/libril_gfeature.so', // used by rild_exynos
            'vendor/lib64/libril_sitril.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.oemservice@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.1.so', // used by rild_exynos
            'system_ext/priv-app/OemRilService/OemRilService.apk',
            'system_ext/app/OemRilHookService/OemRilHookService.apk',
            'system_ext/framework/google-ril.jar',
            'system_ext/framework/oemrilhook.jar',
            'system_ext/priv-app/ShannonIms/ShannonIms.apk',
            'system_ext/priv-app/ShannonRcs/ShannonRcs.apk',
            // 'vendor/lib64/libsitril.so', // used by rild_exynos, but adding this seems to break telephony
            // 'vendor/lib64/libsitril-ims.so',
            // 'vendor/lib64/libsitril-gps.so',
            // 'vendor/lib64/libsitril-client.so',
            // 'vendor/lib64/libsitril-audio.so',
        ],
        newFiles: [
            'vendor/firmware/brcm/BTFW_D.hcd', // Bluetooth firmware, only on 16
        ],
    },
    "bluejay": {
        sourceBuildId: "BP2A.250605.031.A2",
        replaceFiles: [
            'vendor/firmware/brcm/BCM.hcd', // Bluetooth firmware
            'vendor/firmware/brcm/BTFW_B.hcd', // Bluetooth firmware
            'vendor/firmware/fw_bcmdhd.bin', // WiFi firmware
            'vendor/firmware/fw_bcmdhd.map', // WiFi firmware
            'vendor/firmware/google/edgetpu-abrolhos.fw', // TPU firmware

            'vendor/bin/hw/rild_exynos',
            'vendor/lib64/libgooglerilmemmonitor.so', // used by rild_exynos
            'vendor/lib64/libgril_oem-google.so',
            'vendor/lib64/libril_gfeature.so', // used by rild_exynos
            'vendor/lib64/libril_sitril.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.oemservice@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.1.so', // used by rild_exynos
            'system_ext/priv-app/OemRilService/OemRilService.apk',
            'system_ext/app/OemRilHookService/OemRilHookService.apk',
            'system_ext/framework/google-ril.jar',
            'system_ext/framework/oemrilhook.jar',
            'system_ext/priv-app/ShannonIms/ShannonIms.apk',
            'system_ext/priv-app/ShannonRcs/ShannonRcs.apk',
        ],
        newFiles: [
        ],
    },
    "raven": {
        sourceBuildId: "BP2A.250605.031.A2",
        replaceFiles: [
            'vendor/firmware/brcm/BCM.hcd', // Bluetooth firmware
            'vendor/firmware/brcm/BTFW_B.hcd', // Bluetooth firmware
            'vendor/firmware/fw_bcmdhd.bin', // WiFi firmware
            'vendor/firmware/fw_bcmdhd.map', // WiFi firmware
            'vendor/firmware/google/edgetpu-abrolhos.fw', // TPU firmware

            'vendor/bin/hw/rild_exynos',
            'vendor/lib64/libgooglerilmemmonitor.so', // used by rild_exynos
            'vendor/lib64/libgril_oem-google.so',
            'vendor/lib64/libril_gfeature.so', // used by rild_exynos
            'vendor/lib64/libril_sitril.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.oemservice@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.1.so', // used by rild_exynos
            'system_ext/priv-app/OemRilService/OemRilService.apk',
            'system_ext/app/OemRilHookService/OemRilHookService.apk',
            'system_ext/framework/google-ril.jar',
            'system_ext/framework/oemrilhook.jar',
            'system_ext/priv-app/ShannonIms/ShannonIms.apk',
            'system_ext/priv-app/ShannonRcs/ShannonRcs.apk',
        ],
        newFiles: [
        ],
    },
    "oriole": {
        sourceBuildId: "BP2A.250605.031.A2",
        replaceFiles: [
            'vendor/firmware/brcm/BCM.hcd', // Bluetooth firmware
            'vendor/firmware/brcm/BTFW_B.hcd', // Bluetooth firmware
            'vendor/firmware/fw_bcmdhd.bin', // WiFi firmware
            'vendor/firmware/fw_bcmdhd.map', // WiFi firmware
            'vendor/firmware/google/edgetpu-abrolhos.fw', // TPU firmware

            'vendor/bin/hw/rild_exynos',
            'vendor/lib64/libgooglerilmemmonitor.so', // used by rild_exynos
            'vendor/lib64/libgril_oem-google.so',
            'vendor/lib64/libril_gfeature.so', // used by rild_exynos
            'vendor/lib64/libril_sitril.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.oemservice@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.0.so', // used by rild_exynos
            'vendor/lib64/vendor.samsung_slsi.telephony.hardware.radioExternal@1.1.so', // used by rild_exynos
            'system_ext/priv-app/OemRilService/OemRilService.apk',
            'system_ext/app/OemRilHookService/OemRilHookService.apk',
            'system_ext/framework/google-ril.jar',
            'system_ext/framework/oemrilhook.jar',
            'system_ext/priv-app/ShannonIms/ShannonIms.apk',
            'system_ext/priv-app/ShannonRcs/ShannonRcs.apk',
        ],
        newFiles: [
        ],
    },
}
