#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path
import tempfile


def main() -> None:
    parser = argparse.ArgumentParser(description="Export and quantize a Focuify checkpoint for the browser.")
    parser.add_argument("--model", default="artifacts/focuify-v2/model")
    parser.add_argument("--output-dir", default="artifacts/focuify-v2/browser")
    parser.add_argument("--max-length", type=int, default=256)
    parser.add_argument("--opset", type=int, default=18)
    args = parser.parse_args()

    import sklearn  # Load the shared OpenMP runtime before PyTorch on macOS.
    import onnx
    import torch
    from onnxruntime.quantization import QuantType, quantize_dynamic
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    source = Path(args.model)
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    tokenizer = AutoTokenizer.from_pretrained(source, local_files_only=True)
    model = AutoModelForSequenceClassification.from_pretrained(source, local_files_only=True).cpu().eval()
    if model.config.num_labels != 1:
        raise ValueError("browser model must return exactly one relevance logit")
    encoded = tokenizer(
        ["study cellular respiration", "write an evidence-based history argument"],
        ["a lesson about glycolysis and ATP", "primary sources from the assigned period"],
        padding=True,
        truncation=True,
        max_length=args.max_length,
        return_tensors="pt",
    )
    input_names = [name for name in ("input_ids", "attention_mask", "token_type_ids") if name in encoded]
    if input_names not in (
        ["input_ids", "attention_mask"],
        ["input_ids", "attention_mask", "token_type_ids"],
    ):
        raise ValueError(f"unsupported tokenizer inputs: {input_names}")

    class ThreeInputLogits(torch.nn.Module):
        def __init__(self, wrapped):
            super().__init__()
            self.wrapped = wrapped

        def forward(self, input_ids, attention_mask, token_type_ids):
            return self.wrapped(
                input_ids=input_ids,
                attention_mask=attention_mask,
                token_type_ids=token_type_ids,
            ).logits

    class TwoInputLogits(torch.nn.Module):
        def __init__(self, wrapped):
            super().__init__()
            self.wrapped = wrapped

        def forward(self, input_ids, attention_mask):
            return self.wrapped(
                input_ids=input_ids,
                attention_mask=attention_mask,
            ).logits

    wrapper = (
        ThreeInputLogits(model)
        if input_names == ["input_ids", "attention_mask", "token_type_ids"]
        else TwoInputLogits(model)
    ).eval()

    fp32 = output / "model_fp32.onnx"
    dynamic_shapes = {
        name: {
            0: torch.export.Dim("batch", min=1),
            1: torch.export.Dim("sequence", min=1),
        }
        for name in input_names
    }
    with torch.inference_mode():
        torch.onnx.export(
            wrapper,
            tuple(encoded[name] for name in input_names),
            fp32,
            input_names=input_names,
            output_names=["logits"],
            dynamic_shapes=dynamic_shapes,
            opset_version=args.opset,
            do_constant_folding=True,
            external_data=False,
            dynamo=True,
        )
    onnx.checker.check_model(onnx.load(fp32))
    quantized = output / "model_quantized.onnx"
    with tempfile.TemporaryDirectory(prefix="focuify-onnx-") as temporary:
        clean = onnx.load(fp32)
        del clean.graph.value_info[:]
        # Layer one stays in FP32 because it was the smallest mixed-precision
        # variant that met both the size and native-runtime agreement gates.
        excluded_nodes = [
            "node_MatMul_180",
            "node_MatMul_182",
            "node_MatMul_191",
            "node_MatMul_219",
        ]
        graph_nodes = {node.name for node in clean.graph.node}
        missing_nodes = set(excluded_nodes) - graph_nodes
        if missing_nodes:
            raise RuntimeError(
                f"export graph changed; missing mixed-precision nodes: {sorted(missing_nodes)}"
            )
        clean_path = Path(temporary) / "model.onnx"
        onnx.save(clean, clean_path)
        quantize_dynamic(
            model_input=clean_path,
            model_output=quantized,
            weight_type=QuantType.QInt8,
            per_channel=True,
            op_types_to_quantize=["Gather", "MatMul", "Gemm"],
            nodes_to_exclude=excluded_nodes,
        )
    onnx.checker.check_model(onnx.load(quantized))
    tokenizer.save_pretrained(output)
    model.config.save_pretrained(output)
    print(f"Exported {fp32.stat().st_size:,} bytes; INT8 {quantized.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
