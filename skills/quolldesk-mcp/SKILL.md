---
name: quolldesk-mcp
description: Use when the user asks to inspect or operate QuollDesk terminals, remote hosts, SSH or other live sessions, SFTP files, vault data, snippets, scripts, or port forwards through QuollDesk MCP.
metadata:
  managed-by: quolldesk
---

# QuollDesk MCP

Use the QuollDesk MCP tools whenever the task targets QuollDesk or a remote session managed by QuollDesk.

- For terminal work, call `get_environment` first. Select the current target by its label or hostname and pass its `sessionId` to terminal tools.
- Never use the local shell for commands intended for a QuollDesk session.
- If a required specialized tool is not visible, call `load_quolldesk_tools` with `attachments`, `sftp_advanced`, `vault_hosts`, `vault_notes`, `snippets`, `scripts`, or `portforward`. Use `all` only when several categories are needed.
- If no live session matches, use `vault_hosts_list` and `host_open`. A newly opened tab lands in your own bound workspace by default (workspace chat → that workspace; terminal chat → that terminal's workspace); only pass `workspaceId` when the user asks for a different target. Close only sessions opened for the current task when they are no longer needed.
- Use `terminal_execute` for short commands. Use `terminal_start`, `terminal_poll`, and `terminal_stop` for long-running or streaming commands.
- Treat QuollDesk permission denials and tool errors as authoritative. Do not bypass them with local commands or alternate connection tools.
