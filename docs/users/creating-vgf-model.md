<!---
SPDX-FileCopyrightText: Copyright 2026 Arm Limited and/or its affiliates <open-source-office@arm.com>
SPDX-License-Identifier: Apache-2.0
--->

# Creating and exporting a VGF model

> [!NOTE]
> This step is optional if you already have a VGF model.

Follow the Arm Learning Path [Quantize neural upscaling models with ExecuTorch](https://learn.arm.com/learning-paths/mobile-graphics-and-gaming/quantize-neural-upscaling-models/) to create a PyTorch model, quantize it using post-training quantization (PTQ) or quantization-aware training (QAT), and export it as a `.vgf` file using the ExecuTorch Arm backend.

## Preserve debug information for MLIA

Enable both of the following options when exporting the model:

- Pass `--emit-debug-info` to VgfCompileSpec. This embeds ExecuTorch stack traces and module metadata in the VGF file.
- Call `dump_debug_info(VgfCompileSpec.DebugMode.TOSA)` on the VgfCompileSpec object. This preserves the corresponding TOSA debug information during lowering.

The Arm Learning Path already enables both options.

MLIA can still estimate performance when these options are omitted. However, it cannot construct useful Python code-line, code-stack, or `nn.Module` hierarchies without the embedded ExecuTorch and TOSA debug information.

Next, either [collect profiling data](profiling-data.md) for measured performance or [run an estimation](analyses.md) from the VGF model.
