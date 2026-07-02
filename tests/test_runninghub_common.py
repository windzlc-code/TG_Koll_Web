import runninghub_common


def test_prepare_request_kwargs_injects_certifi_for_runninghub(monkeypatch):
    monkeypatch.delenv("RH_CA_BUNDLE", raising=False)
    monkeypatch.setattr(runninghub_common.certifi, "where", lambda: "/tmp/cacert.pem")

    options = runninghub_common._prepare_request_kwargs(
        "https://www.runninghub.cn/openapi/v2/media/upload/binary",
        {},
    )

    assert options["verify"] == "/tmp/cacert.pem"


def test_prepare_request_kwargs_preserves_explicit_verify(monkeypatch):
    monkeypatch.setattr(runninghub_common.certifi, "where", lambda: "/tmp/unused.pem")

    options = runninghub_common._prepare_request_kwargs(
        "https://www.runninghub.cn/openapi/v2/query",
        {"verify": "/custom/ca.pem"},
    )

    assert options["verify"] == "/custom/ca.pem"


def test_prepare_request_kwargs_skips_non_runninghub_urls(monkeypatch):
    monkeypatch.setattr(runninghub_common.certifi, "where", lambda: "/tmp/cacert.pem")

    options = runninghub_common._prepare_request_kwargs("https://example.com/api", {})

    assert "verify" not in options


def test_rh_post_forwards_verify_to_requests(monkeypatch):
    monkeypatch.setattr(runninghub_common.certifi, "where", lambda: "/tmp/cacert.pem")
    calls = {}

    def fake_request(method, url, **kwargs):
        calls["method"] = method
        calls["url"] = url
        calls["kwargs"] = kwargs
        return {"ok": True}

    monkeypatch.setattr(runninghub_common.requests, "request", fake_request)

    result = runninghub_common.rh_post("https://www.runninghub.cn/openapi/v2/query", json={"taskId": "123"})

    assert result == {"ok": True}
    assert calls["method"] == "POST"
    assert calls["url"] == "https://www.runninghub.cn/openapi/v2/query"
    assert calls["kwargs"]["verify"] == "/tmp/cacert.pem"
