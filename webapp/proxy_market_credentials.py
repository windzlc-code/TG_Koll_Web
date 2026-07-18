from __future__ import annotations

from typing import Any

from .password_vault import decrypt_secret, encrypt_secret


class ProxyMarketCredentialAuthorizationError(RuntimeError):
    pass


def _secret_purpose(item_id: str, field: str) -> str:
    return f"proxy-market:{str(item_id)}:{str(field)}"


def encrypt_market_credentials(
    item_id: str,
    actor_user_id: int,
    username: str,
    password: str,
) -> tuple[str, str]:
    return (
        encrypt_secret(
            actor_user_id,
            _secret_purpose(item_id, "username"),
            username,
        )
        if username
        else "",
        encrypt_secret(
            actor_user_id,
            _secret_purpose(item_id, "password"),
            password,
        )
        if password
        else "",
    )


def decrypt_market_credentials(item: dict[str, Any]) -> tuple[str, str]:
    owner_id = int(item.get("credential_owner_user_id") or 0)
    if owner_id <= 0:
        return "", ""
    item_id = str(item.get("id") or "")
    username_ciphertext = str(item.get("username_ciphertext") or "")
    password_ciphertext = str(item.get("password_ciphertext") or "")
    return (
        decrypt_secret(
            owner_id,
            _secret_purpose(item_id, "username"),
            username_ciphertext,
        )
        if username_ciphertext
        else "",
        decrypt_secret(
            owner_id,
            _secret_purpose(item_id, "password"),
            password_ciphertext,
        )
        if password_ciphertext
        else "",
    )


def resolve_market_proxy_credentials(
    conn: Any,
    proxy: Any,
    *,
    owner_user_id: int | None = None,
) -> dict[str, Any]:
    resolved = dict(proxy)
    item_id = str(resolved.get("market_item_id") or "").strip()
    if not item_id:
        return resolved
    proxy_id = str(resolved.get("id") or "").strip()
    allocation_id = str(resolved.get("market_allocation_id") or "").strip()
    proxy_owner_id = int(resolved.get("user_id") or 0)
    expected_owner_id = proxy_owner_id if owner_user_id is None else int(owner_user_id)
    if (
        str(resolved.get("source") or "") != "marketplace"
        or not proxy_id
        or not allocation_id
        or expected_owner_id <= 0
        or proxy_owner_id != expected_owner_id
    ):
        raise ProxyMarketCredentialAuthorizationError(
            "market proxy credential binding is invalid"
        )
    item = conn.execute(
        """
        SELECT item.*
        FROM proxy_market_allocations allocation
        JOIN proxy_market_items item ON item.id = allocation.item_id
        WHERE allocation.id = ?
          AND allocation.item_id = ?
          AND allocation.social_proxy_id = ?
          AND allocation.user_id = ?
          AND allocation.status = 'active'
        """,
        (allocation_id, item_id, proxy_id, expected_owner_id),
    ).fetchone()
    if item is None:
        raise ProxyMarketCredentialAuthorizationError(
            "market proxy credential access is not authorized"
        )
    username, password = decrypt_market_credentials(dict(item))
    resolved["username"] = username
    resolved["password"] = password
    return resolved
