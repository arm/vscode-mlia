<!---
SPDX-FileCopyrightText: Copyright 2026 Arm Limited and/or its affiliates <open-source-office@arm.com>
SPDX-License-Identifier: Apache-2.0
--->

# Collecting profiling data

> [!NOTE]
> These instructions were checked against [ML SDK for Vulkan v2026.09.0](https://github.com/arm/ai-ml-sdk-manifest/tree/v2026.09.0) and [Neural Statistics Vulkan layer v1.0.0](https://github.com/Arm/vulkan-layer-neural-statistics/releases/tag/v1.0.0). The commands below follow the SDK manifest's default branch and the latest layer release.

> [!NOTE]
> If you only want to estimate performance from a model, skip this page and continue with [Running analyses](analyses.md).

Profiling data measures a model running on a target system. MLIA uses it to analyse measured performance instead of estimating from the model alone.

Collection depends on the target profile. A target may produce one report or a directory of related files. Follow the procedure for your target before starting a profiling analysis.

The extension does not collect the data. In New Analysis, add the file or directory produced by your collection workflow. Add multiple paths when separate data sets belong in the same analysis.

## Neural Technology

Use the [Neural Statistics Vulkan layer](https://github.com/Arm/vulkan-layer-neural-statistics) to capture Neural Technology profiling data from a Vulkan data-graph workload running on an Android device. Root access is not required.

[Scenario Runner](https://github.com/arm/ai-ml-sdk-scenario-runner) is an optional way to run an exported VGF model. The same capture layer works with any application that uses the Vulkan data-graph APIs. If your application already captures data through the profiling APIs, use that data without the layer. Otherwise, replace the Scenario Runner commands below with your application's usual deployment and launch steps.

The target application must meet Android's requirements for [loading external Vulkan layers](https://developer.android.com/ndk/guides/graphics/validation-layer#use_external_validation_layers). The loose-layer workflow below uses `run-as`, so use a debuggable application build. The application must execute the workload through Vulkan while the layer is enabled.

### Prerequisites

Prepare the following on the host system:

- Android Debug Bridge (`adb`).
- Python 3.10 or later.
- A C++17-capable host compiler, such as GCC or Clang, for `vgf_dump`.
- CMake 3.25 or later and Ninja 1.10 or later.
- An Android SDK containing `platforms;android-34` and `build-tools;34.0.0`.
- An Android NDK and its CMake toolchain file.
- Gradle 8.4 or later on `PATH`.
- JDK 17, required by the SDK's [Android Gradle Plugin 8.2.2](https://developer.android.com/build/releases/agp-8-2-0-release-notes#compatibility), with `JAVA_HOME` pointing to it.
- Git and the `repo` tool.
- Network access for Python packages, Gradle dependencies, and the `stb` headers downloaded during Scenario Runner's CMake configuration.
- An [exported `.vgf` model](creating-vgf-model.md) and, optionally, representative input tensors.
- An Arm64 Android device with USB debugging enabled and a driver that supports the model's Vulkan data-graph workload and `VK_ARM_data_graph_neural_accelerator_statistics`. See [target-device compatibility](installation.md#requirements).

Confirm that the device is connected:

```bash
adb devices -l
```

Unlock the device and accept the USB-debugging authorization prompt if it appears as `unauthorized`.

### Download and build Scenario Runner

Skip this section when capturing an existing application.

Scenario Runner and its compatible dependencies are available through the [ML SDK manifest](https://github.com/arm/ai-ml-sdk-manifest). Create a minimal checkout:

```bash
mkdir ml-sdk
cd ml-sdk

repo init -u https://github.com/arm/ai-ml-sdk-manifest -g scenario-runner
repo sync --no-clone-bundle

export SDK_PATH="$PWD"
```

Install the host-side build requirements in a virtual environment:

```bash
python3 -m venv "$SDK_PATH/.venv"
source "$SDK_PATH/.venv/bin/activate"
python3 -m pip install \
    -r "$SDK_PATH/sw/scenario-runner/tooling-requirements.txt"
```

Configure the Android tools. Replace the example paths and NDK version with the installed locations:

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/<version>"
export JAVA_HOME=/path/to/jdk-17
export PATH="$JAVA_HOME/bin:$PATH"
```

Build a debuggable Arm64 Android APK. Run the build inside `sw/scenario-runner`: the SDK creates `apk_install` and `apk_package` relative to the current directory. The subshell below keeps the rest of this guide in the SDK root:

```bash
(
cd "$SDK_PATH/sw/scenario-runner"
python3 "$SDK_PATH/sw/scenario-runner/scripts/build.py" \
    -j "$(nproc)" \
    --target-platform android \
    --cmake-toolchain-for-android \
        "$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake" \
    --flatbuffers-path "$SDK_PATH/dependencies/flatbuffers" \
    --argparse-path "$SDK_PATH/dependencies/argparse" \
    --json-path "$SDK_PATH/dependencies/json" \
    --vulkan-headers-path "$SDK_PATH/dependencies/Vulkan-Headers" \
    --glslang-path "$SDK_PATH/dependencies/glslang" \
    --dxc-path "$SDK_PATH/dependencies/DirectXShaderCompiler" \
    --spirv-headers-path "$SDK_PATH/dependencies/SPIRV-Headers" \
    --spirv-tools-path "$SDK_PATH/dependencies/SPIRV-Tools" \
    --vgf-lib-path "$SDK_PATH/sw/vgf-lib" \
    --package-type apk
)
```

The APK is produced under:

```text
$SDK_PATH/sw/scenario-runner/apk_package/app/build/outputs/apk/debug/
```

List the generated debug APK, then set `APK` to its path. Replace `<version>` with the version in the filename, including its development timestamp:

```bash
ls "$SDK_PATH/sw/scenario-runner/apk_package/app/build/outputs/apk/debug/"*.apk

APK="$SDK_PATH/sw/scenario-runner/apk_package/app/build/outputs/apk/debug/ai-ml-sdk-scenario-runner-<version>-debug.apk"
```

The SDK runs Gradle's `assembleDebug` task, which produces the debuggable application needed by `run-as`. See the [Scenario Runner repository](https://github.com/arm/ai-ml-sdk-scenario-runner) for current build requirements and options.

### Download the Android capture layer

Download `VkLayerNeuralStatistics-android-arm64-v8a.tar.gz` from the latest [Neural Statistics layer release](https://github.com/Arm/vulkan-layer-neural-statistics/releases/latest). This archive is separate from the SDK manifest checkout.

With the GitHub CLI, for example:

```bash
gh release download \
    --repo Arm/vulkan-layer-neural-statistics \
    --pattern 'VkLayerNeuralStatistics-android-arm64-v8a.tar.gz'

tar -xzf VkLayerNeuralStatistics-android-arm64-v8a.tar.gz

LAYER_LIB="$PWD/VkLayerNeuralStatistics-android-arm64-v8a/libVkLayerNeuralStatistics.so"
```


### Generate a scenario from an exported VGF

If your application already runs the Vulkan data-graph workload you want to profile, skip this section.

Build the host `vgf_dump` tool from the VGF Library in the manifest checkout:

```bash
python3 "$SDK_PATH/sw/vgf-lib/scripts/build.py" -j "$(nproc)"

VGF_DUMP="$SDK_PATH/sw/vgf-lib/build/vgf_dump/vgf_dump"
```

Generate a Scenario Runner template from the exported VGF:

```bash
mkdir workload
cp /path/to/model.vgf workload/

"$VGF_DUMP" \
    --input workload/model.vgf \
    --output workload/scenario.json \
    --scenario-template
```

For a quick capture, edit `workload/scenario.json` and remove only the input/output resource properties whose values are placeholders such as `TEMPLATE_PATH_TENSOR_INPUT_0` or `TEMPLATE_PATH_TENSOR_OUTPUT_0`. Keep the graph's `src: "model.vgf"` and any other real resource paths. Scenario Runner initializes an input tensor to zero when it has no `src` property and does not write an output tensor when it has no `dst` property.

To profile representative input instead, replace each input placeholder with the name of its NumPy tensor file and copy those files into `workload/`. Output paths are optional. Use paths relative to `scenario.json` so they remain valid when the workload is copied to the Android device.

See the [VGF Library repository](https://github.com/arm/ai-ml-sdk-vgf-library) for details of `vgf_dump` and the scenario-template format.

### Existing Android layer settings

> [!WARNING]
> Android's GPU debug-layer settings are global. The commands below overwrite the current configuration and might disrupt another application or debugging tool. Preserve any existing configuration using your preferred method and restore it after collection.

### Install the application and stage the workload

Set `PACKAGE` to the package name of the application being captured. For Scenario Runner:

```bash
export PACKAGE=com.arm.ai_ml_sdk_scenario_runner
```

For an existing application, use its package name instead and install or update its debuggable build using the application's normal procedure.

Install Scenario Runner:

```bash
adb install -r "$APK"
```

Stage the scenario and its resources through `/data/local/tmp`, then copy them into app-private storage as the application UID:

```bash
adb push workload /data/local/tmp/neural-statistics-workload
adb shell chmod -R a+rX /data/local/tmp/neural-statistics-workload

adb shell run-as "$PACKAGE" mkdir -p files/neural-statistics-run
adb shell run-as "$PACKAGE" \
    cp -r /data/local/tmp/neural-statistics-workload/. \
    files/neural-statistics-run/
```

App-private storage is intentional. On Android versions that enforce scoped storage, an app-specific external directory created directly by `adb shell` might not be accessible to the application. The `run-as` workflow works without root and does not depend on shared-storage behavior.

### Install the layer in app-private storage

Stage the Android layer library, make the staged copy readable, and copy it into the target application's private directory:

```bash
adb push "$LAYER_LIB" /data/local/tmp/libVkLayerNeuralStatistics.so
adb shell chmod a+r /data/local/tmp/libVkLayerNeuralStatistics.so
adb shell run-as "$PACKAGE" \
    cp /data/local/tmp/libVkLayerNeuralStatistics.so .
```

Android's Vulkan loader searches the target application's private directory for an injected loose layer. Loading it from `/sdcard` or another shared-storage location might fail on some devices, so the app-private directory is recommended.

### Configure the capture layer

Create `vk_layer_settings.txt` on the host. Use a new capture directory that does not already exist:

```bash
cat > vk_layer_settings.txt <<EOF
lgl_neural_statistics.capture_folder = /data/data/$PACKAGE/files/neural-statistics-capture
lgl_neural_statistics.statistics_mode = 1
lgl_neural_statistics.dispatch_filter =
EOF
```

Use an absolute app-private path: a relative path is resolved from the application's working directory and does not automatically refer to its private storage. `/data/local/tmp` might not be writable by the application on devices that enforce Android's application sandbox.

Mode `1` is recommended because it currently provides the most useful statistics. Leave `dispatch_filter` blank to capture every executed dispatch occurrence, specify `N` for one zero-based occurrence, or specify `N-M` for an inclusive range. See the [layer documentation](https://github.com/Arm/vulkan-layer-neural-statistics) for all available settings and filtering details.

Push the settings file and configure Android's Vulkan layer injection:

```bash
adb push vk_layer_settings.txt /data/local/tmp/vk_layer_settings.txt
adb shell chmod a+r /data/local/tmp/vk_layer_settings.txt

adb shell setprop \
    debug.vulkan.khronos_profiles.settings_path \
    /data/local/tmp/vk_layer_settings.txt

adb shell settings put global enable_gpu_debug_layers 1
adb shell settings put global gpu_debug_app "$PACKAGE"
adb shell settings put global gpu_debug_layer_app "$PACKAGE"
adb shell settings put global \
    gpu_debug_layers VK_LAYER_LGL_neural_statistics

adb shell am force-stop "$PACKAGE"
```

The `/data/data/$PACKAGE/...` app-private alias is used deliberately. It works with non-root ADB and avoids Android path-traversal differences observed with `/data/user/0/$PACKAGE/...` on some systems.

### Run Scenario Runner with capture enabled

If you are profiling another application, launch its Vulkan data-graph workload as usual instead.

```bash
SCENARIO="/data/data/$PACKAGE/files/neural-statistics-run/scenario.json"
OUTPUT="/data/data/$PACKAGE/files/neural-statistics-run"

adb shell am start-foreground-service \
    -n "$PACKAGE/.Main" \
    --esa args \
    --scenario,"$SCENARIO",--output,"$OUTPUT",--log-level,debug
```

Monitor execution and layer loading:

```bash
adb logcat -s \
    ScenarioService \
    ScenarioRunner \
    VkLayerNeuralStatistics \
    vulkan \
    AndroidRuntime
```

Wait for Scenario Runner to report `native exit code=0`, or wait for the existing application to complete the workload, before retrieving the capture.

### Capture an existing Vulkan data-graph application

Scenario Runner is only a convenient model runner. The layer also supports applications that:

- Consume an exported VGF through their own runtime.
- Use Neural Graphics in a larger application.
- Create data-graph pipelines and sessions directly with the Vulkan APIs.
- Execute one or many data-graph dispatches as part of a real workload.

Use the application's package name throughout the deployment commands, copy the layer into that application's private directory, choose an app-private capture path, enable the layer, and launch the application normally. The layer observes the Vulkan calls and captures selected dispatch occurrences without requiring a Scenario Runner scenario file.

If the application already captures profiling data directly through the Vulkan data-graph profiling APIs, use that captured data and do not enable the layer.

### Copy the capture back

The layer creates capture directories and files with restrictive permissions. Ordinary `adb pull` cannot traverse the app-private capture tree. Stream a tar archive through `run-as` instead:

```bash
adb exec-out run-as "$PACKAGE" \
    tar -C files -cf - neural-statistics-capture \
    > neural-statistics-capture.tar

mkdir neural-statistics-capture-output
tar -C neural-statistics-capture-output \
    -xf neural-statistics-capture.tar
```

In MLIA for VS Code, choose **Profiling** and add `neural-statistics-capture-output/neural-statistics-capture` as the profiling-data path. Select the extracted directory directly containing `capture.json`, rather than the tar archive or its parent directory. Then choose the Neural Technology target profile and follow [Running analyses](analyses.md#profiling).

### Validate the capture

A successful capture contains:

```text
neural-statistics-capture/
  capture.json
  pipeline_000000/
    pipeline.json
    debug_database.bin
    neural_statistics_info.bin
    session_000000/
      session.json
      dispatch_000000/
        dispatch.json
        statistics_mode1.bin
```

The exact number of pipelines, sessions and dispatches depends on the workload and dispatch filter.

Confirm that `capture.json` reports:

- Status `complete`.
- No unexpected warnings.
- The intended statistics mode.
- At least one materialized pipeline and dispatch.

### Restore the device

If you do not plan to collect more captures, you may want to restore the device to remove the profiling setup.

Force-stop the target application and restore any previous GPU debug-layer configuration using your preferred method.

For a device that had no previous GPU debug-layer configuration, clean up with:

```bash
adb shell am force-stop "$PACKAGE"

adb shell settings delete global enable_gpu_debug_layers
adb shell settings delete global gpu_debug_app
adb shell settings delete global gpu_debug_layer_app
adb shell settings delete global gpu_debug_layers
adb shell "setprop debug.vulkan.khronos_profiles.settings_path ''"

adb shell run-as "$PACKAGE" rm -rf \
    libVkLayerNeuralStatistics.so \
    files/neural-statistics-run \
    files/neural-statistics-capture

adb shell rm -rf \
    /data/local/tmp/neural-statistics-workload \
    /data/local/tmp/libVkLayerNeuralStatistics.so \
    /data/local/tmp/vk_layer_settings.txt
```

Leaving a missing layer enabled can prevent the target application from starting.

### Troubleshooting

#### `run-as: package not debuggable`

Use a [debuggable application build](https://developer.android.com/guide/topics/manifest/application-element#debug). The loose-layer and app-private file-transfer workflow requires `run-as` access.

#### The APK installation is rejected

Unlock the device and approve its install-over-USB prompt. Some vendors also require an **Install via USB** developer option.

#### The application cannot read files pushed to shared storage

Do not create the app-specific external directory with `adb shell mkdir`. Scoped-storage ownership can make that directory readable to ADB but inaccessible to the application. Use the app-private `/data/local/tmp` plus `run-as cp` workflow documented above.

#### `Permission denied` while copying the staged workload

Make the staged directory traversable and its files readable before using `run-as`:

```bash
adb shell chmod -R a+rX /data/local/tmp/neural-statistics-workload
```

#### Vulkan reports that the layer cannot be found

Confirm that:

- the package is the package targeted by `gpu_debug_app`;
- `libVkLayerNeuralStatistics.so` is an Android Arm64 library;
- the library was copied into the target application's private directory;
- `gpu_debug_layers` contains `VK_LAYER_LGL_neural_statistics`;
- the application was force-stopped after changing the settings.

#### Capture initialization fails at `/data/user/0`

Use the `/data/data/$PACKAGE/files/...` app-private alias shown above.

#### The capture directory already exists

The layer never merges with or overwrites an existing capture. Remove the previous directory through `run-as` or choose a new capture path.

#### No statistics files are present

Check that:

- the driver exposes `VK_ARM_data_graph_neural_accelerator_statistics`;
- the application successfully executed a data-graph dispatch;
- the dispatch filter selected an executed occurrence;
- the application and device remained alive until GPU collection completed;
- `capture.json` reports `complete` rather than `incomplete` or `error`.

#### The capture cannot be copied with `adb pull`

This is expected for app-private data. Use `adb exec-out run-as ... tar` as documented above. Root access is not required.

Next: [load the captured data and run a profiling analysis](analyses.md).
