from webapp.server import _format_user_visible_task_error


def test_quota_json_is_plain_balance_message():
    raw = (
        '模型 xai/grok-4.5 呼叫失敗 (402): '
        '{"error":{"message":"Insufficient corporate funds, please top up",'
        '"type":"insufficient_quota","code":"insufficient_funds"}}'
    )
    text = _format_user_visible_task_error(raw)
    assert "余额不足" in text
    assert "结构化" not in text
    assert "JSON" not in text
    assert "工作台" not in text


def test_legacy_hidden_json_copy_is_rewritten():
    raw = "后台生成失败：上游服务返回了结构化错误，已隐藏原始 JSON；请在工作台查看详情或按当前任务类型重新提交。"
    text = _format_user_visible_task_error(raw)
    assert text == "生成失败，请稍后重试。"
    assert "结构化" not in text


def test_unknown_json_does_not_mention_structure():
    text = _format_user_visible_task_error('{"error":{"message":"internal provider fault","code":"unknown"}}')
    assert text == "生成失败，请稍后重试。"
    assert "JSON" not in text
    assert "结构化" not in text


def test_credit_amount_quota_stays_specific():
    raw = "402 Client Error: Payment Required Required: 1 amount (12 credits) Available: 1 amount (3 credits)"
    text = _format_user_visible_task_error(raw)
    assert "余额不足" in text
    assert "12" in text
    assert "3" in text
