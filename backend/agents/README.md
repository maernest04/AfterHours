# Agents

Execute focused tasks assigned by the orchestrator and return structured
results. Each agent should have a defined input/output contract.

- `implementations/`: task-specific agent implementations and registration.
- `tools/`: adapters for external APIs, model providers, and allowed actions.
- `prompts/`: versioned prompt templates and related instructions, if needed.

An agent receives a task and execution context, invokes its permitted tools,
and returns a result or structured failure. The orchestrator owns workflow
ordering and retries; agents should not schedule other agents directly.

Implementation considerations: timeouts, cancellation, tool permissions,
usage limits, and idempotent side effects when tasks can be retried.
