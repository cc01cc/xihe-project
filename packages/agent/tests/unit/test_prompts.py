from xihe_agent.agent.prompts import PROMPT_LAYERS, XIHE_SYSTEM_PROMPT, build_prompt


def test_system_prompt_template_contains_required_variables():
    assert "{user_name}" in XIHE_SYSTEM_PROMPT
    assert "{current_date}" in XIHE_SYSTEM_PROMPT
    assert "{instructions}" in XIHE_SYSTEM_PROMPT


def test_system_prompt_content():
    assert "xihe Agent" in XIHE_SYSTEM_PROMPT
    assert "Chinese" in XIHE_SYSTEM_PROMPT
    assert "tools" in XIHE_SYSTEM_PROMPT.lower()


def test_build_prompt_returns_string_template():
    prompt = build_prompt()
    assert isinstance(prompt, str)
    assert prompt == XIHE_SYSTEM_PROMPT
    assert "{user_name}" in prompt
    assert "{current_date}" in prompt
    assert "{instructions}" in prompt


def test_template_variables_substitution():
    formatted = XIHE_SYSTEM_PROMPT.format(
        user_name="TestUser",
        current_date="2025-06-01",
        instructions="custom instruction",
    )
    assert "TestUser" in formatted
    assert "2025-06-01" in formatted
    assert "custom instruction" in formatted
    assert "xihe Agent" in formatted


def test_prompt_layers_contain_required_context():
    has_user = any("{user_name}" in layer for layer in PROMPT_LAYERS)
    has_date = any("{current_date}" in layer for layer in PROMPT_LAYERS)
    assert has_user
    assert has_date
