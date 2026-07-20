import pytest

from agent_sandbox import ToolBudgetExceeded, ToolNotAllowed, ToolSandbox


@pytest.fixture
def sandbox():
    sb = ToolSandbox(max_total_calls=10)
    sb.register("add", lambda a, b: a + b)
    sb.register("fail", lambda: 1 / 0)
    sb.register("once", lambda: "hi", max_calls=1)
    return sb


def test_call_records_transcript(sandbox):
    assert sandbox.call("add", 2, b=3) == 5
    (record,) = sandbox.transcript
    assert record.tool == "add"
    assert record.args == (2,)
    assert record.kwargs == {"b": 3}
    assert record.result == 5
    assert record.ok


def test_unregistered_tool_is_blocked(sandbox):
    with pytest.raises(ToolNotAllowed, match="not registered"):
        sandbox.call("delete_everything")
    assert sandbox.transcript == []


def test_tool_error_is_recorded_and_reraised(sandbox):
    with pytest.raises(ZeroDivisionError):
        sandbox.call("fail")
    (record,) = sandbox.transcript
    assert not record.ok
    assert record.error.startswith("ZeroDivisionError")


def test_per_tool_budget(sandbox):
    assert sandbox.call("once") == "hi"
    with pytest.raises(ToolBudgetExceeded, match="'once' budget of 1"):
        sandbox.call("once")
    assert len(sandbox.calls_to("once")) == 1


def test_total_budget():
    sb = ToolSandbox(max_total_calls=2)
    sb.register("noop", lambda: None)
    sb.call("noop")
    sb.call("noop")
    with pytest.raises(ToolBudgetExceeded, match="total call budget"):
        sb.call("noop")
    assert sb.total_calls == 2


def test_duplicate_registration_rejected(sandbox):
    with pytest.raises(ValueError, match="already registered"):
        sandbox.register("add", lambda a, b: a - b)


def test_reset_transcript_restores_budgets(sandbox):
    sandbox.call("once")
    sandbox.reset_transcript()
    assert sandbox.transcript == []
    assert sandbox.call("once") == "hi"


def test_tool_names_sorted(sandbox):
    assert sandbox.tool_names == ["add", "fail", "once"]
