"""Premissas e ordenacao da estrategia de slots lideres."""

from __future__ import annotations

from dataclasses import dataclass
import math


@dataclass(frozen=True)
class StrategyConfig:
    symbol: str = "BTCUSDT"
    slot_count: int = 25
    initial_slot_value: float = 10.0
    gain_rate: float = 0.01
    drop_rate: float = 0.02
    monthly_target_gains: int = 7
    enable_topups: bool = True
    entry_priority: str = "leader"


def priority_key(slot) -> tuple[float, float, int]:
    """Maior ganho operacional, maior valor e menor numero do slot."""
    return (-slot.gains_operational, -slot.value, slot.slot_id)


def select_leader(slots):
    free = [slot for slot in slots if slot.position is None]
    return min(free, key=priority_key) if free else None


def select_entry_slot(slots, policy: str):
    free = [slot for slot in slots if slot.position is None]
    if not free:
        return None
    if policy == "leader":
        return min(free, key=priority_key)
    if policy == "slot-number":
        return min(free, key=lambda slot: slot.slot_id)
    raise ValueError(f"Politica de entrada desconhecida: {policy}")


def calculate_compound_topup(slot_value: float, operational_gains: int, cumulative_target: int, gain_rate: float) -> tuple[int, float, float, float]:
    """Retorna faltantes, fator composto, aporte e novo valor sem mutar o slot."""
    missing = max(0, cumulative_target - operational_gains)
    factor = math.pow(1 + gain_rate, missing)
    new_value = slot_value * factor
    return missing, factor, new_value - slot_value, new_value
