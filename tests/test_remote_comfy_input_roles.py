from unittest.mock import patch

from webapp import server


class _FixedUuid:
    hex = "abcdef1234567890"


def test_remote_comfy_gateway_upload_image_uses_unique_remote_filename(tmp_path):
    image = tmp_path / "target.jpg"
    image.write_bytes(b"new image")
    captured: dict[str, object] = {}

    def fake_gateway_json(**kwargs):
        captured.update(kwargs)
        return {
            "name": kwargs["json_body"]["filename"],
            "subfolder": kwargs["json_body"]["subfolder"],
        }

    with patch.object(server.uuid, "uuid4", return_value=_FixedUuid()):
        with patch.object(server, "_remote_comfy_gateway_json", side_effect=fake_gateway_json):
            result = server._remote_comfy_gateway_upload_image(
                gateway_url="http://gateway",
                token="",
                image_path=image,
                subfolder="telegram/task_1",
            )

    body = captured["json_body"]
    assert body["filename"] == "target_abcdef12.jpg"
    assert body["overwrite"] is False
    assert result["image"] == "telegram/task_1/target_abcdef12.jpg"


def test_remote_comfy_upload_input_images_preserves_face_swap_roles(tmp_path):
    target = tmp_path / "target.jpg"
    source = tmp_path / "source.jpg"
    target.write_bytes(b"target")
    source.write_bytes(b"source")

    uploads = [
        {"image": "telegram/task/target.jpg"},
        {"image": "telegram/task/source.jpg"},
    ]

    with patch.object(server, "_remote_comfy_gateway_upload_image", side_effect=uploads) as upload:
        result = server._remote_comfy_upload_input_images(
            gateway_url="http://gateway",
            token="",
            task_id="task_1",
            payload={
                "target_image_local_path": str(target),
                "source_image_local_path": str(source),
            },
            task_type="face_swap",
        )

    assert upload.call_count == 2
    assert result == [
        {"role": "target", "image": "telegram/task/target.jpg", "label": "原圖"},
        {"role": "source_face", "image": "telegram/task/source.jpg", "label": "人臉參考圖"},
    ]


def test_remote_comfy_upload_input_images_preserves_image_edit_roles(tmp_path):
    input_image = tmp_path / "input.png"
    reference_image = tmp_path / "reference.png"
    input_image.write_bytes(b"input")
    reference_image.write_bytes(b"reference")

    uploads = [
        {"image": "telegram/task/input.png"},
        {"image": "telegram/task/reference.png"},
    ]

    with patch.object(server, "_remote_comfy_gateway_upload_image", side_effect=uploads) as upload:
        result = server._remote_comfy_upload_input_images(
            gateway_url="http://gateway",
            token="",
            task_id="task_2",
            payload={
                "input_image_local_path": str(input_image),
                "reference_image_local_path": str(reference_image),
            },
            task_type="get_nano_banana",
        )

    assert upload.call_count == 2
    assert result == [
        {"role": "image1", "image": "telegram/task/input.png", "label": "原圖"},
        {"role": "image2", "image": "telegram/task/reference.png", "label": "參考圖"},
    ]


def test_remote_comfy_input_images_keep_first_path_per_role(tmp_path):
    canonical = tmp_path / "canonical.png"
    alias = tmp_path / "alias.png"
    reference = tmp_path / "reference.png"
    canonical.write_bytes(b"canonical")
    alias.write_bytes(b"alias")
    reference.write_bytes(b"reference")

    result = server._remote_comfy_input_image_paths_from_payload(
        {
            "input_image_local_path": str(canonical),
            "image_local_path": str(alias),
            "reference_image_local_path": str(reference),
        },
        "get_nano_banana",
    )

    assert result == [
        {"role": "image1", "path": str(canonical.resolve()), "label": "原圖"},
        {"role": "image2", "path": str(reference.resolve()), "label": "參考圖"},
    ]


def test_remote_comfy_upload_input_images_duplicates_single_image_edit_role(tmp_path):
    input_image = tmp_path / "input.png"
    input_image.write_bytes(b"input")

    uploads = [
        {"image": "telegram/task/input.png"},
        {"image": "telegram/task/input.png"},
    ]

    with patch.object(server, "_remote_comfy_gateway_upload_image", side_effect=uploads) as upload:
        result = server._remote_comfy_upload_input_images(
            gateway_url="http://gateway",
            token="",
            task_id="task_3",
            payload={"input_image_local_path": str(input_image)},
            task_type="single_image_edit",
        )

    assert upload.call_count == 2
    assert result == [
        {"role": "image1", "image": "telegram/task/input.png", "label": "原圖"},
        {"role": "image2", "image": "telegram/task/input.png", "label": "原圖"},
    ]


def test_remote_comfy_uploaded_bindings_become_node_inputs():
    result = server._remote_comfy_node_inputs_from_uploaded_image_bindings(
        [
            {"role": "image1", "image": "telegram/task/input.png"},
            {"role": "image2", "image": "telegram/task/reference.png"},
        ],
        {
            "image1": {"node_id": "2", "input_name": "image"},
            "image2": {"node_id": "19", "input_name": "image"},
        },
    )

    assert result == {
        "2": {"image": "telegram/task/input.png"},
        "19": {"image": "telegram/task/reference.png"},
    }


def test_single_image_edit_reuses_nano_banana_image_bindings():
    payload = {
        "remote_comfy_workflow_mappings": {
            "single_image_edit": "__converted__/custom_edit.api.json",
        },
        "remote_comfy_image_input_bindings": {
            "get_nano_banana": {
                "image1": {"node_id": "2", "input_name": "image"},
                "image2": {"node_id": "19", "input_name": "image"},
            }
        },
    }

    result = server._remote_comfy_image_input_bindings(payload, "single_image_edit")

    assert result == {
        "image1": {"node_id": "2", "input_name": "image"},
        "image2": {"node_id": "19", "input_name": "image"},
    }


def test_image_edit_rejects_prompt_drift_into_face_or_clothing_replacement():
    request = "將原圖的色彩調得更清爽，參考第二張圖的柔和光感，保持人物身份、姿勢和構圖不變，真實自然。"

    assert server._tg_edit_prompt_violates_user_request(
        "使用第二張圖片的臉部替換第一張圖片的臉部，換成學校水手服，保留精液細節",
        request,
        "get_nano_banana",
    )
    assert not server._tg_edit_prompt_violates_user_request(
        "將原圖色彩調得更清爽，參考第二張圖的柔和光感，保持人物身份、姿勢和構圖不變，真實自然",
        request,
        "get_nano_banana",
    )
    assert server._tg_edit_prompt_violates_user_request(
        "以第二張圖片為參考進行自然編輯，保持第一張圖片的姿勢、構圖、身體、服裝、光影和背景不變，細節自然融合無瑕疵",
        request,
        "get_nano_banana",
    )


def test_firered_image_edit_prompt_overrides_cr_prompt_node():
    result = server._remote_comfy_node_inputs_from_payload(
        {
            "prompt_text": "將主圖臉部和頭髮替換為參考圖的臉部與雙馬尾髮型",
            "remote_comfy_workflow_mappings": {
                "get_nano_banana": "__converted__/firered_api.json",
            },
        },
        task_type="get_nano_banana",
        workflow_path="__converted__/firered_api.json",
    )

    assert result["66"]["prompt"] == "將主圖臉部和頭髮替換為參考圖的臉部與雙馬尾髮型"


def test_person_t2i_gateway_call_locks_prompt_nodes():
    captured: list[dict[str, object]] = []

    def fake_gateway_json(**kwargs):
        captured.append(kwargs)
        if kwargs["method"] == "POST":
            return {"prompt_id": "prompt_person_t2i"}
        return {"ok": True, "done": True, "prompt_id": "prompt_person_t2i", "outputs": []}

    with patch.object(server, "_remote_comfy_gateway_json", side_effect=fake_gateway_json):
        result = server._run_remote_comfy_gateway_test(
            gateway_url="http://gateway",
            token="secret",
            workflow_path="__converted__/person_t2i.api.json",
            prompt_text="一位人物站在卧室中",
            negative_prompt="low quality",
            width=1024,
            height=1536,
            batch_size=3,
            node_inputs={"160": {"width": 1024, "height": 1536, "batch_size": 3}},
            timeout_seconds=30,
        )

    assert result["ok"] is True
    body = captured[0]["json_body"]
    assert body["prompt_text_node_ids"] == ["164"]
    assert body["negative_text_node_ids"] == ["166"]
    assert body["batch_size"] == 3
    assert body["node_inputs"]["160"]["batch_size"] == 3
    assert body["node_inputs"]["164"]["text"] == "一位人物站在卧室中"
    assert body["node_inputs"]["166"]["text"] == "low quality"


def test_person_t2i_node_inputs_strip_stale_lora_controls():
    result = server._remote_comfy_node_inputs_from_payload(
        {
            "width": 1024,
            "height": 1536,
            "batch_size": 3,
            "remote_comfy_node_inputs": {
                "185": {"lora_name": r"ZIT\臀部Z-Hip-Slider.safetensors", "strength_model": 0.6, "strength_clip": 1.0},
                "186": {"lora_name": r"ZIT\胸部Z-Breast-Slider.safetensors", "strength_model": 0.6, "strength_clip": 1.0},
                "191": {"lora_name": r"Z-Image\Z-ImageTubro big-nipples.safetensors", "strength_model": 0.0, "strength_clip": 0.0},
                "184": {"lora_name": r"Character Setting\人设1捞女1金君雅.safetensors", "strength_model": 0.8, "strength_clip": 1.0},
            },
        },
        task_type="text_to_image",
        workflow_path="__converted__/person_t2i.api.json",
    )

    assert result["160"] == {"width": 1024, "height": 1536, "batch_size": 3}
    assert "184" not in result
    assert "185" not in result
    assert "186" not in result
    assert "191" not in result
    assert "195" not in result
    assert "196" not in result
    assert "197" not in result


def test_remote_comfy_prefers_saved_output_over_preview_images(tmp_path):
    preview = tmp_path / "ComfyUI_temp_preview.png"
    final = tmp_path / "face_swap_00001_.png"
    preview.write_bytes(b"preview")
    final.write_bytes(b"final")

    result = {
        "local_outputs": [
            {"node": "268", "type": "temp", "local_path": str(preview)},
            {"node": "467", "type": "output", "local_path": str(final)},
        ]
    }

    assert server._first_remote_comfy_output_path(result) == str(final)
    assert server._remote_comfy_output_image_paths(result) == [str(final)]


def test_face_swap_seedvr_flag_switches_save_node_to_upscale_output():
    payload = {
        "remote_comfy_workflow_mappings": {
            "face_swap": {
                "path": "__converted__/flux_換臉工作流.api.json",
                "node_inputs": {
                    "467": {"images": ["251", 0], "filename_prefix": "telegram/face_swap"}
                },
            }
        },
        "face_swap_seedvr_upscale": True,
        "face_swap_random_seed": 789,
    }

    result = server._remote_comfy_node_inputs_from_payload(
        payload,
        task_type="face_swap",
        workflow_path="__converted__/flux_換臉工作流.api.json",
    )

    assert result["467"] == {
        "images": ["326", 0],
        "filename_prefix": "telegram/face_swap_seedvr",
    }
    assert result["256"] == {"noise_seed": 789}


def test_face_swap_random_seed_updates_noise_node_without_seedvr():
    payload = {
        "remote_comfy_workflow_mappings": {
            "face_swap": {
                "path": "__converted__/flux_換臉工作流.api.json",
                "node_inputs": {
                    "467": {"images": ["251", 0], "filename_prefix": "telegram/face_swap"}
                },
            }
        },
        "face_swap_random_seed": 123456,
    }

    result = server._remote_comfy_node_inputs_from_payload(
        payload,
        task_type="face_swap",
        workflow_path="__converted__/flux_換臉工作流.api.json",
    )

    assert result["256"] == {"noise_seed": 123456}
    assert result["467"] == {"images": ["251", 0], "filename_prefix": "telegram/face_swap"}


def test_face_swap_flux_path_uses_default_image_bindings():
    payload = {
        "remote_comfy_workflow_mappings": {
            "face_swap": "__converted__/flux_換臉工作流.api.json",
        },
    }

    result = server._remote_comfy_image_input_bindings(payload, "face_swap")

    assert result == {
        "target": {"node_id": "81", "input_name": "image"},
        "source_face": {"node_id": "244", "input_name": "image"},
    }


def test_face_swap_flux_path_uses_local_success_node_overrides():
    payload = {
        "remote_comfy_workflow_mappings": {
            "face_swap": "__converted__/flux_換臉工作流.api.json",
        },
        "face_swap_random_seed": 2468,
    }

    result = server._remote_comfy_node_inputs_from_payload(
        payload,
        task_type="face_swap",
        workflow_path="__converted__/flux_換臉工作流.api.json",
    )

    assert result["462"] == {"mask": None}
    assert result["463"] == {"mask": None}
    assert result["468"] == {
        "crop_position": "center",
        "device": "gpu",
        "divisible_by": 2,
        "keep_proportion": "resize",
        "upscale_method": "bicubic",
        "pad_color": "0, 0, 0",
        "mask": None,
    }
    assert result["326"] == {
        "temporal_overlap": 0,
        "offload_device": "cpu",
        "batch_size": 1,
        "resolution": 1080,
        "color_correction": "lab",
    }
    assert result["467"] == {"images": ["251", 0], "filename_prefix": "telegram/face_swap"}
    assert result["256"] == {"noise_seed": 2468}


def test_face_swap_finished_markup_has_followup_actions():
    markup = server._send_telegram_reply_markup_for_finished_task("task_1", "face_swap")

    assert markup == {
        "keyboard": [
            [{"text": "增加解析度 2 倍"}],
            [{"text": "重新生成人物換臉"}],
            [{"text": "人物換臉"}, {"text": "圖片編輯"}],
            [{"text": "返回主選單"}],
        ],
        "resize_keyboard": True,
    }


def test_image_edit_finished_markup_keeps_edit_actions():
    for task_type in ("single_image_edit", "get_nano_banana"):
        markup = server._send_telegram_reply_markup_for_finished_task("task_1", task_type)

        assert markup == {
            "keyboard": [
                [{"text": "繼續編輯結果圖"}],
                [{"text": "重新生成圖片編輯"}],
                [{"text": "單圖編輯"}, {"text": "圖片編輯"}],
                [{"text": "返回主選單"}],
            ],
            "resize_keyboard": True,
        }
