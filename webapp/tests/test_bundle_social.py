from __future__ import annotations

import json
import threading
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest
from cryptography.fernet import Fernet
from fastapi import FastAPI
from starlette.requests import Request

from social_automation import runner
from webapp.bundle_social import (
    BundleReauthRequiredError,
    BundleSocialClient,
    BundleSocialError,
    _localize_bundle_error,
    _result_thumbnail,
    is_bundle_reauth_required,
    platform_type,
)
from webapp.bundle_social_config import configuration_status, resolve_configuration, save_configuration
from webapp.db import db, init_db
from webapp import social_automation_api


class _Response:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code
        self.ok = 200 <= status_code < 300

    def json(self):
        return self._payload


class _Session:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        return self.responses.pop(0)


class _Logger:
    def __init__(self):
        self.events = []

    def log(self, *args):
        self.events.append(args)


def test_platform_type_is_exact_and_rejects_unknown():
    assert platform_type("threads") == "THREADS"
    assert platform_type("Instagram") == "INSTAGRAM"
    with pytest.raises(BundleSocialError):
        platform_type("facebook")


def test_custom_connect_link_requests_only_selected_platform():
    session = _Session([_Response({"url": "https://provider.example/oauth"})])
    client = BundleSocialClient(api_key="test-key", api_base="https://api.example/api/v1", session=session)

    url = client.create_connect_link(
        team_id="team-1",
        platform="threads",
        redirect_url="https://vecto.example/callback",
    )

    assert url == "https://provider.example/oauth"
    assert session.calls[0][0:2] == ("POST", "https://api.example/api/v1/social-account/connect")
    body = session.calls[0][2]["json"]
    assert body["type"] == "THREADS"
    assert "disableAutoLogin" not in body
    assert "instagramConnectionMethod" not in body
    assert "forceBrowserOAuth" not in body
    assert "socialAccountTypes" not in body
    assert session.calls[0][2]["headers"]["x-api-key"] == "test-key"


def test_custom_connect_link_uses_direct_instagram_browser_oauth():
    session = _Session([_Response({"url": "https://instagram.example/oauth"})])
    client = BundleSocialClient(api_key="test-key", api_base="https://api.example/api/v1", session=session)

    client.create_connect_link(
        team_id="team-1",
        platform="instagram",
        redirect_url="https://vecto.example/callback",
    )

    body = session.calls[0][2]["json"]
    assert body["type"] == "INSTAGRAM"
    assert body["instagramConnectionMethod"] == "INSTAGRAM"
    assert body["forceBrowserOAuth"] is True
    assert "disableAutoLogin" not in body


def test_instagram_connect_link_sends_force_browser_oauth_only_when_requested():
    session = _Session([_Response({"url": "https://instagram.example/oauth"})])
    client = BundleSocialClient(api_key="test-key", api_base="https://api.example/api/v1", session=session)
    client.create_connect_link(
        team_id="team-1",
        platform="instagram",
        redirect_url="https://vecto.example/callback",
        force_browser_oauth=True,
    )
    assert session.calls[0][2]["json"]["forceBrowserOAuth"] is True


def test_new_instagram_connect_link_requests_account_switch():
    session = _Session([_Response({"url": "https://instagram.example/oauth"})])
    client = BundleSocialClient(api_key="test-key", api_base="https://api.example/api/v1", session=session)
    client.create_connect_link(
        team_id="team-1",
        platform="instagram",
        redirect_url="https://vecto.example/callback",
        disable_auto_login=True,
    )
    assert session.calls[0][2]["json"]["disableAutoLogin"] is True


def test_inspect_social_account_treats_live_check_as_valid():
    session = _Session([
        _Response([{"id": "right", "type": "THREADS", "teamId": "team-1", "username": "hiro"}]),
        _Response({"ok": True, "status": "connected"}),
    ])
    client = BundleSocialClient(api_key="test-key", session=session)
    result = client.inspect_social_account(team_id="team-1", platform="threads")
    assert result["valid"] is True
    assert result["account"]["username"] == "hiro"
    assert session.calls[1][0:2][1].endswith("social-account/connection-check")


def test_inspect_social_account_treats_missing_account_as_invalid():
    session = _Session([_Response([])])
    client = BundleSocialClient(api_key="test-key", session=session)
    result = client.inspect_social_account(team_id="team-1", platform="threads")
    assert result == {"valid": False, "reason": "missing"}


def test_connection_check_uses_team_list_without_exposing_key():
    session = _Session([_Response({"items": [{"id": "team-1"}], "total": 3})])
    client = BundleSocialClient(api_key="test-key", api_base="https://api.example/api/v1", session=session)

    result = client.list_teams(limit=1)

    assert result == {"items": [{"id": "team-1"}], "count": 3}
    assert session.calls[0][0:2] == ("GET", "https://api.example/api/v1/team/?limit=1&offset=0")


def test_provider_social_set_limit_error_is_localized():
    session = _Session([_Response({"message": "Social sets limit reached. Limit is 3 sets."}, status_code=400)])
    client = BundleSocialClient(api_key="test-key", api_base="https://api.example/api/v1", session=session)

    with pytest.raises(BundleSocialError) as exc_info:
        client.create_team("vecto-0-threads-request")

    assert str(exc_info.value) == "平台授权账号集合已达上限（最多 3 个），请完成已有授权后再试"


def test_already_connected_team_is_disconnected_then_reconnected():
    session = _Session([
        _Response(
            {"message": "This team already has a Threads account connected. Please disconnect it first."},
            status_code=400,
        ),
        _Response({"ok": True}),
        _Response({"url": "https://provider.example/oauth"}),
    ])
    client = BundleSocialClient(api_key="test-key", api_base="https://api.example/api/v1", session=session)

    url = client.create_connect_link(
        team_id="team-1",
        platform="threads",
        redirect_url="https://vecto.example/callback",
    )

    assert url == "https://provider.example/oauth"
    assert session.calls[0][0:2] == ("POST", "https://api.example/api/v1/social-account/connect")
    assert session.calls[1][0:2] == ("DELETE", "https://api.example/api/v1/social-account/disconnect")
    assert session.calls[1][2]["json"] == {"type": "THREADS", "teamId": "team-1"}
    assert session.calls[2][0:2] == ("POST", "https://api.example/api/v1/social-account/connect")


def test_bundle_english_errors_are_localized_to_chinese():
    assert "已连接 Threads" in _localize_bundle_error(
        "This team already has a Threads account connected. Please disconnect it first."
    )
    assert "已连接 Instagram" in _localize_bundle_error(
        "This team already has an Instagram account connected. Please disconnect it first."
    )
    assert _localize_bundle_error("Unauthorized") == "平台授权服务验证失败，请联系管理员"
    assert _localize_bundle_error("Some unexpected English failure from provider") == "平台未接受本次请求，请稍后重试"
    assert _localize_bundle_error("平台授权服务尚未配置") == "平台授权服务尚未配置"
    assert "500 字" in _localize_bundle_error("Text exceeds the 500 character limit")
    assert "320-1440px" in _localize_bundle_error("Image width must be between 320 and 1440 pixels")
    assert "浪费额度" in _localize_bundle_error("Invalid media: aspect ratio is not supported")
    assert "8MB" in _localize_bundle_error("File too large: image exceeds 8MB")


def test_already_connected_error_without_reconnect_url_stays_chinese():
    session = _Session([
        _Response(
            {"message": "This team already has a Threads account connected. Please disconnect it first."},
            status_code=400,
        ),
        _Response({"ok": True}),
        _Response({"message": "This team already has a Threads account connected. Please disconnect it first."}, status_code=400),
    ])
    client = BundleSocialClient(api_key="test-key", api_base="https://api.example/api/v1", session=session)
    with pytest.raises(BundleSocialError) as exc_info:
        client.create_connect_link(
            team_id="team-1",
            platform="threads",
            redirect_url="https://vecto.example/callback",
        )
    assert "已连接 Threads" in str(exc_info.value)
    assert "Please disconnect" not in str(exc_info.value)


def test_find_social_account_checks_team_and_platform():
    session = _Session(
        [
            _Response(
                [
                    {"id": "wrong", "type": "INSTAGRAM", "teamId": "team-1"},
                    {"id": "right", "type": "THREADS", "teamId": "team-1", "username": "owner"},
                ]
            )
        ]
    )
    client = BundleSocialClient(api_key="test-key", session=session)
    assert client.find_social_account(team_id="team-1", platform="threads")["id"] == "right"


def test_disconnect_social_account_releases_selected_team_slot():
    session = _Session([_Response({"id": "external-1", "type": "THREADS", "teamId": "team-1"})])
    client = BundleSocialClient(api_key="test-key", api_base="https://api.example/api/v1", session=session)

    client.disconnect_social_account(team_id="team-1", platform="threads")

    assert session.calls[0][0:2] == ("DELETE", "https://api.example/api/v1/social-account/disconnect")
    assert session.calls[0][2]["json"] == {"type": "THREADS", "teamId": "team-1"}


def test_upload_uses_documented_trailing_slash_endpoint(tmp_path):
    media = tmp_path / "photo.jpg"
    media.write_bytes(b"jpeg")
    session = _Session([_Response({"id": "upload-1"})])
    client = BundleSocialClient(api_key="test-key", api_base="https://api.example/api/v1", session=session)

    assert client.upload_file(team_id="team-1", path=media) == "upload-1"
    assert session.calls[0][0:2] == ("POST", "https://api.example/api/v1/upload/")
    assert session.calls[0][2]["data"] == {"teamId": "team-1"}


def test_result_thumbnail_prefers_platform_external_data():
    assert _result_thumbnail({
        "id": "post-1",
        "status": "POSTED",
        "externalData": {
            "THREADS": {
                "permalink": "https://www.threads.net/@hiro/post/abc",
                "thumbnail": "https://cdn.example/post.jpg",
            }
        },
    }) == "https://cdn.example/post.jpg"
    assert _result_thumbnail({
        "id": "post-1",
        "status": "POSTED",
        "externalData": {"THREADS": {"permalink": "https://www.threads.net/@hiro/post/abc"}},
    }) == ""


def test_first_mapping_keeps_post_id_when_platform_data_is_present():
    from webapp.bundle_social import _first_mapping

    mapped = _first_mapping({
        "id": "post-1",
        "status": "SCHEDULED",
        "data": {"THREADS": {"text": "hello", "uploadIds": ["u1"]}},
        "externalData": {"THREADS": {"permalink": "https://www.threads.net/@hiro/post/abc"}},
    })
    assert mapped["id"] == "post-1"
    assert mapped["status"] == "SCHEDULED"
    assert mapped["data"]["THREADS"]["text"] == "hello"


def test_bundle_publish_success_proof_is_posted_status_and_permalink(monkeypatch):
    from webapp.bundle_social import run_bundle_social_task

    class _Client:
        def create_post(self, **_kwargs):
            return {
                "id": "post-1",
                "status": "SCHEDULED",
                "data": {"THREADS": {"text": "hello"}},
            }

        def wait_for_result(self, **_kwargs):
            return {
                "id": "post-1",
                "status": "POSTED",
                "externalData": {
                    "THREADS": {
                        "id": "ext-1",
                        "permalink": "https://www.threads.net/@hiro504522/post/abc",
                        "thumbnail": "https://cdn.example/threads-post.jpg",
                    }
                },
            }

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", lambda: _Client())
    result = run_bundle_social_task(
        task={"id": "task-1", "task_type": "publish_post", "platform": "threads", "payload": {"content": "hello"}},
        account={"external_team_id": "team-1", "external_account_id": "social-1", "platform": "threads"},
        logger=_Logger(),
    )
    assert result["ok"] is True
    assert result["provider"] == "bundle"
    assert result["bundle_post_id"] == "post-1"
    assert result["status"] == "POSTED"
    assert result["url"] == "https://www.threads.net/@hiro504522/post/abc"
    assert result["published_url"] == result["url"]
    assert result["published"]["confirmed"] is True
    assert result["published"]["permalink"] == result["url"]
    assert result["screenshot_url"] == "https://cdn.example/threads-post.jpg"
    assert result["published"]["thumbnail"] == result["screenshot_url"]
    assert social_automation_api._confirmed_published_url(result, "threads") == "https://www.threads.net/@hiro504522/post/abc"


def test_create_post_uses_selected_platform_and_reference_key():
    session = _Session([_Response({
        "id": "post-1",
        "status": "SCHEDULED",
        "data": {"INSTAGRAM": {"text": "hello", "uploadIds": ["upload-1"]}},
    })])
    client = BundleSocialClient(api_key="test-key", session=session)

    created = client.create_post(
        team_id="team-1",
        platform="instagram",
        text="hello",
        upload_ids=["upload-1"],
        reference_key="task-1",
    )

    assert created["id"] == "post-1"
    body = session.calls[0][2]["json"]
    assert body["teamId"] == "team-1"
    assert body["socialAccountTypes"] == ["INSTAGRAM"]
    assert body["referenceKey"] == "task-1"
    assert body["data"]["INSTAGRAM"] == {
        "text": "hello",
        "uploadIds": ["upload-1"],
        "type": "POST",
        "autoFitImage": True,
    }


def test_create_post_uses_reel_for_single_instagram_video(tmp_path):
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"mp4")
    session = _Session([_Response({"id": "post-1", "status": "SCHEDULED"})])
    client = BundleSocialClient(api_key="test-key", session=session)

    client.create_post(
        team_id="team-1",
        platform="instagram",
        text="hello",
        upload_ids=["upload-1"],
        reference_key="task-video",
        media_paths=[str(video)],
    )

    body = session.calls[0][2]["json"]
    assert body["data"]["INSTAGRAM"] == {
        "text": "hello",
        "uploadIds": ["upload-1"],
        "type": "REEL",
        "shareToFeed": True,
    }


def test_create_post_keeps_feed_post_for_instagram_images_and_mixed_media(tmp_path):
    image = tmp_path / "photo.jpg"
    image.write_bytes(b"jpeg")
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"mp4")
    session = _Session([
        _Response({"id": "post-img", "status": "SCHEDULED"}),
        _Response({"id": "post-mix", "status": "SCHEDULED"}),
    ])
    client = BundleSocialClient(api_key="test-key", session=session)

    client.create_post(
        team_id="team-1",
        platform="instagram",
        text="photo",
        upload_ids=["upload-img"],
        reference_key="task-img",
        media_paths=[str(image)],
    )
    client.create_post(
        team_id="team-1",
        platform="instagram",
        text="carousel",
        upload_ids=["upload-img", "upload-vid"],
        reference_key="task-mix",
        media_paths=[str(image), str(video)],
    )

    assert session.calls[0][2]["json"]["data"]["INSTAGRAM"] == {
        "text": "photo",
        "uploadIds": ["upload-img"],
        "type": "POST",
        "autoFitImage": True,
    }
    assert session.calls[1][2]["json"]["data"]["INSTAGRAM"] == {
        "text": "carousel",
        "uploadIds": ["upload-img", "upload-vid"],
        "type": "POST",
        "autoFitImage": True,
    }


def test_threads_create_post_accepts_text_image_and_video_without_type(tmp_path):
    image = tmp_path / "photo.jpg"
    image.write_bytes(b"jpeg")
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"mp4")
    session = _Session([
        _Response({"id": "post-text", "status": "SCHEDULED"}),
        _Response({"id": "post-media", "status": "SCHEDULED"}),
    ])
    client = BundleSocialClient(api_key="test-key", session=session)

    client.create_post(
        team_id="team-1",
        platform="threads",
        text="hello",
        upload_ids=[],
        reference_key="task-text",
    )
    client.create_post(
        team_id="team-1",
        platform="threads",
        text="media",
        upload_ids=["u-img", "u-vid"],
        reference_key="task-media",
        media_paths=[str(image), str(video)],
    )

    assert session.calls[0][2]["json"]["data"]["THREADS"] == {"text": "hello", "uploadIds": []}
    assert session.calls[1][2]["json"]["data"]["THREADS"] == {
        "text": "media",
        "uploadIds": ["u-img", "u-vid"],
    }


def test_expired_access_token_is_classified_as_reauth_required():
    assert is_bundle_reauth_required("Error validating access token. Session has expired.")
    assert is_bundle_reauth_required("Please reconnect the account")
    assert not is_bundle_reauth_required("平台接口未返回发布任务编号")
    assert not is_bundle_reauth_required("Instagram 发布至少需要一份媒体素材")


def test_wait_for_result_raises_reauth_required_on_expired_token():
    session = _Session([
        _Response({
            "id": "post-1",
            "status": "ERROR",
            "errorsVerbose": {
                "THREADS": {"userFacingMessage": "Error validating access token. Session has expired."},
            },
        })
    ])
    client = BundleSocialClient(api_key="test-key", session=session)
    with pytest.raises(BundleReauthRequiredError):
        client.wait_for_result(resource="post", resource_id="post-1", timeout_seconds=5)


def test_instagram_bundle_publish_success_proof_is_posted_status_and_permalink(monkeypatch):
    from webapp.bundle_social import run_bundle_social_task

    class _Client:
        def upload_file(self, **_kwargs):
            return "upload-1"

        def create_post(self, **kwargs):
            assert kwargs["platform"] == "instagram"
            assert kwargs["media_paths"] == ["clip.mp4"]
            return {"id": "post-ig", "status": "SCHEDULED", "data": {"INSTAGRAM": {"type": "REEL"}}}

        def wait_for_result(self, **_kwargs):
            return {
                "id": "post-ig",
                "status": "POSTED",
                "externalData": {
                    "INSTAGRAM": {
                        "id": "ext-ig",
                        "permalink": "https://www.instagram.com/reel/abc123/",
                        "thumbnail": "https://cdn.example/ig-reel.jpg",
                    }
                },
            }

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", lambda: _Client())
    result = run_bundle_social_task(
        task={
            "id": "task-ig",
            "task_type": "publish_post",
            "platform": "instagram",
            "payload": {"content": "hello", "media_paths": ["clip.mp4"]},
        },
        account={"external_team_id": "team-1", "external_account_id": "social-1", "platform": "instagram"},
        logger=_Logger(),
    )
    assert result["ok"] is True
    assert result["status"] == "POSTED"
    assert result["url"] == "https://www.instagram.com/reel/abc123/"
    assert result["published"]["confirmed"] is True
    assert result["screenshot_url"] == "https://cdn.example/ig-reel.jpg"
    assert social_automation_api._confirmed_published_url(result, "instagram") == "https://www.instagram.com/reel/abc123/"


def test_expired_token_does_not_start_fingerprint_reauthorization():
    ok = social_automation_api._requeue_for_bundle_reauth(
        "task-1",
        BundleReauthRequiredError("Error validating access token. Session has expired."),
    )
    assert ok is False


def test_create_comment_uses_imported_post_without_inventing_reference_key():
    session = _Session([_Response({"id": "comment-1", "status": "SCHEDULED"})])
    client = BundleSocialClient(api_key="test-key", session=session)

    created = client.create_comment(
        team_id="team-1",
        platform="threads",
        text="reply",
        imported_post_id="imported-1",
    )

    assert created["id"] == "comment-1"
    body = session.calls[0][2]["json"]
    assert body["socialAccountTypes"] == ["THREADS"]
    assert body["importedPostId"] == "imported-1"
    assert "internalPostId" not in body
    assert "referenceKey" not in body


def test_reply_to_imported_comment_uses_minimal_fetched_parent_payload():
    session = _Session([_Response({"id": "comment-2", "status": "SCHEDULED"})])
    client = BundleSocialClient(api_key="test-key", session=session)

    client.create_comment(
        team_id="team-1",
        platform="threads",
        text="reply",
        imported_post_id="imported-1",
        fetched_parent_comment_id="fetched-1",
    )

    assert session.calls[0][2]["json"] == {
        "teamId": "team-1",
        "fetchedParentCommentId": "fetched-1",
        "text": "reply",
    }


def test_bundle_runner_dispatch_does_not_open_browser(monkeypatch, tmp_path):
    called = {}

    def fake_run_bundle_social_task(**kwargs):
        called.update(kwargs)
        return {"ok": True, "provider": "bundle"}

    monkeypatch.setattr("webapp.bundle_social.run_bundle_social_task", fake_run_bundle_social_task)
    monkeypatch.setattr(
        runner,
        "_open_camoufox_context",
        lambda **_: pytest.fail("Bundle account must not start Camoufox"),
    )
    logger = _Logger()
    result = runner.run_social_task(
        task={
            "id": "task-1",
            "task_type": "publish_post",
            "platform": "threads",
            "payload": {"content": "hello"},
        },
        account={
            "id": "account-1",
            "platform": "threads",
            "auth_provider": "bundle",
            "external_team_id": "team-1",
            "external_account_id": "social-1",
        },
        proxy=None,
        data_dir=tmp_path,
        logger=logger,
        cancel_event=threading.Event(),
    )
    assert result == {"ok": True, "provider": "bundle"}
    assert called["task"]["payload"]["content"] == "hello"
    assert any(event[1] == "bundle_dispatch" for event in logger.events)


def test_instagram_bundle_runner_dispatch_does_not_open_browser(monkeypatch, tmp_path):
    called = {}

    def fake_run_bundle_social_task(**kwargs):
        called.update(kwargs)
        return {"ok": True, "provider": "bundle"}

    monkeypatch.setattr("webapp.bundle_social.run_bundle_social_task", fake_run_bundle_social_task)
    monkeypatch.setattr(
        runner,
        "_open_camoufox_context",
        lambda **_: pytest.fail("Bundle account must not start Camoufox"),
    )
    logger = _Logger()
    result = runner.run_social_task(
        task={
            "id": "task-ig",
            "task_type": "publish_post",
            "platform": "instagram",
            "payload": {"content": "hello", "media_paths": ["clip.mp4"]},
        },
        account={
            "id": "account-ig",
            "platform": "instagram",
            "auth_provider": "bundle",
            "external_team_id": "team-ig",
            "external_account_id": "social-ig",
        },
        proxy=None,
        data_dir=tmp_path,
        logger=logger,
        cancel_event=threading.Event(),
    )
    assert result == {"ok": True, "provider": "bundle"}
    assert called["task"]["platform"] == "instagram"
    assert called["task"]["payload"]["media_paths"] == ["clip.mp4"]
    assert called["account"]["external_account_id"] == "social-ig"
    assert any(event[1] == "bundle_dispatch" for event in logger.events)


def test_prepare_publish_media_downscales_threads_oversize_image(tmp_path):
    from PIL import Image
    from webapp.bundle_social import prepare_publish_media_paths

    source = tmp_path / "hot.jpg"
    Image.new("RGB", (1920, 1920), (20, 80, 160)).save(source, format="JPEG", quality=90)
    logger = _Logger()
    prepared = prepare_publish_media_paths("threads", [str(source)], logger=logger)
    assert len(prepared) == 1
    dest = Path(prepared[0])
    assert dest != source
    assert dest.is_file()
    with Image.open(dest) as image:
        assert image.size == (1440, 1440)
    assert dest.stat().st_size <= 8 * 1024 * 1024
    assert any(event[1] == "bundle_publish_media_prepared" for event in logger.events)


def test_prepare_publish_media_keeps_compliant_threads_image(tmp_path):
    from PIL import Image
    from webapp.bundle_social import prepare_publish_media_paths

    source = tmp_path / "ok.jpg"
    Image.new("RGB", (1080, 1080), (10, 10, 10)).save(source, format="JPEG", quality=90)
    prepared = prepare_publish_media_paths("threads", [str(source)], logger=_Logger())
    assert prepared == [str(source)]


def test_prepare_publish_media_fits_threads_wide_aspect(tmp_path):
    from PIL import Image
    from webapp.bundle_social import prepare_publish_media_paths

    source = tmp_path / "pano.jpg"
    Image.new("RGB", (3000, 1000), (80, 80, 80)).save(source, format="JPEG", quality=90)
    dest = Path(prepare_publish_media_paths("threads", [str(source)], logger=_Logger())[0])
    with Image.open(dest) as image:
        width, height = image.size
    assert width <= 1440
    assert width >= 320
    assert width / height <= 10 + 1e-6


def test_prepare_publish_media_fits_instagram_tall_aspect(tmp_path):
    from PIL import Image
    from webapp.bundle_social import prepare_publish_media_paths

    source = tmp_path / "tall.jpg"
    Image.new("RGB", (800, 2000), (90, 90, 90)).save(source, format="JPEG", quality=90)
    dest = Path(prepare_publish_media_paths("instagram", [str(source)], logger=_Logger())[0])
    with Image.open(dest) as image:
        width, height = image.size
    assert width <= 1920
    assert 0.8 - 1e-6 <= width / height <= 1.91 + 1e-6


def test_threads_bundle_publish_prepares_oversize_image_before_upload(monkeypatch, tmp_path):
    from PIL import Image
    from webapp.bundle_social import run_bundle_social_task

    source = tmp_path / "wide.jpg"
    Image.new("RGB", (1920, 1920), (30, 30, 30)).save(source, format="JPEG", quality=90)
    uploaded = {}

    class _Client:
        def upload_file(self, **kwargs):
            uploaded["path"] = kwargs["path"]
            return "upload-1"

        def create_post(self, **kwargs):
            uploaded["create_paths"] = kwargs["media_paths"]
            return {"id": "post-1", "status": "SCHEDULED"}

        def wait_for_result(self, **_kwargs):
            return {
                "id": "post-1",
                "status": "POSTED",
                "externalData": {"THREADS": {"permalink": "https://www.threads.net/@caiyu739/post/abc"}},
            }

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", lambda: _Client())
    logger = _Logger()
    result = run_bundle_social_task(
        task={
            "id": "task-media",
            "task_type": "publish_post",
            "platform": "threads",
            "payload": {"content": "hello", "media_paths": [str(source)]},
        },
        account={"external_team_id": "team-1", "external_account_id": "social-1", "platform": "threads"},
        logger=logger,
    )
    assert result["ok"] is True
    prepared = Path(uploaded["path"])
    assert prepared != source
    with Image.open(prepared) as image:
        assert image.size[0] <= 1440
    assert uploaded["create_paths"] == [str(prepared)]
    assert any(event[1] == "bundle_publish_media_prepared" for event in logger.events)


def test_threads_bundle_publish_rejects_overlong_caption(monkeypatch):
    from webapp.bundle_social import run_bundle_social_task

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", lambda: object())
    with pytest.raises(BundleSocialError, match="正文不能超过 500 字"):
        run_bundle_social_task(
            task={
                "id": "task-long-text",
                "task_type": "publish_post",
                "platform": "threads",
                "payload": {"content": "a" * 761},
            },
            account={
                "external_team_id": "team-1",
                "external_account_id": "social-1",
                "platform": "threads",
            },
            logger=_Logger(),
        )


def test_instagram_bundle_publish_rejects_text_only(monkeypatch):
    from webapp.bundle_social import run_bundle_social_task

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", lambda: object())
    with pytest.raises(BundleSocialError, match="Instagram 发布至少需要一份媒体素材"):
        run_bundle_social_task(
            task={
                "id": "task-ig-text",
                "task_type": "publish_post",
                "platform": "instagram",
                "payload": {"content": "hello"},
            },
            account={
                "external_team_id": "team-ig",
                "external_account_id": "social-ig",
                "platform": "instagram",
            },
            logger=_Logger(),
        )


def test_bundle_account_storage_migration(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "bundle.db"))
    init_db()
    with db() as conn:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(social_accounts)")}
        auth_table = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'social_account_auth_requests'"
        ).fetchone()
    assert {"auth_provider", "external_team_id", "external_account_id", "authorized_at"} <= columns
    assert auth_table["name"] == "social_account_auth_requests"


def test_bundle_system_config_is_encrypted_and_used_at_runtime(monkeypatch, tmp_path):
    raw_key = "bundle-secret-key"
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "bundle-config.db"))
    monkeypatch.setenv("PASSWORD_VAULT_KEY", Fernet.generate_key().decode("ascii"))
    monkeypatch.delenv("BUNDLE_SOCIAL_API_KEY", raising=False)
    init_db()

    with db() as conn:
        status = save_configuration(
            conn,
            api_base_url="https://api.bundle.social/api/v1",
            api_key=raw_key,
            actor_user_id=1,
        )
        stored = conn.execute("SELECT * FROM bundle_social_provider_config WHERE id = 1").fetchone()
        resolved = resolve_configuration(conn)
        public_status = configuration_status(conn)

    assert status["configured"] is True
    assert status["verified"] is True
    assert raw_key not in str(stored["api_key_ciphertext"])
    assert resolved["api_key"] == raw_key
    assert "api_key" not in public_status
    client = BundleSocialClient()
    assert client.api_key == raw_key
    assert client.api_base == "https://api.bundle.social/api/v1"


def test_bundle_callback_url_uses_forwarded_public_origin(monkeypatch):
    monkeypatch.delenv("HTTPS_CANONICAL_ORIGIN", raising=False)
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "http",
            "server": ("127.0.0.1", 8000),
            "path": "/api/persona_dashboard/automation/accounts/bundle/authorize",
            "headers": [
                (b"host", b"127.0.0.1:8000"),
                (b"x-forwarded-proto", b"https"),
                (b"x-forwarded-host", b"www.vecto-ai.cn"),
            ],
        }
    )

    callback_url = social_automation_api._bundle_callback_url(request, "bundle_auth_1")

    assert callback_url == (
        "https://www.vecto-ai.cn/api/persona_dashboard/automation/accounts/bundle/callback"
        "?request_id=bundle_auth_1"
    )


def test_bundle_callback_url_prefers_server_canonical_origin(monkeypatch):
    monkeypatch.setenv("HTTPS_CANONICAL_ORIGIN", "https://www.vecto-ai.cn")
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "http",
            "server": ("127.0.0.1", 8000),
            "path": "/api/persona_dashboard/automation/accounts/bundle/authorize",
            "headers": [(b"host", b"untrusted.example")],
        }
    )

    callback_url = social_automation_api._bundle_callback_url(request, "bundle_auth_2")

    assert callback_url == (
        "https://www.vecto-ai.cn/api/persona_dashboard/automation/accounts/bundle/callback"
        "?request_id=bundle_auth_2"
    )


def test_bundle_callback_url_preserves_admin_account_pool_return(monkeypatch):
    monkeypatch.setenv("HTTPS_CANONICAL_ORIGIN", "https://www.vecto-ai.cn")
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "server": ("www.vecto-ai.cn", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/authorize",
            "headers": [],
        }
    )

    callback_url = social_automation_api._bundle_callback_url(
        request,
        "bundle_auth_admin",
        return_path="/admin-console.html?view=accounts&admin_console=1&admin_workspace_user_id=42",
    )

    parsed = urlparse(callback_url)
    callback_query = parse_qs(parsed.query)
    assert callback_query["request_id"] == ["bundle_auth_admin"]
    assert callback_query["return_path"] == [
        "/admin-console.html?view=accounts&admin_console=1&admin_workspace_user_id=42"
    ]


def test_bundle_console_redirect_keeps_admin_session_boundary():
    response = social_automation_api._bundle_console_redirect(
        status="success",
        platform="threads",
        message="授权成功",
        return_path="/admin-console.html?view=accounts&admin_console=1&admin_workspace_user_id=42",
    )

    parsed = urlparse(response.headers["location"])
    query = parse_qs(parsed.query)
    assert parsed.path == "/admin-console.html"
    assert query["bundle_auth"] == ["success"]
    assert query["bundle_platform"] == ["threads"]
    assert query["admin_console"] == ["1"]
    assert query["admin_workspace_user_id"] == ["42"]


def test_bundle_cancel_returns_to_existing_account_pool_without_redirect_refresh():
    response = social_automation_api._bundle_cancel_return_response(
        return_path="/console.html?view=accounts",
    )
    assert response.status_code == 302
    assert response.headers["location"] == "/console.html?view=accounts"
    assert "bundle_auth=" not in response.headers["location"]


def test_bundle_callback_cancel_does_not_reload_console_query(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "callback-cancel.db"))
    init_db()
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_account_auth_requests(
              id, user_id, persona_id, account_id, platform, team_id,
              status, error, expires_at, created_at, updated_at
            ) VALUES ('request-cancel', 0, '', '', 'instagram', 'team-1', 'pending', '', ?, ?, ?)
            """,
            (now + 900, now, now),
        )
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/callback",
            "query_string": b"request_id=request-cancel&error=access_denied",
            "headers": [],
        }
    )
    response = social_automation_api._finalize_bundle_authorization("request-cancel", request)
    assert response.status_code == 302
    assert response.headers["location"] == "/console.html?view=accounts"
    assert "bundle_auth=" not in response.headers["location"]
    with db() as conn:
        row = conn.execute(
            "SELECT status FROM social_account_auth_requests WHERE id = 'request-cancel'"
        ).fetchone()
    assert row["status"] == "failed"


def test_bundle_console_redirect_rejects_external_return_path():
    response = social_automation_api._bundle_console_redirect(
        status="error",
        platform="threads",
        return_path="https://attacker.example/admin-console.html?admin_console=1",
    )

    parsed = urlparse(response.headers["location"])
    assert parsed.path == "/console.html"
    assert parse_qs(parsed.query)["bundle_auth"] == ["error"]


def test_bundle_authorization_status_is_scoped_to_owner(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "bundle-status.db"))
    init_db()
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_account_auth_requests(
              id, user_id, persona_id, account_id, platform, team_id,
              status, error, expires_at, created_at, updated_at
            ) VALUES ('request-status', 7, '', 'account-9', 'threads', 'team-9', 'completed', '', ?, ?, ?)
            """,
            (now + 900, now, now),
        )
    monkeypatch.setattr(social_automation_api, "_identity_user_id", lambda _user: 7)
    from fastapi import FastAPI

    app = FastAPI()
    social_automation_api.register_social_automation_routes(app)
    handler = next(
        route.endpoint
        for route in app.routes
        if getattr(route, "path", "") == "/api/persona_dashboard/automation/accounts/bundle/status"
    )
    result = handler(request_id="request-status", user={"id": 7})
    assert result["ok"] is True
    assert result["status"] == "completed"
    assert result["account_id"] == "account-9"
    assert result["platform"] == "threads"


def test_bundle_authorization_return_path_uses_admin_workspace_boundary():
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "server": ("www.vecto-ai.cn", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/authorize",
            "query_string": b"",
            "headers": [(b"x-admin-console", b"1")],
        }
    )

    return_path = social_automation_api._bundle_authorization_return_path(
        request,
        {"id": 1, "_workspace_admin_user_id": 1, "_workspace_user_id": 42},
    )

    assert return_path == (
        "/admin-console.html?view=accounts&admin_console=1&admin_workspace_user_id=42"
    )


def test_bundle_callback_persists_only_verified_platform_account(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "callback.db"))
    init_db()
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_account_auth_requests(
              id, user_id, persona_id, account_id, platform, team_id,
              status, error, expires_at, created_at, updated_at
            ) VALUES ('request-1', 0, '', '', 'threads', 'team-1', 'pending', '', ?, ?, ?)
            """,
            (now + 900, now, now),
        )

    class _Client:
        def find_social_account(self, *, team_id, platform):
            assert (team_id, platform) == ("team-1", "threads")
            return {
                "id": "external-1",
                "type": "THREADS",
                "teamId": "team-1",
                "username": "verified_owner",
                "displayName": "Verified Owner",
            }

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/callback",
            "query_string": b"request_id=request-1&callback=threads-callback",
            "headers": [],
        }
    )
    response = social_automation_api._finalize_bundle_authorization("request-1", request)
    with db() as conn:
        account = conn.execute("SELECT * FROM social_accounts").fetchone()
        auth_request = conn.execute("SELECT * FROM social_account_auth_requests WHERE id = 'request-1'").fetchone()
    assert response.status_code == 302
    assert "bundle_auth=success" in response.headers["location"]
    assert account["platform"] == "threads"
    assert account["auth_provider"] == "bundle"
    assert account["external_team_id"] == "team-1"
    assert account["external_account_id"] == "external-1"
    assert auth_request["status"] == "completed"


def test_instagram_callback_persists_bundle_account_for_api_publish(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "ig-callback.db"))
    init_db()
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_account_auth_requests(
              id, user_id, persona_id, account_id, platform, team_id,
              status, error, expires_at, created_at, updated_at
            ) VALUES ('request-ig', 0, 'persona-ig', '', 'instagram', 'team-ig', 'pending', '', ?, ?, ?)
            """,
            (now + 900, now, now),
        )

    class _Client:
        def find_social_account(self, *, team_id, platform):
            assert (team_id, platform) == ("team-ig", "instagram")
            return {
                "id": "external-ig",
                "type": "INSTAGRAM",
                "teamId": "team-ig",
                "username": "ig_verified",
                "displayName": "IG Verified",
            }

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/callback",
            "query_string": b"request_id=request-ig&callback=instagram-callback",
            "headers": [],
        }
    )
    response = social_automation_api._finalize_bundle_authorization("request-ig", request)
    with db() as conn:
        account = conn.execute("SELECT * FROM social_accounts").fetchone()
        auth_request = conn.execute("SELECT * FROM social_account_auth_requests WHERE id = 'request-ig'").fetchone()
    assert response.status_code == 302
    assert "bundle_auth=success" in response.headers["location"]
    assert account["platform"] == "instagram"
    assert account["persona_id"] == "persona-ig"
    assert account["auth_provider"] == "bundle"
    assert account["status"] == "ready"
    assert account["external_team_id"] == "team-ig"
    assert account["external_account_id"] == "external-ig"
    assert auth_request["status"] == "completed"
    assert auth_request["account_id"] == account["id"]


def test_bundle_callback_reauthorization_reuses_same_external_account(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "reauthorize.db"))
    init_db()
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_accounts(
              id, user_id, persona_id, platform, username, display_name, profile_dir,
              status, auth_provider, external_team_id, external_account_id,
              authorized_at, created_at, updated_at
            ) VALUES ('account-1', 0, '', 'threads', 'owner', 'Owner', '', 'ready',
                      'bundle', 'team-old', 'external-1', ?, ?, ?)
            """,
            (now, now, now),
        )
        conn.execute(
            """
            INSERT INTO social_account_auth_requests(
              id, user_id, persona_id, account_id, platform, team_id,
              status, error, expires_at, created_at, updated_at
            ) VALUES ('request-2', 0, '', 'account-1', 'threads', 'team-new', 'pending', '', ?, ?, ?)
            """,
            (now + 900, now, now),
        )

    class _Client:
        def find_social_account(self, *, team_id, platform):
            return {
                "id": "external-1",
                "type": "THREADS",
                "teamId": team_id,
                "username": "owner",
            }

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/callback",
            "query_string": b"request_id=request-2&threads-callback=success",
            "headers": [],
        }
    )

    response = social_automation_api._finalize_bundle_authorization("request-2", request)

    with db() as conn:
        accounts = conn.execute("SELECT * FROM social_accounts").fetchall()
    assert response.status_code == 302
    assert len(accounts) == 1
    assert accounts[0]["id"] == "account-1"
    assert accounts[0]["external_team_id"] == "team-new"


def test_bundle_new_authorization_rejects_same_identity_and_releases_team(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "same-identity-new-bundle-id.db"))
    init_db()
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_accounts(
              id, user_id, persona_id, platform, username, display_name, profile_dir,
              status, auth_provider, external_team_id, external_account_id,
              authorized_at, created_at, updated_at
            ) VALUES ('account-existing', 0, 'persona-1', 'threads', 'same_owner',
                      'Old Name', 'profiles/old', 'ready', 'bundle', 'team-old',
                      'external-old', ?, ?, ?)
            """,
            (now, now, now),
        )
        conn.execute(
            """
            INSERT INTO social_account_auth_requests(
              id, user_id, persona_id, account_id, platform, team_id,
              status, error, expires_at, created_at, updated_at
            ) VALUES ('request-upgrade', 0, 'persona-1', '', 'threads', 'team-new',
                      'pending', '', ?, ?, ?)
            """,
            (now + 900, now, now),
        )

    disconnected = []

    class _Client:
        def find_social_account(self, *, team_id, platform):
            assert (team_id, platform) == ("team-new", "threads")
            return {
                "id": "external-new",
                "type": "THREADS",
                "teamId": team_id,
                "username": "same_owner",
                "displayName": "Current Name",
            }

        def disconnect_social_account(self, *, team_id, platform):
            disconnected.append((team_id, platform))

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/callback",
            "query_string": b"request_id=request-upgrade&threads-callback=success",
            "headers": [],
        }
    )

    response = social_automation_api._finalize_bundle_authorization("request-upgrade", request)

    with db() as conn:
        accounts = conn.execute("SELECT * FROM social_accounts").fetchall()
        auth_request = conn.execute(
            "SELECT account_id, status FROM social_account_auth_requests WHERE id = 'request-upgrade'"
        ).fetchone()
    assert response.status_code == 302
    assert "bundle_auth=error" in response.headers["location"]
    assert "%E5%B7%B2%E5%AD%98%E5%9C%A8" in response.headers["location"]
    assert len(accounts) == 1
    assert accounts[0]["id"] == "account-existing"
    assert accounts[0]["auth_provider"] == "bundle"
    assert accounts[0]["external_team_id"] == "team-old"
    assert accounts[0]["external_account_id"] == "external-old"
    assert accounts[0]["username"] == "same_owner"
    assert accounts[0]["display_name"] == "Old Name"
    assert (auth_request["account_id"], auth_request["status"]) == ("", "failed")
    assert disconnected == [("team-new", "threads")]


def test_bundle_callback_route_does_not_require_console_session():
    app = FastAPI()
    social_automation_api.register_social_automation_routes(app)
    callback = next(
        route
        for route in app.routes
        if getattr(route, "path", "") == "/api/persona_dashboard/automation/accounts/bundle/callback"
    )

    assert callback.dependant.dependencies == []


def test_bundle_new_account_still_obeys_threads_account_limit(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "account-limit.db"))
    init_db()
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_accounts(
              id, user_id, persona_id, platform, username, display_name, profile_dir,
              status, created_at, updated_at
            ) VALUES ('account-1', 0, 'persona-1', 'threads', 'first_owner', 'First Owner', '',
                      'ready', ?, ?)
            """,
            (now, now),
        )

    monkeypatch.setattr(social_automation_api, "_identity_user_id", lambda _: 0)
    monkeypatch.setattr(social_automation_api, "_require_persona_reference_access", lambda *_: None)
    monkeypatch.setattr(social_automation_api, "_require_active_owner_user", lambda *_: None)
    monkeypatch.setattr(social_automation_api, "_billing_admin_waived", lambda *_: False)
    monkeypatch.setattr(social_automation_api.commercial_billing, "require_write_access", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(social_automation_api.commercial_billing, "threads_account_limit", lambda *_args, **_kwargs: 1)
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/authorize",
            "query_string": b"",
            "headers": [],
        }
    )

    with pytest.raises(social_automation_api.commercial_billing.BillingError) as exc_info:
        social_automation_api._start_bundle_authorization(
            social_automation_api.BundleAuthorizationPayload(platform="threads", persona_id="persona-1"),
            request,
            {"id": 0},
        )

    assert exc_info.value.code == "THREADS_ACCOUNT_LIMIT"


def test_bundle_authorization_reuses_existing_empty_team(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "reuse-empty-team.db"))
    init_db()
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_account_auth_requests(
              id, user_id, persona_id, account_id, platform, team_id,
              status, error, expires_at, created_at, updated_at
            ) VALUES ('request-old', 0, '', '', 'threads', 'team-empty', 'failed', 'cancelled', ?, ?, ?)
            """,
            (now - 1, now - 30, now - 20),
        )

    class _Client:
        def list_teams(self, *, limit):
            assert limit == 100
            return {
                "items": [
                    {
                        "id": "team-empty",
                        "name": "vecto-0-threads-oldrequest",
                        "socialAccounts": [],
                    },
                    {
                        "id": "team-connected",
                        "name": "vecto-0-threads-connected",
                        "socialAccounts": [{"id": "social-existing", "type": "THREADS"}],
                    },
                ],
                "count": 2,
            }

        def create_team(self, _name):
            pytest.fail("an existing empty authorization team must be reused")

        def create_connect_link(self, *, team_id, platform, redirect_url, disable_auto_login=False, **_kwargs):
            assert (team_id, platform) == ("team-empty", "threads")
            assert "request_id=" in redirect_url
            return "https://provider.example/oauth"

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    monkeypatch.setattr(social_automation_api, "_identity_user_id", lambda _: 0)
    monkeypatch.setattr(social_automation_api, "_require_active_owner_user", lambda *_: None)
    monkeypatch.setattr(social_automation_api, "_billing_admin_waived", lambda *_: True)
    monkeypatch.setattr(
        social_automation_api.commercial_billing,
        "require_write_access",
        lambda *_args, **_kwargs: None,
    )
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/authorize",
            "query_string": b"",
            "headers": [],
        }
    )

    result = social_automation_api._start_bundle_authorization(
        social_automation_api.BundleAuthorizationPayload(platform="threads"),
        request,
        {"id": 0},
    )

    with db() as conn:
        current = conn.execute(
            "SELECT team_id, status FROM social_account_auth_requests WHERE id = ?",
            (result["request_id"],),
        ).fetchone()
        previous = conn.execute(
            "SELECT status FROM social_account_auth_requests WHERE id = 'request-old'",
        ).fetchone()
    assert result["url"] == "https://provider.example/oauth"
    assert result["flow"] == "user_browser"
    assert result["live_window"] is False
    assert not str(result.get("task_id") or "").strip()
    assert (current["team_id"], current["status"]) == ("team-empty", "pending")
    assert previous["status"] == "superseded"


def test_bundle_authorization_reuses_unbound_provider_empty_team(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "reuse-provider-empty-team.db"))
    init_db()

    class _Client:
        def list_teams(self, *, limit):
            assert limit == 100
            return {
                "items": [{"id": "team-provider-empty", "name": "test", "socialAccounts": []}],
                "count": 1,
            }

        def create_team(self, _name):
            pytest.fail("an unbound provider empty team must be reused before creating another team")

        def create_connect_link(self, *, team_id, platform, redirect_url, disable_auto_login=False, **_kwargs):
            assert (team_id, platform) == ("team-provider-empty", "threads")
            assert "request_id=" in redirect_url
            return "https://provider.example/oauth"

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    monkeypatch.setattr(social_automation_api, "_identity_user_id", lambda _: 0)
    monkeypatch.setattr(social_automation_api, "_require_active_owner_user", lambda *_: None)
    monkeypatch.setattr(social_automation_api, "_billing_admin_waived", lambda *_: True)
    monkeypatch.setattr(
        social_automation_api.commercial_billing,
        "require_write_access",
        lambda *_args, **_kwargs: None,
    )
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/authorize",
            "query_string": b"",
            "headers": [],
        }
    )

    result = social_automation_api._start_bundle_authorization(
        social_automation_api.BundleAuthorizationPayload(platform="threads"),
        request,
        {"id": 0},
    )

    with db() as conn:
        current = conn.execute(
            "SELECT team_id, status FROM social_account_auth_requests WHERE id = ?",
            (result["request_id"],),
        ).fetchone()
    assert result["url"] == "https://provider.example/oauth"
    assert (current["team_id"], current["status"]) == ("team-provider-empty", "pending")


def test_bundle_callback_reuses_single_legacy_account_with_same_username(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "reuse-legacy-account.db"))
    init_db()
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_proxies(
              id, user_id, name, proxy_type, host, port, created_at, updated_at
            ) VALUES ('proxy-existing', 0, 'Existing proxy', 'http', 'proxy.example', 8080, ?, ?)
            """,
            (now, now),
        )
        conn.execute(
            """
            INSERT INTO social_accounts(
              id, user_id, persona_id, platform, username, display_name, profile_dir,
              proxy_id, status, auth_provider, external_team_id, external_account_id,
              authorized_at, created_at, updated_at
            ) VALUES ('legacy-account', 0, 'persona-old', 'threads', 'same_owner', 'Same Owner', '',
                      'proxy-existing', 'needs_login', 'browser', '', '', 0, ?, ?)
            """,
            (now, now),
        )
        conn.execute(
            """
            INSERT INTO social_account_auth_requests(
              id, user_id, persona_id, account_id, platform, team_id,
              status, error, expires_at, created_at, updated_at
            ) VALUES ('request-reuse-legacy', 0, '', '', 'threads', 'team-new', 'pending', '', ?, ?, ?)
            """,
            (now + 900, now, now),
        )

    class _Client:
        def find_social_account(self, *, team_id, platform):
            assert (team_id, platform) == ("team-new", "threads")
            return {
                "id": "external-new",
                "type": "THREADS",
                "teamId": team_id,
                "username": "same_owner",
            }

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/callback",
            "query_string": b"request_id=request-reuse-legacy&threads-callback=success",
            "headers": [],
        }
    )

    response = social_automation_api._finalize_bundle_authorization("request-reuse-legacy", request)

    with db() as conn:
        accounts = conn.execute(
            "SELECT id, auth_provider, external_team_id, external_account_id, proxy_id, status FROM social_accounts"
        ).fetchall()
    assert response.status_code == 302
    assert len(accounts) == 1
    assert dict(accounts[0]) == {
        "id": "legacy-account",
        "auth_provider": "bundle",
        "external_team_id": "team-new",
        "external_account_id": "external-new",
        "proxy_id": "proxy-existing",
        "status": "ready",
    }


def test_bundle_callback_rejects_different_account_for_existing_profile(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "oauth-account-mismatch.db"))
    init_db()
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_accounts(
              id, user_id, persona_id, platform, username, display_name, profile_dir,
              status, auth_provider, external_team_id, external_account_id,
              created_at, updated_at
            ) VALUES ('account-b', 0, '', 'threads', 'expected_b', 'Expected B', 'profiles/account-b',
                      'pending_login', 'browser', '', '', ?, ?)
            """,
            (now, now),
        )
        conn.execute(
            """
            INSERT INTO social_account_auth_requests(
              id, user_id, persona_id, account_id, platform, team_id,
              status, error, expires_at, created_at, updated_at
            ) VALUES ('request-mismatch', 0, '', 'account-b', 'threads', 'team-b',
                      'pending', '', ?, ?, ?)
            """,
            (now + 900, now, now),
        )

    disconnected = []

    class _Client:
        def find_social_account(self, *, team_id, platform):
            assert (team_id, platform) == ("team-b", "threads")
            return {"id": "external-wrong", "type": "THREADS", "teamId": team_id, "username": "wrong_a"}

        def disconnect_social_account(self, *, team_id, platform):
            disconnected.append((team_id, platform))

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/callback",
            "query_string": b"request_id=request-mismatch&threads-callback=success",
            "headers": [],
        }
    )

    response = social_automation_api._finalize_bundle_authorization("request-mismatch", request)

    with db() as conn:
        account = conn.execute(
            "SELECT username, auth_provider, external_account_id FROM social_accounts WHERE id = 'account-b'"
        ).fetchone()
        auth_request = conn.execute(
            "SELECT status, error FROM social_account_auth_requests WHERE id = 'request-mismatch'"
        ).fetchone()
    assert response.status_code == 302
    assert disconnected == [("team-b", "threads")]
    assert (account["username"], account["auth_provider"], account["external_account_id"]) == (
        "expected_b", "browser", "",
    )
    assert auth_request["status"] == "failed"
    assert "不一致" in auth_request["error"]


def test_bundle_new_authorization_keeps_existing_persona_account(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "multiple-accounts.db"))
    init_db()
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_accounts(
              id, user_id, persona_id, platform, username, display_name, profile_dir,
              status, auth_provider, external_team_id, external_account_id,
              authorized_at, created_at, updated_at
            ) VALUES ('account-1', 0, 'persona-1', 'threads', 'first_owner', 'First Owner', '', 'ready',
                      'bundle', 'team-old', 'external-1', ?, ?, ?)
            """,
            (now, now, now),
        )
        conn.execute(
            """
            INSERT INTO social_account_auth_requests(
              id, user_id, persona_id, account_id, platform, team_id,
              status, error, expires_at, created_at, updated_at
            ) VALUES ('request-3', 0, 'persona-1', '', 'threads', 'team-new', 'pending', '', ?, ?, ?)
            """,
            (now + 900, now, now),
        )

    class _Client:
        def find_social_account(self, *, team_id, platform):
            assert (team_id, platform) == ("team-new", "threads")
            return {
                "id": "external-2",
                "type": "THREADS",
                "teamId": team_id,
                "username": "second_owner",
            }

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/callback",
            "query_string": b"request_id=request-3&threads-callback=success",
            "headers": [],
        }
    )

    response = social_automation_api._finalize_bundle_authorization("request-3", request)

    with db() as conn:
        accounts = conn.execute(
            "SELECT id, username, external_account_id FROM social_accounts ORDER BY created_at, id"
        ).fetchall()
    assert response.status_code == 302
    assert "bundle_account_id=" in response.headers["location"]
    assert len(accounts) == 2
    assert (accounts[0]["id"], accounts[0]["username"], accounts[0]["external_account_id"]) == (
        "account-1", "first_owner", "external-1",
    )
    assert accounts[1]["id"] != "account-1"
    assert (accounts[1]["username"], accounts[1]["external_account_id"]) == (
        "second_owner", "external-2",
    )


def test_oauth_flow_presentation_only_asks_for_authorize_inputs():
    credentials = runner._bundle_oauth_assistance_presentation({
        "status": "cookie_expired",
        "oauth_flow": True,
        "reason": "请填写要添加的平台账号和密码，然后点击授权。",
    })
    consent = runner._bundle_oauth_assistance_presentation({
        "status": "oauth_consent",
        "oauth_flow": True,
        "reason": "账号已就绪，请确认授权。",
    })
    success = runner._bundle_oauth_assistance_presentation({
        "status": "ready",
        "oauth_flow": True,
        "reason": "平台账号已授权",
    })

    assert credentials["kind"] == "credentials"
    assert credentials["submit_label"] == "授权"
    assert "账号" in credentials["title"]
    assert consent["kind"] == "choice"
    assert consent["submit_label"] == "授权"
    assert success["kind"] == "success"
    assert success["title"] == "授权成功"


def test_bundle_oauth_consent_uses_live_page_buttons_and_copy():
    consent = runner._bundle_oauth_assistance_presentation({
        "status": "oauth_consent",
        "oauth_flow": True,
        "title": "bundlesocial 要求存取下列項目：",
        "reason": "请点击与授权页相同的按钮完成确认。",
        "details": "Access and display Your Threads information and posts (Required)",
        "actions": [
            {"kind": "choice", "role": "confirm", "label": "以 hiro504522 的身份繼續", "title": "以 hiro504522 的身份繼續"},
            {"kind": "choice", "role": "cancel", "label": "取消", "title": "取消"},
        ],
    })

    assert consent["kind"] == "choice"
    assert consent["phase"] == "attention"
    assert consent["title"] == "bundlesocial 要求存取下列項目："
    assert consent["details"].startswith("Access and display")
    assert consent["submit_label"] == "以 hiro504522 的身份繼續"
    assert [item["label"] for item in consent["actions"]] == ["以 hiro504522 的身份繼續", "取消"]
    assert [item.get("role") for item in consent["actions"]] == ["confirm", "cancel"]


def test_bundle_oauth_login_confirmed_does_not_hide_consent_buttons():
    published = {}

    def _capture(_session_id, presentation):
        published.update(presentation)

    class _Page:
        url = "https://www.threads.com/privacy/consent/?flow=gdp"

        def evaluate(self, _script, *_args):
            return {
                "available": True,
                "title": "bundlesocial 要求存取下列項目：",
                "details": "Access and display Your Threads information and posts (Required)",
                "actions": [
                    {"kind": "choice", "role": "confirm", "label": "以 hiro504522 的身份繼續", "title": "以 hiro504522 的身份繼續", "selector": "[data-vecto-consent-role=\"confirm\"]"},
                    {"kind": "choice", "role": "cancel", "label": "取消", "title": "取消", "selector": "[data-vecto-consent-role=\"cancel\"]"},
                ],
            }

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(
            "social_automation.live_browser.update_live_browser_login_assistance",
            _capture,
        )
        monkeypatch.setattr(runner, "_login_assistance_surfaces", lambda _page: [(_Page(), _Page())])
        runner._publish_login_assistance_state(
            _Page(),
            {
                "live_browser_session_id": "live-consent",
                "bundle_oauth_login_confirmed": True,
            },
            {
                "status": "oauth_consent",
                "oauth_flow": True,
                "reason": "请点击与授权页相同的按钮完成确认。",
            },
            handoff=True,
        )

    assert published["kind"] == "choice"
    assert published["title"] == "bundlesocial 要求存取下列項目："
    assert published["details"].startswith("Access and display")
    assert [item["label"] for item in published["actions"]] == ["以 hiro504522 的身份繼續", "取消"]
    assert [item.get("role") for item in published["actions"]] == ["confirm", "cancel"]


def test_bundle_oauth_detects_privacy_consent_url_before_credentials():
    class _Page:
        url = "https://www.threads.com/privacy/consent/?flow=gdp&params[redirect_uri]=https://api.bundle.social/x"

        def evaluate(self, _script, *_args):
            return {
                "available": True,
                "title": "bundlesocial 要求存取下列項目：",
                "details": "Access and display Your Threads information and posts (Required)",
                "actions": [{"kind": "choice", "role": "confirm", "label": "以 hiro504522 的身份繼續", "title": "以 hiro504522 的身份繼續", "selector": "[data-vecto-consent-role=\"confirm\"]"}],
            }

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(runner, "_login_assistance_surfaces", lambda page: [(page, page)])
        monkeypatch.setattr(runner, "_mapped_login_credentials", lambda _page: True)
        monkeypatch.setattr(runner, "_mapped_login_username_input", lambda _page: True)
        state = runner._detect_bundle_oauth_page_state(_Page(), "threads")

    assert state["status"] == "oauth_consent"
    assert state["actions"][0]["label"] == "以 hiro504522 的身份繼續"


def test_bundle_oauth_start_stays_automatic_until_a_real_block():
    import inspect
    source = inspect.getsource(runner.run_bundle_oauth_browser_task)
    assert '"need_manual"' not in source
    assert "先按原自动化登录完成平台会话" not in source
    assert "正在自动登录，登录成功后会进入官方授权。" in source
    assert "正在自动确认授权。" in source
    assert "bundle_oauth_consent_misses" in source


def test_consent_snapshot_identifies_by_structure_not_copy():
    import inspect
    source = inspect.getsource(runner._collect_bundle_oauth_consent_snapshot)
    click_source = inspect.getsource(runner._click_mapped_consent_action)
    auto_source = inspect.getsource(runner._maybe_auto_confirm_bundle_oauth)

    assert "data-vecto-consent-role" in source
    assert "hasIconCluster" in source
    assert "fillScore" in source
    assert "confirmRe" not in source
    assert "Allow" not in source
    assert "继续" not in source
    assert "BUNDLE_OAUTH_CONSENT_BUTTONS" not in auto_source
    assert 'role="confirm"' in auto_source
    assert "data-vecto-consent-role" in click_source


def test_mapped_consent_click_uses_role_not_button_copy():
    clicks = []

    class _Page:
        url = "https://www.threads.com/privacy/consent/"

        def evaluate(self, _script, *args):
            if args:
                clicks.append(args[0])
                return True
            return {
                "available": True,
                "title": "heading",
                "details": "",
                "actions": [{
                    "kind": "choice",
                    "role": "confirm",
                    "label": "whatever-language-label",
                    "title": "whatever-language-label",
                    "selector": "[data-vecto-consent-role=\"confirm\"]",
                }],
            }

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(runner, "_login_assistance_surfaces", lambda page: [(page, page)])
        assert runner._click_mapped_consent_action(_Page(), _Logger(), role="confirm") is True

    assert clicks == ["confirm"]


def test_regular_login_assistance_keeps_original_copy_during_oauth_support():
    credentials = runner._login_assistance_presentation({
        "status": "cookie_expired",
        "reason": "自动登录未成功，请人工输入账号和密码。",
    })
    success = runner._login_assistance_presentation({"status": "ready"})

    assert credentials["title"] == "需要登录信息"
    assert credentials["submit_label"] == "提交并继续"
    assert success["title"] == "登录成功"


def test_bundle_oauth_result_from_complete_url():
    success = runner._bundle_oauth_result_from_url(
        "https://www.vecto-ai.cn/bundle-auth-complete.html?bundle_auth=success&bundle_platform=threads&bundle_account_id=acc-1&bundle_message=ok"
    )
    error = runner._bundle_oauth_result_from_url(
        "https://www.vecto-ai.cn/bundle-auth-complete.html?bundle_auth=error&bundle_message=denied"
    )
    ignored = runner._bundle_oauth_result_from_url("https://www.threads.com/login/")

    assert success == {
        "status": "success",
        "platform": "threads",
        "message": "ok",
        "account_id": "acc-1",
    }
    assert error["status"] == "error"
    assert ignored is None


def test_bundle_authorization_returns_user_browser_oauth_url(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "user-browser-auth.db"))
    init_db()

    class _Client:
        def list_teams(self, *, limit):
            return {"items": [{"id": "team-live", "name": "vecto-0-threads-live", "socialAccounts": []}], "count": 1}

        def create_team(self, _name):
            pytest.fail("should reuse empty team")

        def create_connect_link(self, *, team_id, platform, redirect_url, disable_auto_login=False, **_kwargs):
            assert team_id == "team-live"
            assert platform == "threads"
            assert "request_id=" in redirect_url
            return "https://provider.example/oauth"

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    monkeypatch.setattr(social_automation_api, "_identity_user_id", lambda _: 0)
    monkeypatch.setattr(social_automation_api, "_require_active_owner_user", lambda *_: None)
    monkeypatch.setattr(social_automation_api, "_billing_admin_waived", lambda *_: True)
    monkeypatch.setattr(
        social_automation_api.commercial_billing,
        "require_write_access",
        lambda *_args, **_kwargs: None,
    )
    woken = []
    monkeypatch.setattr(social_automation_api, "wake_social_automation_worker", lambda: woken.append(True))
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/authorize",
            "query_string": b"",
            "headers": [],
        }
    )

    result = social_automation_api._start_bundle_authorization(
        social_automation_api.BundleAuthorizationPayload(platform="threads"),
        request,
        {"id": 0},
    )

    with db() as conn:
        tasks = conn.execute("SELECT id FROM social_automation_tasks").fetchall()
        auth = conn.execute(
            "SELECT status FROM social_account_auth_requests WHERE id = ?",
            (result["request_id"],),
        ).fetchone()
    assert result["flow"] == "user_browser"
    assert result["live_window"] is False
    assert result["url"] == "https://provider.example/oauth"
    assert not str(result.get("task_id") or "").strip()
    assert woken == []
    assert tasks == []
    assert auth["status"] == "pending"


def test_bundle_reauthorization_keeps_task_attached_to_existing_account(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "existing-account-auth.db"))
    init_db()

    class _Client:
        def create_connect_link(self, *, team_id, platform, redirect_url, disable_auto_login=False, **_kwargs):
            assert team_id == "team-existing"
            assert platform == "threads"
            assert "request_id=" in redirect_url
            return "https://provider.example/oauth"

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    monkeypatch.setattr(social_automation_api, "_identity_user_id", lambda _: 0)
    monkeypatch.setattr(social_automation_api, "_require_active_owner_user", lambda *_: None)
    monkeypatch.setattr(social_automation_api, "_billing_admin_waived", lambda *_: True)
    monkeypatch.setattr(
        social_automation_api.commercial_billing,
        "require_write_access",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(social_automation_api, "wake_social_automation_worker", lambda: None)
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_accounts(
              id, user_id, persona_id, platform, username, display_name, profile_dir,
              status, auth_provider, external_team_id, external_account_id,
              created_at, updated_at
            ) VALUES ('account-existing', 0, '', 'threads', 'existing', 'Existing', '',
                      'ready', 'bundle', 'team-existing', 'external-existing', ?, ?)
            """,
            (now, now),
        )
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/authorize",
            "query_string": b"",
            "headers": [],
        }
    )

    result = social_automation_api._start_bundle_authorization(
        social_automation_api.BundleAuthorizationPayload(
            platform="threads",
            account_id="account-existing",
        ),
        request,
        {"id": 0},
    )

    with db() as conn:
        tasks = conn.execute("SELECT id FROM social_automation_tasks").fetchall()
        auth = conn.execute(
            "SELECT account_id, status FROM social_account_auth_requests WHERE id = ?",
            (result["request_id"],),
        ).fetchone()
    assert tasks == []
    assert result["account_id"] == "account-existing"
    assert result["flow"] == "user_browser"
    assert not str(result.get("task_id") or "").strip()
    assert (auth["account_id"], auth["status"]) == ("account-existing", "pending")


def test_reauthorize_skips_oauth_when_connection_still_valid(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "valid-reauth.db"))
    init_db()
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_accounts(
              id, user_id, persona_id, platform, username, display_name, profile_dir,
              status, auth_provider, external_team_id, external_account_id,
              created_at, updated_at
            ) VALUES ('account-valid', 0, '', 'threads', 'hiro', 'Hiro', '',
                      'ready', 'bundle', 'team-valid', 'external-valid', ?, ?)
            """,
            (now, now),
        )

    class _Client:
        def inspect_social_account(self, *, team_id, platform):
            assert (team_id, platform) == ("team-valid", "threads")
            return {"valid": True, "reason": "active", "account": {"username": "hiro", "id": "external-valid"}}

        def create_connect_link(self, **_kwargs):
            pytest.fail("valid authorization must not start oauth")

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    monkeypatch.setattr(social_automation_api, "_identity_user_id", lambda _: 0)
    monkeypatch.setattr(social_automation_api, "_require_active_owner_user", lambda *_: None)
    monkeypatch.setattr(social_automation_api, "_billing_admin_waived", lambda *_: True)
    monkeypatch.setattr(
        social_automation_api.commercial_billing,
        "require_write_access",
        lambda *_args, **_kwargs: None,
    )
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/authorize",
            "query_string": b"",
            "headers": [],
        }
    )
    result = social_automation_api._start_bundle_authorization(
        social_automation_api.BundleAuthorizationPayload(platform="threads", account_id="account-valid"),
        request,
        {"id": 0},
    )
    assert result["already_authorized"] is True
    assert result["flow"] == "already_authorized"
    assert not str(result.get("url") or "").strip()
    assert "无需重复授权" in result["message"]
    with db() as conn:
        pending = conn.execute("SELECT id FROM social_account_auth_requests").fetchall()
    assert pending == []


def test_new_instagram_authorization_enables_oauth_account_switch(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "ig-switch.db"))
    init_db()
    captured = {}

    class _Client:
        def list_teams(self, *, limit):
            return {"items": [{"id": "team-ig", "name": "vecto-0-instagram-ig", "socialAccounts": []}], "count": 1}

        def create_team(self, _name):
            pytest.fail("should reuse empty team")

        def create_connect_link(self, *, team_id, platform, redirect_url, disable_auto_login=False, **_kwargs):
            captured.update({
                "team_id": team_id,
                "platform": platform,
                "disable_auto_login": disable_auto_login,
                "force_browser_oauth": _kwargs.get("force_browser_oauth"),
            })
            return "https://instagram.example/oauth"

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    monkeypatch.setattr(social_automation_api, "_identity_user_id", lambda _: 0)
    monkeypatch.setattr(social_automation_api, "_require_active_owner_user", lambda *_: None)
    monkeypatch.setattr(social_automation_api, "_billing_admin_waived", lambda *_: True)
    monkeypatch.setattr(
        social_automation_api.commercial_billing,
        "require_write_access",
        lambda *_args, **_kwargs: None,
    )
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/authorize",
            "query_string": b"",
            "headers": [],
        }
    )
    result = social_automation_api._start_bundle_authorization(
        social_automation_api.BundleAuthorizationPayload(platform="instagram"),
        request,
        {"id": 0},
    )
    assert captured["disable_auto_login"] is True
    assert captured["force_browser_oauth"] is True
    assert result["account_switch"] == "oauth"
    assert "账号选择" in result["account_switch_hint"]


def test_bundle_oauth_host_account_reuses_saved_login_credentials(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "oauth-host-credentials.db"))
    init_db()
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_proxies(
              id, user_id, name, proxy_type, host, port, created_at, updated_at
            ) VALUES ('proxy-login', 0, 'Proxy B', 'http', 'proxy.example', 8080, ?, ?)
            """,
            (now, now),
        )
        conn.execute(
            """
            INSERT INTO social_accounts(
              id, user_id, persona_id, platform, username, display_name, profile_dir,
              proxy_id, status, login_username, login_password, created_at, updated_at
            ) VALUES ('account-login', 0, '', 'threads', 'profile_name', 'Profile', 'profiles/account-login',
                      'proxy-login', 'pending_login', 'login@example.com', 'secret-value', ?, ?)
            """,
            (now, now),
        )

    account = social_automation_api._bundle_oauth_host_account(
        {"id": "task-login", "account_id": "account-login", "user_id": 0, "platform": "threads"}
    )

    assert account["id"] == "account-login"
    assert account["username"] == "profile_name"
    assert account["login_username"] == "login@example.com"
    assert account["login_password"] == "secret-value"
    assert account["profile_dir"] == "profiles/account-login"
    assert account["proxy_id"] == "proxy-login"


def test_claimed_bundle_oauth_task_keeps_owner_for_saved_credentials(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "claimed-oauth-owner.db"))
    init_db()
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            "INSERT INTO users(id, username, password_hash, created_at, updated_at) "
            "VALUES (7, 'oauth-owner', 'x', ?, ?)",
            (now, now),
        )
        conn.execute(
            """
            INSERT INTO social_accounts(
              id, user_id, persona_id, platform, username, display_name, profile_dir,
              status, login_username, login_password, created_at, updated_at
            ) VALUES ('account-owned', 7, '', 'threads', 'profile_name', 'Profile', '',
                      'pending_login', 'login@example.com', 'secret-value', ?, ?)
            """,
            (now, now),
        )
        conn.execute(
            """
            INSERT INTO social_automation_tasks(
              id, user_id, persona_id, account_id, platform, task_type, priority, status,
              scheduled_at, started_at, payload_json, result_json, error, retry_count,
              max_retries, created_by, created_at, updated_at
            ) VALUES ('task-owned', 7, '', 'account-owned', 'threads', 'bundle_oauth', 10,
                      'queued', 0, 0, '{}', '{}', '', 0, 0, 'web', ?, ?)
            """,
            (now, now),
        )
    monkeypatch.setattr(social_automation_api, "_recover_orphaned_publish_confirmation_tasks", lambda *_: None)
    monkeypatch.setattr(social_automation_api, "_recover_orphaned_manual_task", lambda *_: None)
    monkeypatch.setattr(social_automation_api, "_recover_orphaned_running_tasks", lambda *_: None)

    claimed = social_automation_api._claim_next_task()
    account = social_automation_api._bundle_oauth_host_account(claimed)

    assert claimed["user_id"] == 7
    assert account["id"] == "account-owned"
    assert account["login_username"] == "login@example.com"
    assert account["login_password"] == "secret-value"

def test_bundle_oauth_runtime_payload_injects_saved_credentials():
    payload = social_automation_api._runtime_task_payload(
        {
            "id": "task-oauth-creds",
            "task_type": "bundle_oauth",
            "payload": {"auto_submit": True, "oauth_url": "https://provider.example/oauth"},
        },
        {
            "id": "account-1",
            "user_id": 0,
            "login_username": "login@example.com",
            "login_password": "secret-value",
            "username": "profile_name",
        },
    )
    assert payload["auto_submit"] is True
    assert payload["login_username"] == "login@example.com"
    assert payload["login_password"] == "secret-value"


def test_bundle_oauth_hides_credentials_prompt_after_login_confirmed():
    published = {}

    def _capture(_session_id, presentation):
        published.update(presentation)

    class _Page:
        url = "https://www.threads.com/login"

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(
            "social_automation.live_browser.update_live_browser_login_assistance",
            _capture,
        )
        runner._publish_login_assistance_state(
            _Page(),
            {
                "live_browser_session_id": "live-auto",
                "bundle_oauth_login_confirmed": True,
            },
            {
                "status": "cookie_expired",
                "oauth_flow": True,
                "reason": "请填写要添加的平台账号和密码，然后点击授权。",
            },
            handoff=True,
        )

    assert published["kind"] == "progress"
    assert published["title"] == "正在确认授权"
    assert "不会再次填写账号密码" in published["message"]


def test_bundle_oauth_prefill_username_when_auto_login_failed():
    published = {}

    def _capture(_session_id, presentation):
        published.update(presentation)

    class _Page:
        url = "https://www.threads.com/login"

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(
            "social_automation.live_browser.update_live_browser_login_assistance",
            _capture,
        )
        runner._publish_login_assistance_state(
            _Page(),
            {
                "live_browser_session_id": "live-failed",
                "bundle_oauth_prefill_username": "login@example.com",
                "bundle_oauth_auto_login_failed": True,
                "task": {
                    "payload": {
                        "auto_submit": True,
                        "login_username": "login@example.com",
                        "login_password": "secret-value",
                    }
                },
            },
            {
                "status": "invalid_credentials",
                "oauth_flow": True,
                "reason": "平台提示账号或密码不正确，请重新输入。",
            },
            handoff=True,
        )

    assert published["kind"] == "credentials"
    assert published["prefill_username"] == "login@example.com"
    assert published["submit_label"] == "授权"

def test_bundle_oauth_resumes_authorize_url_from_home_after_login(monkeypatch):
    class _Page:
        url = "https://www.threads.com/"
        gotos = []

        def goto(self, url, **_kwargs):
            self.gotos.append(url)
            self.url = url

    page = _Page()
    control = {"login_assistance_submitted_kind": "credentials"}
    oauth_url = "https://threads.net/oauth/authorize?client_id=1&redirect_uri=https://api.bundle.social/callback"
    monkeypatch.setattr(runner, "_has_threads_session_cookie", lambda _page: True)

    assert runner._maybe_resume_bundle_oauth_url(page, oauth_url, _Logger(), control) is True
    assert page.gotos == [oauth_url]
    assert runner._maybe_resume_bundle_oauth_url(page, oauth_url, _Logger(), control) is False


def test_bundle_oauth_does_not_resume_without_session():
    class _Page:
        url = "https://www.threads.com/"
        gotos = []

        def goto(self, url, **_kwargs):
            self.gotos.append(url)

    assert runner._maybe_resume_bundle_oauth_url(
        _Page(),
        "https://threads.net/oauth/authorize?client_id=1",
        _Logger(),
        {"login_assistance_submitted_kind": "credentials"},
    ) is False


def test_bundle_oauth_keeps_login_next_authorize_url(monkeypatch):
    class _Page:
        url = (
            "https://www.threads.com/login?next="
            "https%3A%2F%2Fwww.threads.com%2Foauth%2Fauthorize%3Fclient_id%3D1"
        )
        gotos = []

        def goto(self, url, **_kwargs):
            self.gotos.append(url)
            self.url = url

    page = _Page()
    control = {}
    next_url = runner._bundle_oauth_authorize_resume_url(
        page,
        "https://threads.net/oauth/authorize?client_id=1",
        control,
    )
    assert next_url.startswith("https://www.threads.com/oauth/authorize")
    assert control["bundle_oauth_authorize_url"] == next_url

    page.url = "https://www.threads.com/"
    control["login_assistance_submitted_kind"] = "credentials"
    original = "https://threads.net/oauth/authorize?client_id=1&redirect_uri=https://api.bundle.social/callback"
    monkeypatch.setattr(runner, "_has_threads_session_cookie", lambda _page: True)
    assert runner._maybe_resume_bundle_oauth_url(
        page,
        original,
        _Logger(),
        control,
    ) is True
    assert page.gotos == [original]

def test_bundle_oauth_does_not_resume_before_login_from_home():
    class _Page:
        url = "https://www.threads.com/"
        gotos = []

        def goto(self, url, **_kwargs):
            self.gotos.append(url)

    page = _Page()
    assert runner._maybe_resume_bundle_oauth_url(
        page,
        "https://threads.net/oauth/authorize?client_id=1",
        _Logger(),
        {},
    ) is False
    assert page.gotos == []


def test_bundle_oauth_runs_original_open_login_before_authorize(monkeypatch, tmp_path):
    calls = []
    profile_dir = tmp_path / "account-login-then-oauth"
    profile_dir.mkdir()

    class _Page:
        url = "https://www.threads.com/"

        def goto(self, url, *_args, **_kwargs):
            calls.append(url)
            self.url = url
            if "oauth" in str(url):
                self.url = "https://vecto.example/bundle-auth-complete.html?bundle_auth=success&bundle_account_id=account-login"

    class _Context:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    monkeypatch.setattr(runner, "_open_camoufox_context", lambda **_kwargs: _Context())
    monkeypatch.setattr(runner, "_first_page", lambda _context: _Page())
    monkeypatch.setattr(runner, "_sync_live_browser_viewport", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runner, "_publish_login_assistance_state", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        runner,
        "_run_open_login",
        lambda *_args, **_kwargs: calls.append("open_login") or {"ok": True, "status": "ready"},
    )

    result = runner.run_bundle_oauth_browser_task(
        task={
            "id": "task-login-then-oauth",
            "platform": "threads",
            "payload": {"oauth_url": "https://provider.example/oauth"},
        },
        account={
            "id": "account-login",
            "username": "Lilia",
            "login_username": "Lilia",
            "login_password": "secret",
            "profile_dir": str(profile_dir),
        },
        proxy=None,
        data_dir=tmp_path,
        logger=_Logger(),
        context_control={"live_browser_session_id": "live-login-then-oauth"},
    )

    assert result["ok"] is True
    assert calls[0] == "open_login"
    assert "https://provider.example/oauth" in calls


def test_auto_confirm_still_clicks_when_consent_page_has_leftover_login_inputs(monkeypatch):
    clicks = []

    class _Page:
        url = "https://www.threads.com/privacy/consent/?flow=gdp"

        def evaluate(self, _script, *args):
            if args:
                clicks.append(args[0])
                return True
            return {
                "available": True,
                "title": "bundlesocial 要求存取下列項目：",
                "details": "",
                "actions": [{
                    "kind": "choice",
                    "role": "confirm",
                    "label": "以 hiro504522 的身份繼續",
                    "title": "以 hiro504522 的身份繼續",
                    "selector": '[data-vecto-consent-role="confirm"]',
                }],
            }

    page = _Page()
    monkeypatch.setattr(runner, "_login_assistance_surfaces", lambda _page: [(page, page)])
    monkeypatch.setattr(runner, "_mapped_login_credentials", lambda _page: True)
    monkeypatch.setattr(runner, "_mapped_login_username_input", lambda _page: True)
    monkeypatch.setattr(runner, "_mapped_login_password_input", lambda _page: True)
    monkeypatch.setattr(runner, "_mapped_login_verification_code", lambda _page: None)

    clicked = runner._maybe_auto_confirm_bundle_oauth(
        page,
        _Logger(),
        {"bundle_oauth_login_confirmed": True},
        {"status": "oauth_consent", "oauth_flow": True},
    )
    assert clicked is True
    assert clicks == ["confirm"]


def test_bundle_oauth_full_auto_login_and_consent_closed_loop(monkeypatch, tmp_path):
    profile_dir = tmp_path / "account-closed-loop"
    profile_dir.mkdir()
    published = []
    login_payloads = []

    class _Page:
        def __init__(self):
            self.url = "https://www.threads.com/"
            self.clicks = []

        def goto(self, url, **_kwargs):
            self.url = "https://www.threads.com/privacy/consent/?flow=gdp&client_id=1"

        def evaluate(self, _script, *args):
            if args:
                self.clicks.append(args[0])
                self.url = (
                    "https://www.vecto-ai.cn/bundle-auth-complete.html"
                    "?bundle_auth=success&bundle_platform=threads"
                    "&bundle_account_id=account-closed&bundle_message=ok"
                )
                return True
            return {
                "available": True,
                "title": "bundlesocial 要求存取下列項目：",
                "details": "Access and display Your Threads information and posts (Required)",
                "actions": [{
                    "kind": "choice",
                    "role": "confirm",
                    "label": "以 hiro504522 的身份繼續",
                    "title": "以 hiro504522 的身份繼續",
                    "selector": '[data-vecto-consent-role="confirm"]',
                }],
            }

    page = _Page()

    class _Context:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def _open_login(_page, _task, _account, payload, *_args, **_kwargs):
        login_payloads.append(dict(payload))
        return {"ok": True, "status": "ready"}

    monkeypatch.setattr(runner, "_open_camoufox_context", lambda **_kwargs: _Context())
    monkeypatch.setattr(runner, "_first_page", lambda _context: page)
    monkeypatch.setattr(runner, "_sync_live_browser_viewport", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        runner,
        "_publish_login_assistance_state",
        lambda _page, _control, status, **_kwargs: published.append(dict(status or {})),
    )
    monkeypatch.setattr(runner, "_run_open_login", _open_login)
    monkeypatch.setattr(runner, "_process_login_assistance_action", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(runner, "_maybe_resume_bundle_oauth_url", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(runner, "_wait_for_cancellation", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runner, "_login_assistance_surfaces", lambda _page: [(page, page)])
    monkeypatch.setattr(runner, "_mapped_login_credentials", lambda _page: True)
    monkeypatch.setattr(runner, "_mapped_login_username_input", lambda _page: True)
    monkeypatch.setattr(runner, "_mapped_login_password_input", lambda _page: None)
    monkeypatch.setattr(runner, "_mapped_login_verification_code", lambda _page: None)

    control = {"live_browser_session_id": "live-closed-loop"}
    result = runner.run_bundle_oauth_browser_task(
        task={
            "id": "task-closed-loop",
            "platform": "threads",
            "payload": {"oauth_url": "https://threads.net/oauth/authorize?client_id=1", "auto_submit": True},
        },
        account={
            "id": "account-closed",
            "username": "hiro504522",
            "login_username": "hiro504522",
            "login_password": "secret",
            "profile_dir": str(profile_dir),
        },
        proxy=None,
        data_dir=tmp_path,
        logger=_Logger(),
        context_control=control,
    )

    assert result == {"ok": True, "bundle_oauth": True, "account_id": "account-closed", "platform": "threads"}
    assert login_payloads and login_payloads[0]["auto_submit"] is True
    assert login_payloads[0]["login_username"] == "hiro504522"
    assert control.get("bundle_oauth_login_confirmed") is True
    assert page.clicks == ["confirm"]
    assert control.get("bundle_oauth_consent_misses", 0) == 0
    assert any(item.get("reason") == "正在自动确认授权。" for item in published)
    assert all(item.get("status") != "oauth_consent" for item in published)


def test_bundle_oauth_browser_reuses_account_profile(monkeypatch, tmp_path):
    profile_dir = tmp_path / "account-oauth-profile"
    profile_dir.mkdir()
    captured = {}

    class _Page:
        url = "https://vecto.example/bundle-auth-complete.html?bundle_auth=success&bundle_account_id=account-new"

        def goto(self, *_args, **_kwargs):
            return None

    class _Context:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def _open_context(*, account, **_kwargs):
        captured.update(account)
        return _Context()

    monkeypatch.setattr(runner, "_open_camoufox_context", _open_context)
    monkeypatch.setattr(runner, "_first_page", lambda _context: _Page())
    monkeypatch.setattr(runner, "_sync_live_browser_viewport", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runner, "_publish_login_assistance_state", lambda *_args, **_kwargs: None)

    result = runner.run_bundle_oauth_browser_task(
        task={
            "id": "task-new",
            "platform": "threads",
            "payload": {"oauth_url": "https://provider.example/oauth"},
        },
        account={"id": "account-new", "username": "账号 B", "profile_dir": str(profile_dir)},
        proxy=None,
        data_dir=tmp_path,
        logger=_Logger(),
        context_control={"live_browser_session_id": "live-task-new"},
    )

    assert result["ok"] is True
    assert result["account_id"] == "account-new"
    assert captured["profile_dir"] == str(profile_dir)
    assert profile_dir.exists()


def test_bundle_task_cancel_releases_pending_authorization(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "cancel-bundle-auth.db"))
    init_db()
    calls = []

    class _Client:
        def disconnect_social_account(self, *, team_id, platform):
            calls.append((team_id, platform))

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    monkeypatch.setattr(social_automation_api, "wake_social_automation_worker", lambda: None)
    monkeypatch.setattr(social_automation_api, "_force_stop_running_task", lambda _task_id: None)
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_account_auth_requests(
              id, user_id, persona_id, account_id, platform, team_id,
              status, error, expires_at, created_at, updated_at
            ) VALUES ('request-cancel', 0, '', '', 'threads', 'team-cancel', 'pending', '', ?, ?, ?)
            """,
            (now + 900, now, now),
        )
        conn.execute(
            """
            INSERT INTO social_automation_tasks(
              id, user_id, persona_id, account_id, platform, task_type, priority, status,
              scheduled_at, payload_json, result_json, max_retries, created_at, updated_at
            ) VALUES ('task-cancel', 0, '', 'oauth_host_request-cancel', 'threads', 'bundle_oauth',
                      10, 'queued', 0, ?, '{}', 0, ?, ?)
            """,
            ('{"bundle_request_id":"request-cancel"}', now, now),
        )

    social_automation_api.cancel_social_task("task-cancel")

    with db() as conn:
        request_row = conn.execute(
            "SELECT status FROM social_account_auth_requests WHERE id = 'request-cancel'"
        ).fetchone()
    assert request_row["status"] == "cancelled"
    assert calls == [("team-cancel", "threads")]


def test_deleting_bundle_account_clears_authorization_record(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "delete-bundle-account.db"))
    init_db()
    calls = []

    class _Client:
        def disconnect_social_account(self, *, team_id, platform):
            calls.append((team_id, platform))

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    monkeypatch.setattr(social_automation_api, "wake_social_automation_worker", lambda: None)
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_accounts(
              id, user_id, persona_id, platform, username, display_name, profile_dir,
              status, auth_provider, external_team_id, external_account_id,
              created_at, updated_at
            ) VALUES ('account-delete', 0, '', 'threads', 'owner', 'Owner', '',
                      'ready', 'bundle', 'team-delete', 'external-delete', ?, ?)
            """,
            (now, now),
        )
        conn.execute(
            """
            INSERT INTO social_account_auth_requests(
              id, user_id, persona_id, account_id, platform, team_id,
              status, error, expires_at, created_at, updated_at
            ) VALUES ('request-delete', 0, '', 'account-delete', 'threads', 'team-delete',
                      'completed', '', ?, ?, ?)
            """,
            (now + 900, now, now),
        )

    assert social_automation_api.delete_social_account("account-delete") == 1

    with db() as conn:
        request_row = conn.execute(
            "SELECT id FROM social_account_auth_requests WHERE id = 'request-delete'"
        ).fetchone()
    assert request_row is None
    assert calls == [("team-delete", "threads")]
