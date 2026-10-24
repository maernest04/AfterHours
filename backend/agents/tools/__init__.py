"""Agent tool entry point; implementation lives in the AfterHours Python SDK."""

from afterhours_db.tools import AGENT_TOOL_SPECS, AgentTools, ToolScopeError, allowed_evidence_ids

__all__ = ['AGENT_TOOL_SPECS', 'AgentTools', 'ToolScopeError', 'allowed_evidence_ids']
