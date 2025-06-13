export interface DeviceDetails {
  "version-bootloader": string;
  "version-baseband": string;
  "bootloader-name": string;
  "modem-name": string;
}

export const deviceMapping: Record<string, DeviceDetails> = {
  "tegu": {
    "version-bootloader": "tegu-16.0-13291548",
    "version-baseband": "g5300t-250320-250425-b-13407682",
    "bootloader-name": "bootloader-tegu-tegu-16.0-13291548.img",
    "modem-name": "radio-tegu-g5300t-250320-250425-b-13407682.img",
  },
  "comet": {
    "version-bootloader": "ripcurrentpro-16.0-13291548",
    "version-baseband": "g5400c-250320-250508-b-13464352",
    "bootloader-name": "bootloader-comet-ripcurrentpro-16.0-13291548.img",
    "modem-name": "radio-comet-g5400c-250320-250508-b-13464352.img",
  },
  "komodo": {
    "version-bootloader": "ripcurrentpro-16.0-13291548",
    "version-baseband" : "g5400c-250320-250508-b-13464352",
    "bootloader-name": "bootloader-komodo-ripcurrentpro-16.0-13291548.img",
    "modem-name": "radio-komodo-g5400c-250320-250508-b-13464352.img",
  },
  "caiman": {
    "version-bootloader": "ripcurrentpro-16.0-13291548",
    "version-baseband": "g5400c-250320-250508-b-13464352",
    "bootloader-name": "bootloader-caiman-ripcurrentpro-16.0-13291548.img",
    "modem-name": "radio-caiman-g5400c-250320-250508-b-13464352.img",
  },
  "tokay": {
    "version-bootloader": "ripcurrentpro-16.0-13291548",
    "version-baseband": "g5400c-250320-250508-b-13464352",
    "bootloader-name": "bootloader-tokay-ripcurrentpro-16.0-13291548.img",
    "modem-name": "radio-tokay-g5400c-250320-250508-b-13464352.img",
  },
  "akita": {
    "version-bootloader": "akita-16.2-13291556",
    "version-baseband": "g5300o-250320-250425-b-13407682",
    "bootloader-name": "bootloader-akita-akita-16.2-13291556.img",
    "modem-name": "radio-akita-g5300o-250320-250425-b-13407682.img",
  },
  "husky": {
    "version-bootloader": "ripcurrent-16.2-13291556",
    "version-baseband": "g5300i-250320-250425-b-13407682",
    "bootloader-name": "bootloader-husky-ripcurrent-16.2-13291556.img",
    "modem-name": "radio-husky-g5300i-250320-250425-b-13407682.img",
  },
  "shiba": {
    "version-bootloader": "ripcurrent-16.2-13291556",
    "version-baseband": "g5300i-250320-250425-b-13407682",
    "bootloader-name": "bootloader-shiba-ripcurrent-16.2-13291556.img",
    "modem-name": "radio-shiba-g5300i-250320-250425-b-13407682.img",
  },
  "felix": {
    "version-bootloader": "felix-16.0-13291549",
    "version-baseband": "g5300q-250320-250425-b-13407682",
    "bootloader-name": "bootloader-felix-felix-16.0-13291549.img",
    "modem-name": "radio-felix-g5300q-250320-250425-b-13407682.img",
  },
  "tangorpro": {
    "version-bootloader": "tangorpro-16.0-13291549",
    "version-baseband": "",
    "bootloader-name": "bootloader-tangorpro-tangorpro-16.0-13291549.img",
    "modem-name": "",
  },
  "lynx": {
    "version-bootloader": "lynx-16.0-13291549",
    "version-baseband": "g5300q-250320-250425-b-13407682",
    "bootloader-name": "bootloader-lynx-lynx-16.0-13291549.img",
    "modem-name": "radio-lynx-g5300q-250320-250425-b-13407682.img",
  },
  "cheetah": {
    "version-bootloader":  "cloudripper-16.0-13291549",
    "version-baseband":  "g5300q-250320-250425-B-13407682",
    "bootloader-name": "bootloader-cheetah-cloudripper-16.0-13291549.img",
    "modem-name": "radio-cheetah-g5300q-250320-250425-b-13407682.img",
  },
  "panther": {
    "version-bootloader": "cloudripper-16.0-13291549",
    "version-baseband": "g5300q-250320-250425-b-13407682",
    "bootloader-name": "bootloader-panther-cloudripper-16.0-13291549.img",
    "modem-name": "radio-panther-g5300q-250320-250425-b-13407682.img",
  },
  "bluejay": {
    "version-bootloader": "bluejay-16.2-13291547",
    "version-baseband": "g5123b-145971-250328-b-13284995",
    "bootloader-name": "bootloader-bluejay-bluejay-16.2-13291547.img",
    "modem-name": "radio-bluejay-g5123b-145971-250328-b-13284995.img",
  },
  "raven": {
    "version-bootloader": "slider-16.2-13291547",
    "version-baseband": "g5123b-145971-250328-b-13284995",
    "bootloader-name": "bootloader-raven-slider-16.2-13291547.img",
    "modem-name": "radio-raven-g5123b-145971-250328-b-13284995.img",
  },
  "oriole": {
    "version-bootloader": "slider-16.2-13291547",
    "version-baseband": "g5123b-145971-250328-b-13284995",
    "bootloader-name": "bootloader-oriole-slider-16.2-13291547.img",
    "modem-name": "radio-oriole-g5123b-145971-250328-b-13284995.img",
  }
}
