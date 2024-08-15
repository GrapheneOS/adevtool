# Bringing up a new Pixel device

This guide assumes basic familiarity with Android platform development.

To install adevtool, download the GrapeheneOS source and run these commands in the root of your tree:

```bash
yarn install --cwd vendor/adevtool/
source script/envsetup.sh
m aapt2
```

This guide is only for initial bringup; see [Generating or updating an existing device](pixel-generate.md) for subsequent updates.

Most commands should be run at the root of your ROM tree, so `aapt2` and other files can be discovered automatically.

All commands that accept stock system images, with the exception of comparison commands (diff-files, diff-props, diff-vintf), support [the source formats listed here](system-source.md).

## 1. Download factory images

In order to extract proprietary files and other data, you need a copy of the stock OS for your device. Download the latest factory images package for your device, replacing `DEVICE` with your device's codename and `BUILD_ID` with the one from the [Google Developers Factory Images Page](https://developers.google.com/android/images):

```bash
vendor/adevtool/bin/run download vendor/adevtool/dl/ -d DEVICE -b BUILD_ID -t factory
```

The factory images ZIP will be saved in `vendor/adevtool/dl`.

## 2. Create a config

Create a simple YAML config file to get started with your device. The [example config](../config/examples/device.yml) has detailed documentation for all possible config values, but this is the bare minimum you need to start:

```yaml
device:
  name: raven
  vendor: google_devices

platform:
  product_makefile: device/google/raviole/aosp_raven.mk

  sepolicy_dirs:
    - hardware/google/pixel-sepolicy
    - device/google/gs101-sepolicy
```

Replace `product_makefile` with the path to your device's product makefile (including the `aosp_` prefix). All Pixel devices use `hardware/google/pixel-sepolicy`, but check your device tree for the device-specific SELinux policies and replace the path accordingly. Most modern Pixel devices follow a format similar to `device/google/redbull-sepolicy`.

You can optionally follow the modular format of existing configs in config/pixel to reuse common Pixel configs as much as possible. This vastly simplifies making all features work, as most parts are the same across all Pixel devices.

## 3. Prepare for reference build

You must disable inline carrier extraction from the GrapheneOS device tree. To do this, just open the relevant device tree and find the inline extraction commit. For an example commit, see [use inline carrier extraction](https://github.com/GrapheneOS/device_google_redbull/commit/d9c30ca9245c7e011441bfc10555f87909f15fbe).

To find missing files, properties, and overlays automatically, adevtool needs a reference build of AOSP to compare with the stock ROM. Navigate to the root of your AOSP tree and generate a vendor module to prepare for this:

```bash
sudo vendor/adevtool/bin/run generate-prep -s vendor/adevtool/dl -b BUILD_ID vendor/adevtool/config/DEVICE.yml
chown -R $(logname):$(logname) vendor/
```

Replace `BUILD_ID` with the build ID, and `DEVICE` with your device's codename.

## 4. Attempt to build

After generating the vendor module, build the system with `m` to get a reference build. Make sure to do a `user` build using the device codename as it appears on the stock ROM (i.e. no `aosp_` prefix; you can build with a different device name and variant later if you want, but the reference build has strict requirements):

```bash
rm -rf out
lunch DEVICE-user
m
```

**The first build is expected to fail — don't panic.** Read the errors to determine which dependencies are missing and add the missing files to the `filters: dep_files` section of the config accordingly. See the [Pixel 2020](../config/pixel/snippets/2020.yml#L26) config for reference.

After adding the missing files, generate the vendor module again (step 2) and attempt another build. Repeat until the build completes successfully.

Even when successful, the reference build **will not boot.** That's normal; this build is only for adevtool's reference purposes.

## 5. Collect state

Use the reference build to create a state file, which contains all necessary information from the build:

```bash
touch vendor/state/DEVICE.json # you only need this for new bringups
vendor/adevtool/bin/run collect-state vendor/state/DEVICE.json -d DEVICE
```

Once you have a state file, the reference build is no longer necessary, so you can safely discard it.

## 6. Fix app signing certificates

Some privileged apps have special SELinux domains assigned by signing certificate, and the default AOSP certificates don't match. Update the certificates:

```bash
vendor/bin/adevtool/run fix-certs -d DEVICE -s vendor/adevtool/dl -b BUILD_ID -p hardware/google/pixel-sepolicy device/google/gs101-sepolicy ...
```

Pass the list of `sepolicy_dirs` in your config as arguments after `-p`. The above list is just an example

This only needs to be done once as it modifies SELinux policies to update certificates as necessary. You may want to fork the modified repositories.

## 7. Generate vendor module
Please remove your changes to inline carrier extraction from the device tree and follow the instructions in the [GrapheneOS build guide](https://grapheneos.org/build#extracting-vendor-files-for-pixel-devices).

## 8. Build the final system

You can now do an actual build. We recommend doing a userdebug build (`userdebug`) for easier debugging. Deleting the special state collection build is required to avoid weird behaviour:

```bash
rm -rf out
lunch raven-user
m
```

This build will likely boot, but some features may be broken.

## 9. Refine the config

To fix features and improve the quality of your bringup, review the following generated files/folders in `vendor/google_devices/raven` to make sure they look reasonable:

- Resource overlays: `overlays/[partition].txt` (e.g. product.txt, vendor.txt)
- List of extracted proprietary files: `proprietary-files.txt`
- Generated vendor interface manifest: `vintf/adevtool_manifest_vendor.xml`
- SELinux policies and partitions: `proprietary/BoardConfigVendor.mk`
- System properties and built packages: `proprietary/device-vendor.mk`

Add filters and regenerate the module until everything looks good. It will be helpful to use [existing Pixel configs](../config/pixel) as references.

If you get a new Pixel device working with no apparent bugs, congrats! Please consider contributing official support for the device [by making a pull request](https://github.com/kdrag0n/adevtool/compare).
