from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path

import torch
from torch import nn


PAD_TOKEN = "<pad>"
UNK_TOKEN = "<unk>"


@dataclass(frozen=True)
class ModelConfig:
    vocab_size: int
    max_length: int = 32
    d_model: int = 96
    nhead: int = 4
    num_layers: int = 2
    dim_feedforward: int = 192
    dropout: float = 0.15


class AccentTransformer(nn.Module):
    """Small multilingual character classifier inspired by RUAccent's accent model."""

    def __init__(self, config: ModelConfig) -> None:
        super().__init__()
        self.config = config
        self.embedding = nn.Embedding(config.vocab_size, config.d_model, padding_idx=0)
        self.position = nn.Embedding(config.max_length, config.d_model)
        layer = nn.TransformerEncoderLayer(
            d_model=config.d_model,
            nhead=config.nhead,
            dim_feedforward=config.dim_feedforward,
            dropout=config.dropout,
            activation="gelu",
            batch_first=True,
            norm_first=True,
        )
        self.encoder = nn.TransformerEncoder(layer, num_layers=config.num_layers)
        self.classifier = nn.Linear(config.d_model, 2)
        self.count_classifier = nn.Linear(config.d_model, 2)

    def forward(self, input_ids: torch.Tensor, attention_mask: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        length = input_ids.shape[1]
        positions = torch.arange(length, device=input_ids.device).unsqueeze(0)
        hidden = self.embedding(input_ids) * math.sqrt(self.config.d_model)
        hidden = hidden + self.position(positions)
        hidden = self.encoder(hidden, src_key_padding_mask=~attention_mask.bool())
        token_logits = self.classifier(hidden)
        float_mask = attention_mask.unsqueeze(-1).to(hidden.dtype)
        pooled = (hidden * float_mask).sum(dim=1) / float_mask.sum(dim=1).clamp_min(1.0)
        count_logits = self.count_classifier(pooled)
        return token_logits, count_logits


def save_checkpoint(
    path: Path,
    model: AccentTransformer,
    char_to_id: dict[str, int],
    metadata: dict,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "state_dict": model.state_dict(),
            "config": asdict(model.config),
            "char_to_id": char_to_id,
            "metadata": metadata,
        },
        path,
    )
    path.with_suffix(".json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def load_checkpoint(path: Path, device: torch.device) -> tuple[AccentTransformer, dict[str, int], dict]:
    checkpoint = torch.load(path, map_location=device, weights_only=False)
    model = AccentTransformer(ModelConfig(**checkpoint["config"]))
    model.load_state_dict(checkpoint["state_dict"])
    model.to(device)
    model.eval()
    return model, checkpoint["char_to_id"], checkpoint.get("metadata", {})
