"""Auditoria local das entradas V2 no recorte de calibração de 90 dias.

Não muda parâmetros nem o motor. Reexecuta apenas o recorte já auditado para
materializar o estado interno necessário aos CSVs forenses.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from backtest_btc_v2 import END, ROOT, write_csv
from v2_grid_engine import EPS, Candle, GridConfig, RecyclableLinearGridEngine, load_cached_klines


@dataclass
class OpenPosition:
    slot: int
    cycle: int
    level: int
    anchor: float
    entry: float
    target: float
    timestamp: str
    value: float
    rearmed_before_entry: bool
    previous_exit_timestamp: str


class EventState:
    def __init__(self, slots: int, initial_value: float) -> None:
        self.slots = slots
        self.values = {slot: initial_value for slot in range(1, slots + 1)}
        self.open: dict[int, OpenPosition] = {}
        self.armed: set[int] = set()
        self.current_cycle: int | None = None
        self.last_event = ""
        self.last_buy: dict[tuple[int, int], str] = {}
        self.last_exit: dict[tuple[int, int], tuple[str, int]] = {}
        self.last_rearm: dict[tuple[int, int], tuple[str, int]] = {}

    def occupied_levels(self) -> set[int]:
        return {position.level for position in self.open.values()}

    def apply(self, event: dict, sequence: int) -> tuple[dict | None, dict | None]:
        """Aplica o evento e retorna, quando cabível, auditorias de entrada/recompra."""
        kind = event["event"]
        cycle = int(event["cycle"])
        level = int(event["level"])
        slot = int(event["slot"]) if event["slot"] != "" else None
        entry_row = rebuy_row = None
        if kind == "BUY":
            before = len(self.open)
            old_cycle = self.current_cycle
            if event["reason"] == "cycle_market_entry":
                if self.open:
                    raise AssertionError("novo ciclo iniciado com posições abertas")
                self.current_cycle = cycle
                self.armed = set(range(self.slots))
            if self.current_cycle != cycle:
                raise AssertionError("entrada de ciclo não ativo")
            assert slot is not None
            if level in self.occupied_levels():
                raise AssertionError("nível duplicado simultaneamente aberto")
            expected = float(event["anchor"]) * (1.0 - 0.02 * level)
            actual = float(event["entry_price"])
            if not math.isclose(expected, actual, rel_tol=0.0, abs_tol=EPS * max(1.0, expected)):
                raise AssertionError("entrada fora da grade linear")
            key = (cycle, level)
            rearm = self.last_rearm.get(key)
            previous_exit = self.last_exit.get(key)
            is_rebuy = previous_exit is not None
            armed_before = bool(event["armed_before"])
            valid = armed_before and (not is_rebuy or (rearm is not None and rearm[1] > previous_exit[1]))
            entry_row = {
                "timestamp": event["timestamp"], "cycle_id": cycle, "slot_id": slot,
                "anchor": event["anchor"], "level": level, "expected_trigger": expected,
                "actual_entry": actual, "difference": actual - expected,
                "open_slots_before": before, "open_slots_after": before + 1,
                "armed": armed_before, "rearmed": bool(rearm),
                "previous_event": self.last_event, "valid": valid,
                "reason": event["reason"],
            }
            if is_rebuy:
                rebuy_row = {
                    "cycle_id": cycle, "level": level, "slot_id": slot,
                    "previous_buy_timestamp": self.last_buy[key],
                    "previous_exit_timestamp": previous_exit[0], "rearm_timestamp": rearm[0] if rearm else "",
                    "new_downward_cross_timestamp": event["timestamp"],
                    "new_entry_price": actual, "expected_trigger": expected,
                    "previous_target_crossed": True, "rearm_after_exit": bool(rearm and rearm[1] > previous_exit[1]),
                    "downward_cross_reason": event["reason"], "armed_before_entry": armed_before,
                    "valid": valid,
                }
            self.open[slot] = OpenPosition(
                slot=slot, cycle=cycle, level=level, anchor=float(event["anchor"]), entry=actual,
                target=float(event["target"]), timestamp=event["timestamp"], value=self.values[slot],
                rearmed_before_entry=bool(rearm), previous_exit_timestamp=previous_exit[0] if previous_exit else "",
            )
            self.last_buy[key] = event["timestamp"]
            self.armed.discard(level)
        elif kind == "SELL":
            assert slot is not None
            position = self.open.pop(slot, None)
            if position is None:
                raise AssertionError("venda sem posição aberta")
            if (position.cycle, position.level) != (cycle, level):
                raise AssertionError("venda não corresponde à posição aberta")
            self.values[slot] *= 1.01
            self.last_exit[(cycle, level)] = (event["timestamp"], sequence)
        elif kind == "REARM":
            self.armed.add(level)
            self.last_rearm[(cycle, level)] = (event["timestamp"], sequence)
        self.last_event = kind
        return entry_row, rebuy_row


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--end", type=date.fromisoformat, default=END, help="Último dia do recorte de 90 dias (YYYY-MM-DD).")
    args = parser.parse_args()
    end = args.end
    start = end - timedelta(days=89)
    output = ROOT / "reports" / "backtests" / "v2-entry-forensics-90d" / datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M")
    output.mkdir(parents=True, exist_ok=False)
    candles = list(load_cached_klines(ROOT / "backtest-data", start, end))
    engine = RecyclableLinearGridEngine(GridConfig(enable_topups=False), "heuristic")
    result = engine.run(candles)

    target_sequence, target_event = next(
        (sequence, event)
        for sequence, event in enumerate(result.events)
        if event["event"] == "BUY" and int(event["open_slots_after"]) == result.max_open_slots
    )
    target_time = datetime.fromisoformat(target_event["timestamp"])
    target_price = float(target_event["entry_price"])
    target_cycle = int(target_event["cycle"])
    candle_by_time = {candle.time: candle for candle in candles}
    target_candle = candle_by_time[target_time]

    state = EventState(result.config.slots, result.config.initial_value)
    entries: list[dict] = []
    rebuys: list[dict] = []
    resets: list[dict] = []
    replay: list[dict] = []
    formation_replay: list[dict] = []
    snapshot: list[OpenPosition] = []
    replay_start = target_time - timedelta(hours=24)
    replay_end = target_time + timedelta(hours=24)
    anchors: dict[int, float] = {}
    max_open_by_cycle = 0
    active_cycle_violations = 0

    for sequence, event in enumerate(result.events):
        if event["event"] == "BUY" and event["reason"] == "cycle_market_entry":
            old_cycle = state.current_cycle
            old_anchor = anchors.get(old_cycle, "") if old_cycle is not None else ""
            resets.append({
                "timestamp": event["timestamp"], "old_cycle": old_cycle or "", "new_cycle": event["cycle"],
                "old_anchor": old_anchor, "new_anchor": event["anchor"],
                "open_slots_before_reset": len(state.open),
                "reason": "INITIAL_ANCHOR" if old_cycle is None else "PREVIOUS_CYCLE_COMPLETE_NEXT_CANDLE",
            })
            if state.open:
                raise AssertionError("reset de âncora com posição aberta")
            anchors[int(event["cycle"])] = float(event["anchor"])
        entry, rebuy = state.apply(event, sequence)
        if entry:
            entries.append(entry)
        if rebuy:
            rebuys.append(rebuy)
        if len({position.cycle for position in state.open.values()}) > 1:
            active_cycle_violations += 1
            raise AssertionError("posições abertas de ciclos diferentes")
        max_open_by_cycle = max(max_open_by_cycle, len(state.open))
        event_time = datetime.fromisoformat(event["timestamp"])
        replay_row = {
            "timestamp": event["timestamp"],
            "price": event["entry_price"] or event["exit_price"] or event["trigger"],
            "event": event["event"], "cycle": event["cycle"], "anchor": event["anchor"],
            "level": event["level"], "trigger": event["trigger"], "slot": event["slot"],
            "open_slots": len(state.open),
            "armed_levels": ";".join(str(level) for level in sorted(state.armed)),
            "occupied_levels": ";".join(str(level) for level in sorted(state.occupied_levels())),
            "reason": event["reason"],
        }
        if replay_start <= event_time <= replay_end:
            replay.append(replay_row)
        if int(event["cycle"]) == target_cycle and event_time <= target_time:
            formation_replay.append(replay_row)
        if sequence == target_sequence:
            snapshot = sorted(state.open.values(), key=lambda position: position.level)

    if len(snapshot) != result.max_open_slots:
        raise AssertionError("snapshot de máximo não reproduziu os slots abertos")
    if any(int(row["open_slots_before_reset"]) != 0 for row in resets):
        raise AssertionError("reset de âncora com slots abertos")
    if any(not row["valid"] for row in entries):
        raise AssertionError("entrada inválida encontrada")
    if any(not row["valid"] for row in rebuys):
        raise AssertionError("recompra inválida encontrada")

    forensic_positions = []
    for position in snapshot:
        unrealized = position.value * (target_price / position.entry - 1.0)
        forensic_positions.append({
            "slot_id": position.slot, "cycle_id": position.cycle, "anchor_price": position.anchor,
            "grid_level": position.level,
            "expected_trigger_price": position.anchor * (1.0 - 0.02 * position.level),
            "actual_entry_price": position.entry, "entry_timestamp": position.timestamp,
            "btc_price_at_entry": position.entry,
            "distance_from_anchor_pct": (position.entry / position.anchor - 1.0) * 100.0,
            "target_price": position.target, "current_price_at_max_open": target_price,
            "unrealized_pnl": unrealized, "rearmed_before_entry": position.rearmed_before_entry,
            "previous_exit_timestamp": position.previous_exit_timestamp,
            "reason_still_open": "TARGET_NOT_REACHED_AT_MAX_OPEN_SNAPSHOT",
        })

    cycle_start_event = next(event for event in result.events if int(event["cycle"]) == target_cycle and event["reason"] == "cycle_market_entry")
    cycle_start = datetime.fromisoformat(cycle_start_event["timestamp"])
    cycle_candles_to_max = [candle for candle in candles if cycle_start <= candle.time <= target_time]
    cycle_candles_full = [candle for candle in candles if cycle_start <= candle.time <= result.end]
    cycle_high = max(candle.high for candle in cycle_candles_to_max)
    cycle_low = min(candle.low for candle in cycle_candles_to_max)
    cycle_low_full = min(candle.low for candle in cycle_candles_full)
    anchor = float(target_event["anchor"])
    drawdown_pct = (anchor - cycle_low) / anchor * 100.0
    theoretical_level = math.floor(drawdown_pct / 2.0 + EPS)
    expected_deepest = anchor * (1.0 - 0.02 * (result.max_open_slots - 1))
    level_set = [position.level for position in snapshot]
    if level_set != list(range(result.max_open_slots)):
        raise AssertionError("o máximo não é composto pelos níveis lineares esperados")
    if cycle_low > expected_deepest + EPS:
        raise AssertionError("mínima do ciclo não alcançou o nível mais profundo aberto")

    write_csv(output / "max_open_slots_forensic.csv", forensic_positions, list(forensic_positions[0]))
    write_csv(output / "anchor_resets_90d.csv", resets, list(resets[0]))
    write_csv(output / "entries_forensic_90d.csv", entries, list(entries[0]))
    write_csv(output / "rebuys_forensic_90d.csv", rebuys, list(rebuys[0]))
    write_csv(output / "max_open_replay.csv", replay, ["timestamp", "price", "event", "cycle", "anchor", "level", "trigger", "slot", "open_slots", "armed_levels", "occupied_levels", "reason"])
    write_csv(output / "max_open_cycle_formation.csv", formation_replay, ["timestamp", "price", "event", "cycle", "anchor", "level", "trigger", "slot", "open_slots", "armed_levels", "occupied_levels", "reason"])
    before_after = [
        {"metric": "status", "before_value": "80 gains / 61 gains_60d / 16 max_open", "after_value": "NOT_APPLICABLE", "difference": "", "cause": "Nenhuma entrada inválida; não houve correção do motor."},
    ]
    write_csv(output / "before_after_entry_fix.csv", before_after, ["metric", "before_value", "after_value", "difference", "cause"])
    summary = {
        "period": {"start": start.isoformat(), "end": end.isoformat(), "candles": len(candles)},
        "max_open": {"timestamp": target_event["timestamp"], "cycle": target_cycle, "anchor": anchor, "event_price": target_price, "candle": {"open": target_candle.open, "high": target_candle.high, "low": target_candle.low, "close": target_candle.close}, "slots": len(snapshot), "levels": level_set},
        "cycle_price_proof": {"cycle_start": cycle_start_event["timestamp"], "cycle_high_to_max": cycle_high, "cycle_low_to_max": cycle_low, "cycle_low_full_period": cycle_low_full, "drawdown_pct": drawdown_pct, "deepest_level": result.max_open_slots - 1, "deepest_trigger": expected_deepest, "max_theoretical_level": theoretical_level, "max_theoretical_slots": min(result.config.slots, theoretical_level + 1)},
        "assertions": {"linear_entries_valid": len(entries), "invalid_entries": 0, "duplicate_open_levels": 0, "anchor_resets": len(resets), "resets_with_open_slots": 0, "multiple_active_cycles": active_cycle_violations, "rebuys": len(rebuys), "invalid_rebuys": 0},
        "unchanged_calibration": {"gains": len(result.trades), "gains_last_60d": sum(1 for trade in result.trades if datetime.fromisoformat(trade["sell_time"]).date() >= end - timedelta(days=59)), "max_open_slots": result.max_open_slots, "slots_used": sum(slot.times_bought > 0 for slot in result.slots), "complete_cycles": result.complete_cycles, "equity": result.equity(), "open_pnl": result.open_pnl()},
    }
    (output / "forensic_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    lines = [
        "# Auditoria de entradas V2 — 90 dias", "",
        f"- Máximo: {result.max_open_slots} slots em {target_event['timestamp']} (ciclo {target_cycle}).",
        f"- Âncora: {anchor:.8f}; entrada do 16º slot (nível 15): {target_price:.8f} ({(target_price / anchor - 1) * 100:.2f}%).",
        f"- Mínima do ciclo até o máximo: {cycle_low:.8f}; drawdown: {drawdown_pct:.4f}%; nível teórico máximo: {theoretical_level}; slots teóricos: {min(result.config.slots, theoretical_level + 1)}.",
        f"- Mínima em todo o período disponível do ciclo ativo: {cycle_low_full:.8f}.",
        f"- Todas as {len(entries)} entradas obedeceram `anchor * (1 - 0.02 * level)`; níveis abertos duplicados: 0.",
        f"- Resets de âncora: {len(resets)}; resets com posição aberta: 0; ciclos simultâneos: 0.",
        f"- Recompras: {len(rebuys)}; recompras sem venda+REARM+novo cruzamento descendente: 0.",
        "", "Não foi encontrada uma entrada inválida. Nenhuma correção do motor foi aplicada; o CSV before_after registra esse resultado.",
    ]
    (output / "forensic_summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
