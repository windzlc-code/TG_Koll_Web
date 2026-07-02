import math
from typing import Any


def _to_float(value: Any) -> float:
    try:
        return float(value)
    except Exception:
        return 0.0


def _to_int(value: Any) -> int:
    try:
        return int(float(value))
    except Exception:
        return 0


def compute_cost_cents(
    *,
    runninghub_usage: dict[str, Any] | None,
    rh_coins_per_10rmb: int = 2500,
    usd_to_rmb: float = 7.2,
    gemini_input_tokens: int = 0,
    gemini_output_tokens: int = 0,
    gemini_input_usd_per_1m: float = 4.0,
    gemini_output_usd_per_1m: float = 18.0,
    nano_images: int = 0,
    nano_usd_per_image: float = 0.134,
) -> dict[str, Any]:
    rh_coins = 0.0
    if isinstance(runninghub_usage, dict):
        rh_coins = _to_float(runninghub_usage.get("consumeCoins"))
    rh_coins_per_10 = max(int(rh_coins_per_10rmb or 0), 1)
    rh_cents = int(round((rh_coins * 1000.0) / float(rh_coins_per_10)))

    usd_rate = max(_to_float(usd_to_rmb), 0.01)
    gem_in_tokens = max(_to_int(gemini_input_tokens), 0)
    gem_out_tokens = max(_to_int(gemini_output_tokens), 0)
    gem_in_usd = (float(gem_in_tokens) / 1_000_000.0) * max(_to_float(gemini_input_usd_per_1m), 0.0)
    gem_out_usd = (float(gem_out_tokens) / 1_000_000.0) * max(_to_float(gemini_output_usd_per_1m), 0.0)
    gem_usd = gem_in_usd + gem_out_usd
    gem_cents = int(round(gem_usd * usd_rate * 100.0))

    nano_imgs = max(_to_int(nano_images), 0)
    nano_usd = float(nano_imgs) * max(_to_float(nano_usd_per_image), 0.0)
    nano_cents = int(round(nano_usd * usd_rate * 100.0))

    total = max(int(rh_cents + gem_cents + nano_cents), 0)
    return {
        "total_cents": total,
        "breakdown": {
            "runninghub_cents": max(rh_cents, 0),
            "gemini_cents": max(gem_cents, 0),
            "nano_cents": max(nano_cents, 0),
        },
        "pricing": {
            "rh_coins_per_10rmb": rh_coins_per_10,
            "usd_to_rmb": usd_rate,
            "gemini_input_usd_per_1m": _to_float(gemini_input_usd_per_1m),
            "gemini_output_usd_per_1m": _to_float(gemini_output_usd_per_1m),
            "nano_usd_per_image": _to_float(nano_usd_per_image),
        },
        "usage": {
            "rh_coins": rh_coins,
            "gemini_input_tokens": gem_in_tokens,
            "gemini_output_tokens": gem_out_tokens,
            "nano_images": nano_imgs,
        },
    }
