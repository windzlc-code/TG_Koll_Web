from webapp.crm.comment_policy import (
    assess_public_comment_content,
    public_comment_similarity,
)


def test_first_public_touch_blocks_contact_information_and_links():
    for comment in (
        "如果需要方案整理可直接联系陈专员 0985-847-613，我可以协助。",
        "若要比较银行条件，请加 LINE ID: 0985847613 后提供资料。",
        "房贷方案整理在 https://page.line.me/example，欢迎加入。",
    ):
        assert assess_public_comment_content(comment=comment)["code"] == "first_contact_information"


def test_short_and_repetitive_template_comments_are_blocked():
    assert assess_public_comment_content(comment="这个方案不错，可以了解一下")["code"] == "comment_too_generic"
    template = "@clairetw 你提到首购，先把自备款、年收入与预计总价一起算，才比较得出可贷成数与月付。你目前最想先确认成数还是利率？"
    assert assess_public_comment_content(comment=template)["code"] == "repetitive_question_template"


def test_mentions_are_ignored_and_three_character_shingles_block_near_duplicates():
    exact = assess_public_comment_content(
        comment="@happyday 首购前先把自备款与可承担月付列成两栏，再对照银行方案会比较清楚。",
        recent_comments=["@claire 首购前先把自备款与可承担月付列成两栏，再对照银行方案会比较清楚。"],
    )
    assert exact["code"] == "duplicate_comment"

    previous = "申请房贷前可先整理自备款、年收入、其他负债与希望月付，再核对银行条件。"
    current = "申请房贷前可先整理自备款、年收入、其他负债与希望月付，再核对银行方案。"
    assert public_comment_similarity(previous, current) >= 0.76
    assert assess_public_comment_content(comment=current, recent_comments=[previous])["code"] == "near_duplicate_comment"


def test_contextual_non_promotional_comment_is_allowed():
    decision = assess_public_comment_content(
        comment="你文中提到装修款也要保留，这会直接影响可用自备款；先把交屋前后的现金需求分开估算会更准确。",
        recent_comments=["固定利率与机动利率的风险不同，应先看持有年限。"],
    )
    assert decision == {"allowed": True, "code": "ready", "reason": "", "similarity": 0.0}

