import re
from urllib.parse import urlsplit, urlunsplit


def clean_endpoint_input(value: str | None) -> str:
    text = str(value or "").strip()
    while text:
        changed = False
        for marker in ("`", "'", '"'):
            if text.startswith(marker):
                text = text[1:].strip()
                changed = True
            if text.endswith(marker):
                text = text[:-1].strip()
                changed = True
        if not changed:
            break
    return text


def infer_default_scheme(host: str | None, fallback: str = "https") -> str:
    cleaned_host = clean_endpoint_input(host)
    if "://" in cleaned_host:
        parsed = urlsplit(cleaned_host)
        return parsed.scheme or fallback
    host_only = cleaned_host.split("/", 1)[0].split(":", 1)[0].strip().lower()
    if re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", host_only):
        return "http"
    if host_only in {"localhost", "127.0.0.1"}:
        return "http"
    return fallback


def build_model_request_url(*, host: str, path: str, port: str | int | None = None, default_scheme: str = "https") -> str:
    cleaned_host = clean_endpoint_input(host)
    cleaned_path = "/" + str(path or "").lstrip("/")
    cleaned_port = str(port or "").strip()
    if not cleaned_host:
        raise ValueError("host 不能为空")

    if "://" in cleaned_host:
        parsed = urlsplit(cleaned_host)
        if not parsed.scheme or not parsed.netloc:
            raise ValueError(f"无效的接口地址: {cleaned_host}")
        final_path = parsed.path or "/"
        if final_path == "/":
            final_path = cleaned_path
        elif "/v1beta/" not in final_path:
            final_path = final_path.rstrip("/") + cleaned_path
        return urlunsplit((parsed.scheme, parsed.netloc, final_path, parsed.query, parsed.fragment))

    scheme = infer_default_scheme(cleaned_host, fallback=default_scheme)
    if cleaned_port:
        return f"{scheme}://{cleaned_host}:{cleaned_port}{cleaned_path}"
    return f"{scheme}://{cleaned_host}{cleaned_path}"
