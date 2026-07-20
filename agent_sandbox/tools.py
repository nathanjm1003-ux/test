"""A sandbox for tool-using (LLM-style) agents.

``ToolSandbox`` wraps a set of Python callables as named tools. Every
call is recorded, unregistered tools are rejected, and per-tool and
total call budgets are enforced — so tests can assert exactly what an
agent did and misbehaving agents are cut off deterministically.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional


class ToolNotAllowed(Exception):
    """Raised when an agent calls a tool that is not registered."""


class ToolBudgetExceeded(Exception):
    """Raised when a call would exceed the total or per-tool budget."""


@dataclass
class ToolCall:
    """A record of one tool invocation."""

    tool: str
    args: tuple
    kwargs: Dict[str, Any]
    result: Any = None
    error: Optional[str] = None
    wall_time_s: float = 0.0

    @property
    def ok(self) -> bool:
        return self.error is None


@dataclass
class _ToolSpec:
    fn: Callable[..., Any]
    max_calls: Optional[int]
    calls: int = 0


class ToolSandbox:
    """Registers tools and mediates every agent call to them.

    Exceptions raised inside a tool are captured on the :class:`ToolCall`
    record and re-raised, so both the agent and the test see the failure.
    Budget violations and unknown-tool calls raise before the tool runs.
    """

    def __init__(self, max_total_calls: Optional[int] = None) -> None:
        self.max_total_calls = max_total_calls
        self._tools: Dict[str, _ToolSpec] = {}
        self.transcript: List[ToolCall] = []

    def register(
        self,
        name: str,
        fn: Callable[..., Any],
        max_calls: Optional[int] = None,
    ) -> None:
        """Expose ``fn`` to the agent as tool ``name``.

        ``max_calls`` caps invocations of this tool per sandbox lifetime.
        """
        if name in self._tools:
            raise ValueError(f"tool {name!r} is already registered")
        self._tools[name] = _ToolSpec(fn=fn, max_calls=max_calls)

    @property
    def tool_names(self) -> List[str]:
        return sorted(self._tools)

    @property
    def total_calls(self) -> int:
        return len(self.transcript)

    def call(self, name: str, *args: Any, **kwargs: Any) -> Any:
        """Invoke tool ``name``, recording the call in the transcript."""
        spec = self._tools.get(name)
        if spec is None:
            raise ToolNotAllowed(f"tool {name!r} is not registered; allowed: {self.tool_names}")
        if self.max_total_calls is not None and self.total_calls >= self.max_total_calls:
            raise ToolBudgetExceeded(f"total call budget of {self.max_total_calls} exhausted")
        if spec.max_calls is not None and spec.calls >= spec.max_calls:
            raise ToolBudgetExceeded(f"tool {name!r} budget of {spec.max_calls} exhausted")

        record = ToolCall(tool=name, args=args, kwargs=dict(kwargs))
        self.transcript.append(record)
        spec.calls += 1
        start = time.monotonic()
        try:
            record.result = spec.fn(*args, **kwargs)
            return record.result
        except Exception as exc:
            record.error = f"{type(exc).__name__}: {exc}"
            raise
        finally:
            record.wall_time_s = time.monotonic() - start

    def calls_to(self, name: str) -> List[ToolCall]:
        """All transcript entries for tool ``name``, in order."""
        return [c for c in self.transcript if c.tool == name]

    def reset_transcript(self) -> None:
        """Clear the transcript and per-tool call counters."""
        self.transcript.clear()
        for spec in self._tools.values():
            spec.calls = 0
