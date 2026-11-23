export const STORAGE_KEY_HOSTS = 'quolldesk_hosts_v1';
export const STORAGE_KEY_KEYS = 'quolldesk_keys_v1';
export const STORAGE_KEY_GROUPS = 'quolldesk_groups_v1';
export const STORAGE_KEY_CUSTOM_GROUPS = STORAGE_KEY_GROUPS;
export const STORAGE_KEY_SNIPPETS = 'quolldesk_snippets_v1';
export const STORAGE_KEY_SNIPPET_PACKAGES = 'quolldesk_snippet_packages_v1';
export const STORAGE_KEY_NOTES = 'quolldesk_notes_v1';
export const STORAGE_KEY_NOTE_GROUPS = 'quolldesk_note_groups_v1';
/** Last-filled values per snippet id for {{variable}} placeholders. */
export const STORAGE_KEY_SNIPPET_VAR_VALUES = 'quolldesk_snippet_var_values_v1';
export const STORAGE_KEY_THEME = 'quolldesk_theme_v1';
export const STORAGE_KEY_COLOR = 'quolldesk_color_v1';
export const STORAGE_KEY_ACCENT_MODE = 'quolldesk_accent_mode_v1';
export const STORAGE_KEY_UI_THEME_LIGHT = 'quolldesk_ui_theme_light_v1';
export const STORAGE_KEY_UI_THEME_DARK = 'quolldesk_ui_theme_dark_v1';
export const STORAGE_KEY_UI_FONT_FAMILY = 'quolldesk_ui_font_family_v1';
export const STORAGE_KEY_SYNC = 'quolldesk_sync_v1';
/** Device-local experimental convergent-sync toggle; never included in SyncPayload settings. */
export const STORAGE_KEY_CONVERGENT_SYNC_CONFIG = 'quolldesk_convergent_sync_config_v2';
export const STORAGE_KEY_TERM_THEME = 'quolldesk_term_theme_v1';
export const STORAGE_KEY_TERM_FOLLOW_APP_THEME = 'quolldesk_term_follow_app_theme_v1';
export const STORAGE_KEY_TERM_THEME_DARK = 'quolldesk_term_theme_dark_v1';
export const STORAGE_KEY_TERM_THEME_LIGHT = 'quolldesk_term_theme_light_v1';
export const STORAGE_KEY_TERM_FONT_FAMILY = 'quolldesk_term_font_family_v1';
export const STORAGE_KEY_TERM_FONT_SIZE = 'quolldesk_term_font_size_v1';
export const STORAGE_KEY_TERM_SETTINGS = 'quolldesk_term_settings_v1';
/** One-time marker: pre-#3619 builds materialized autoCloseOnExit: true into saved settings. */
export const STORAGE_KEY_TERM_AUTO_CLOSE_EXIT_MIGRATED = 'quolldesk_term_auto_close_exit_migrated_v1';
/** One-time marker: pre-#3770 builds materialized shiftEnterNewlineText "\\n" into saved settings. */
export const STORAGE_KEY_TERM_SHIFT_ENTER_NEWLINE_MIGRATED = 'quolldesk_term_shift_enter_newline_migrated_v1';
export const STORAGE_KEY_HOTKEY_SCHEME = 'quolldesk_hotkey_scheme_v1';
export const STORAGE_KEY_CUSTOM_KEY_BINDINGS = 'quolldesk_custom_key_bindings_v1';
export const STORAGE_KEY_HOTKEY_RECORDING = 'quolldesk_hotkey_recording_v1';
export const STORAGE_KEY_CUSTOM_CSS = 'quolldesk_custom_css_v1';
export const STORAGE_KEY_UI_LANGUAGE = 'quolldesk_ui_language_v1';
export const STORAGE_KEY_PORT_FORWARDING = 'quolldesk_port_forwarding_v1';
/** Width (px) shared by port forwarding edit, wizard, and host picker panels. */
export const STORAGE_KEY_PORT_FORWARDING_PANEL_WIDTH = 'quolldesk_port_forwarding_panel_width_v1';
export const STORAGE_KEY_PF_PREFER_FORM_MODE = 'quolldesk_pf_prefer_form_mode_v1';
export const STORAGE_KEY_PF_VIEW_MODE = 'quolldesk_pf_view_mode_v1';
export const STORAGE_KEY_KNOWN_HOSTS = 'quolldesk_known_hosts_v1';
export const STORAGE_KEY_SHELL_HISTORY = 'quolldesk_shell_history_v1';
/** Autocomplete command history. Keeps its legacy colon-style key for compatibility. */
export const STORAGE_KEY_COMMAND_HISTORY = 'quolldesk:commandHistory';
/** Set once the user clears all command history; histfile seeding honors it. */
export const STORAGE_KEY_COMMAND_HISTORY_CLEARED = 'quolldesk:commandHistoryCleared';
export const STORAGE_KEY_CONNECTION_LOGS = 'quolldesk_connection_logs_v1';
/**
 * Legacy side store for unsaved connection-log terminal replay buffers.
 * Read once to migrate into IndexedDB, then removed. Do not write it.
 */
export const STORAGE_KEY_CONNECTION_LOG_TERMINAL_DATA = 'quolldesk_connection_log_terminal_data_v1';
/**
 * Tiny cross-window signal for the IndexedDB replay side store.
 * Value shape: `{ rev: number, ids?: string[], nonce?: string }`.
 */
export const STORAGE_KEY_CONNECTION_LOG_TERMINAL_DATA_REV = 'quolldesk_connection_log_terminal_data_rev_v1';
export const STORAGE_KEY_SESSION_RESTORE = 'quolldesk_session_restore_v1';
export const STORAGE_KEY_RESTORE_PREVIOUS_SESSION = 'quolldesk_restore_previous_session_v1';
export const STORAGE_KEY_RESTORE_TERMINAL_CWD = 'quolldesk_restore_terminal_cwd_v1';
/** Cold-start landing: vault (home) or local terminal when nothing is restored. */
export const STORAGE_KEY_STARTUP_LANDING = 'quolldesk_startup_landing_v1';
export const STORAGE_KEY_IDENTITIES = 'quolldesk_identities_v1';
export const STORAGE_KEY_PROXY_PROFILES = 'quolldesk_proxy_profiles_v1';
export const STORAGE_KEY_VAULT_HOSTS_VIEW_MODE = 'quolldesk_vault_hosts_view_mode_v1';
export const STORAGE_KEY_VAULT_HOSTS_SORT_MODE = 'quolldesk_vault_hosts_sort_mode_v1';
export const STORAGE_KEY_VAULT_HOSTS_TREE_EXPANDED = 'quolldesk_vault_hosts_tree_expanded_v1';
export const STORAGE_KEY_VAULT_SIDEBAR_COLLAPSED = 'quolldesk_vault_sidebar_collapsed_v1';
export const STORAGE_KEY_VAULT_SIDEBAR_WIDTH = 'quolldesk_vault_sidebar_width_v1';
export const STORAGE_KEY_VAULT_KEYS_VIEW_MODE = 'quolldesk_vault_keys_view_mode_v1';
export const STORAGE_KEY_VAULT_PROXY_PROFILES_VIEW_MODE = 'quolldesk_vault_proxy_profiles_view_mode_v1';
export const STORAGE_KEY_VAULT_SNIPPETS_VIEW_MODE = 'quolldesk_vault_snippets_view_mode_v1';
export const STORAGE_KEY_VAULT_NOTES_VIEW_MODE = 'quolldesk_vault_notes_view_mode_v1';
export const STORAGE_KEY_VAULT_NOTES_EDITOR_MODE = 'quolldesk_vault_notes_editor_mode_v1';
export const STORAGE_KEY_VAULT_NOTES_SELECTED_GROUP = 'quolldesk_vault_notes_selected_group_v1';
export const STORAGE_KEY_VAULT_NOTES_TREE_WIDTH = 'quolldesk_vault_notes_tree_width_v1';
export const STORAGE_KEY_VAULT_NOTES_FONT_FAMILY = 'quolldesk_vault_notes_font_family_v1';
export const STORAGE_KEY_VAULT_NOTES_FONT_SIZE = 'quolldesk_vault_notes_font_size_v1';
export const STORAGE_KEY_VAULT_NOTES_CODE_FONT_SIZE = 'quolldesk_vault_notes_code_font_size_v1';
/** Inline snippet/script edit panel width (px). */
export const STORAGE_KEY_SNIPPETS_PANEL_WIDTH = 'quolldesk_snippets_panel_width_v1';
/** Inline vault host/group details panel width (px). */
export const STORAGE_KEY_VAULT_HOST_PANEL_WIDTH = 'quolldesk_vault_host_panel_width_v1';
/** Inline snippet script editor height (px) in vault edit panel. */
export const STORAGE_KEY_SNIPPET_SCRIPT_EDITOR_HEIGHT = 'quolldesk_snippet_script_editor_height_v1';
/** Automation script Monaco editor height (px) in vault sidebar. */
export const STORAGE_KEY_SCRIPT_EDITOR_HEIGHT = 'quolldesk_script_editor_height_v1';
/** Terminal compose bar total height (px). */
export const STORAGE_KEY_COMPOSE_BAR_HEIGHT = 'quolldesk_compose_bar_height_v1';
/** Snippet IDs pinned to the terminal compose bar quick strip. */
export const STORAGE_KEY_COMPOSE_BAR_PINNED_SNIPPETS = 'quolldesk_compose_bar_pinned_snippets_v1';
export const STORAGE_KEY_VAULT_KNOWN_HOSTS_VIEW_MODE = 'quolldesk_vault_known_hosts_view_mode_v1';
/** Device-local: silently import system OpenSSH known_hosts on Vault load (default true). */
export const STORAGE_KEY_AUTO_IMPORT_SYSTEM_KNOWN_HOSTS = 'quolldesk_auto_import_system_known_hosts_v1';

// Update check
export const STORAGE_KEY_UPDATE_LAST_CHECK = 'quolldesk_update_last_check_v1';
export const STORAGE_KEY_UPDATE_DISMISSED_VERSION = 'quolldesk_update_dismissed_version_v1';
export const STORAGE_KEY_UPDATE_LATEST_RELEASE = 'quolldesk_update_latest_release_v1';
export const STORAGE_KEY_AUTO_UPDATE_ENABLED = 'quolldesk_auto_update_enabled_v1';
export const STORAGE_KEY_LOCAL_VAULT_BACKUP_MAX_COUNT = 'quolldesk_local_vault_backup_max_count_v1';
export const STORAGE_KEY_LOCAL_VAULT_BACKUP_LAST_APP_VERSION = 'quolldesk_local_vault_backup_last_app_version_v1';

/**
 * Cross-window barrier: set while a local vault restore is applying so
 * auto-sync in another window doesn't upload a pre-restore snapshot
 * concurrently. The value is an epoch-ms deadline — auto-sync treats any
 * value in the future as "restore in progress" and any value in the past
 * as a stale lock that can be ignored. See useAutoSync and
 * CloudSyncSettings for readers/writers.
 */
export const STORAGE_KEY_VAULT_RESTORE_IN_PROGRESS_UNTIL = 'quolldesk_vault_restore_in_progress_until_v1';

/**
 * Apply-in-progress sentinel. Set before a destructive applySyncPayload
 * starts writing and cleared after it completes successfully. If this
 * value is present on a later startup, the previous apply was
 * interrupted mid-way (renderer crash, power loss, IPC failure) and the
 * local vault is a partial mix of pre-apply and post-apply state.
 * Auto-sync must refuse to push in that window — otherwise the partial
 * state would silently overwrite an intact cloud copy — until the user
 * manually restores from a protective backup or completes a full merge.
 * The value is a JSON-encoded record (startedAt, protectiveBackupId,
 * source) so the UI can surface a specific recovery hint rather than a
 * generic "something broke" warning.
 */
export const STORAGE_KEY_VAULT_APPLY_IN_PROGRESS = 'quolldesk_vault_apply_in_progress_v1';

// SFTP File Opener Associations
export const STORAGE_KEY_SFTP_FILE_ASSOCIATIONS = 'quolldesk_sftp_file_associations_v1';
export const STORAGE_KEY_SFTP_DEFAULT_OPENER = 'quolldesk_sftp_default_opener_v1';

// SFTP Local Bookmarks
export const STORAGE_KEY_SFTP_LOCAL_BOOKMARKS = 'quolldesk_sftp_local_bookmarks_v1';

// SFTP Global Bookmarks (shared across all hosts)
export const STORAGE_KEY_SFTP_GLOBAL_BOOKMARKS = 'quolldesk_sftp_global_bookmarks_v1';

// SFTP Settings
export const STORAGE_KEY_SFTP_DOUBLE_CLICK_BEHAVIOR = 'quolldesk_sftp_double_click_behavior_v1';
export const STORAGE_KEY_SFTP_AUTO_SYNC = 'quolldesk_sftp_auto_sync_v1';
export const STORAGE_KEY_SFTP_SHOW_HIDDEN_FILES = 'quolldesk_sftp_show_hidden_files_v1';
export const STORAGE_KEY_SFTP_USE_COMPRESSED_UPLOAD = 'quolldesk_sftp_use_compressed_upload_v1';
export const STORAGE_KEY_SFTP_TRANSFER_CENTER = 'quolldesk_sftp_transfer_center_v1';
export const STORAGE_KEY_SFTP_AUTO_OPEN_SIDEBAR = 'quolldesk_sftp_auto_open_sidebar_v1';
export const STORAGE_KEY_SFTP_FOLLOW_TERMINAL_CWD = 'quolldesk_sftp_follow_terminal_cwd_v1';
export const STORAGE_KEY_SFTP_DEFAULT_VIEW_MODE = 'quolldesk_sftp_default_view_mode_v1';
/** Compact vs comfortable SFTP file-list row density. */
export const STORAGE_KEY_SFTP_LIST_DENSITY = 'quolldesk_sftp_list_density_v1';
export const STORAGE_KEY_SFTP_HOST_VIEW_MODES = 'quolldesk_sftp_host_view_modes_v1';
export const STORAGE_KEY_SFTP_VISIBLE_COLUMNS = 'quolldesk_sftp_visible_columns_v1';
export const STORAGE_KEY_SFTP_DIRECTORIES_FIRST = 'quolldesk_sftp_directories_first_v1';
/** Dense SFTP toolbar actions: show / collapse / hide + order. */
export const STORAGE_KEY_SFTP_TOOLBAR_LAYOUT = 'quolldesk_sftp_toolbar_layout_v1';
/** Dense terminal session toolbar actions: show / collapse / hide + order. */
export const STORAGE_KEY_TERMINAL_TOOLBAR_LAYOUT = 'quolldesk_terminal_toolbar_layout_v1';
/** Terminal host-tree sidebar toolbar: show / collapse / hide + order. */
export const STORAGE_KEY_TERMINAL_HOST_TREE_TOOLBAR_LAYOUT =
  'quolldesk_terminal_host_tree_toolbar_layout_v1';
/** Side-panel tab strip: show / collapse / hide + order (supersedes order-only key when present). */
export const STORAGE_KEY_TERMINAL_SIDE_PANEL_TAB_LAYOUT = 'quolldesk_terminal_side_panel_tab_layout_v1';
/** System Manager sub-tabs (Overview / Processes / …): show / collapse / hide + order. */
export const STORAGE_KEY_SYSTEM_MANAGER_TAB_LAYOUT = 'quolldesk_system_manager_tab_layout_v1';
/** Last container runtime, context, and namespace chosen per host. */
export const STORAGE_KEY_CONTAINER_RUNTIME = 'quolldesk_container_runtime_v1';
export const STORAGE_KEY_SFTP_TRANSFER_PANEL_HEIGHT = 'quolldesk_sftp_transfer_panel_height_v1';
export const STORAGE_KEY_SFTP_TRANSFER_CHILD_NAME_WIDTH = 'quolldesk_sftp_transfer_child_name_width_v1';

// Editor Settings
export const STORAGE_KEY_EDITOR_WORD_WRAP = 'quolldesk_editor_word_wrap_v1';

// Session Logs Settings
export const STORAGE_KEY_SESSION_LOGS_ENABLED = 'quolldesk_session_logs_enabled_v1';
export const STORAGE_KEY_SESSION_LOGS_DIR = 'quolldesk_session_logs_dir_v1';
export const STORAGE_KEY_SESSION_LOGS_FORMAT = 'quolldesk_session_logs_format_v1';
export const STORAGE_KEY_SESSION_LOGS_TIMESTAMPS_ENABLED = 'quolldesk_session_logs_timestamps_enabled_v1';
export const STORAGE_KEY_SSH_DEBUG_LOGS_ENABLED = 'quolldesk_ssh_debug_logs_enabled_v1';
export const STORAGE_KEY_SSH_DEEP_LINK_ENABLED = 'quolldesk_ssh_deep_link_enabled_v1';
export const STORAGE_KEY_JMS_DEEP_LINK_ENABLED = 'quolldesk_jms_deep_link_enabled_v1';
/** Windows Explorer "Open in QuollDesk" folder context menu (device-local). */
export const STORAGE_KEY_EXPLORER_CONTEXT_MENU_ENABLED = 'quolldesk_explorer_context_menu_enabled_v1';

// Archived legacy key records that are no longer supported by the app (e.g. biometric/WebAuthn/FIDO2 experiments).
export const STORAGE_KEY_LEGACY_KEYS = 'quolldesk_legacy_keys_v1';

// Managed Sources - external files that manage groups of hosts (e.g., ~/.ssh/config)
export const STORAGE_KEY_MANAGED_SOURCES = 'quolldesk_managed_sources_v1';

// Global Toggle Window Settings (Quake Mode)
export const STORAGE_KEY_TOGGLE_WINDOW_HOTKEY = 'quolldesk_toggle_window_hotkey_v1';
export const STORAGE_KEY_CLOSE_TO_TRAY = 'quolldesk_close_to_tray_v1';
/** Whether the system tray / menu bar icon is shown. Default: shown. */
export const STORAGE_KEY_SHOW_TRAY_ICON = 'quolldesk_show_tray_icon_v1';
/** Optimistic cache only — the source of truth is app.getLoginItemSettings() in the main process. */
export const STORAGE_KEY_AUTO_LAUNCH_ENABLED = 'quolldesk_auto_launch_enabled_v1';
/** App-level HTTP(S) proxy for cloud sync / AI (not SSH ProxyJump). */
export const STORAGE_KEY_HTTP_NETWORK_PROXY = 'quolldesk_http_network_proxy_v1';
/** Saved proxy profile used when a host and its groups do not set one. Empty string means explicit none. */
export const STORAGE_KEY_GLOBAL_DEFAULT_PROXY_PROFILE = 'quolldesk_global_default_proxy_profile_v1';
export const STORAGE_KEY_GLOBAL_HOTKEY_ENABLED = 'quolldesk_global_hotkey_enabled_v1';
export const STORAGE_KEY_WINDOW_OPACITY = 'quolldesk_window_opacity_v1';
export const STORAGE_KEY_WINDOW_BACKGROUND_BLUR = 'quolldesk_window_background_blur_v1';
// Custom Terminal Themes
export const STORAGE_KEY_CUSTOM_THEMES = 'quolldesk_custom_themes_v1';

// AI Settings
export const STORAGE_KEY_AI_PROVIDERS = 'quolldesk_ai_providers_v1';
export const STORAGE_KEY_AI_ACTIVE_PROVIDER = 'quolldesk_ai_active_provider_v1';
export const STORAGE_KEY_AI_ACTIVE_MODEL = 'quolldesk_ai_active_model_v1';
export const STORAGE_KEY_AI_PERMISSION_MODE = 'quolldesk_ai_permission_mode_v1';
export const STORAGE_KEY_AI_TOOL_INTEGRATION_MODE = 'quolldesk_ai_tool_integration_mode_v1';
export const STORAGE_KEY_AI_HOST_PERMISSIONS = 'quolldesk_ai_host_permissions_v1';
export const STORAGE_KEY_AI_EXTERNAL_AGENTS = 'quolldesk_ai_external_agents_v1';
export const STORAGE_KEY_AI_DEFAULT_AGENT = 'quolldesk_ai_default_agent_v1';
export const STORAGE_KEY_AI_COMMAND_BLOCKLIST = 'quolldesk_ai_command_blocklist_v1';
export const STORAGE_KEY_AI_COMMAND_TIMEOUT = 'quolldesk_ai_command_timeout_v1';
export const STORAGE_KEY_AI_RESPONSE_IDLE_TIMEOUT = 'quolldesk_ai_response_idle_timeout_v1';
export const STORAGE_KEY_AI_MAX_ITERATIONS = 'quolldesk_ai_max_iterations_v1';
export const STORAGE_KEY_AI_SESSION_MESSAGE_CAP = 'quolldesk_ai_session_message_cap_v1';
export const STORAGE_KEY_AI_SESSIONS = 'quolldesk_ai_sessions_v1';
/** Byte-budget overflow JSON; further chunks use suffixes _2, _3, etc. */
export const STORAGE_KEY_AI_SESSIONS_OVERFLOW = 'quolldesk_ai_sessions_overflow_v1';
/** IDs intentionally retained only in the disk backup after aggregate quota exhaustion. */
export const STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW = 'quolldesk_ai_sessions_disk_overflow_v1';
/** Opt-in flag: include AI chat sessions in cloud sync payloads. */
export const STORAGE_KEY_CLOUD_SYNC_AI_SESSIONS = 'quolldesk_cloud_sync_ai_sessions_v1';
export const STORAGE_KEY_AI_ACTIVE_SESSION_MAP = 'quolldesk_ai_active_session_map_v1';
export const STORAGE_KEY_AI_AGENT_MODEL_MAP = 'quolldesk_ai_agent_model_map_v1';
export const STORAGE_KEY_AI_AGENT_PROVIDER_MAP = 'quolldesk_ai_agent_provider_map_v1';
export const STORAGE_KEY_AI_AGENT_THINKING_MAP = 'quolldesk_ai_agent_thinking_map_v1';
export const STORAGE_KEY_AI_COMPOSER_MODEL_PREFS = 'quolldesk_ai_composer_model_prefs_v1';
export const STORAGE_KEY_AI_WEB_SEARCH = 'quolldesk_ai_web_search_v1';
export const STORAGE_KEY_AI_QUICK_MESSAGES = 'quolldesk_ai_quick_messages_v1';
/** Confirm-mode permission grant memory (capability + session/command patterns). */
export const STORAGE_KEY_AI_PERMISSION_GRANTS = 'quolldesk_ai_permission_grants_v1';
export const STORAGE_KEY_AI_SHOW_TERMINAL_SELECTION_ACTION = 'quolldesk_ai_show_terminal_selection_action_v1';
/** External MCP: whether the user last enabled the public catalog MCP endpoint. */
export const STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED = 'quolldesk_ai_external_mcp_enabled_v1';
/** AI database access: master switch for the database/redis capability tools (default on). */
export const STORAGE_KEY_AI_DATABASE_ACCESS_ENABLED = 'quolldesk_ai_database_access_enabled_v1';
/** External MCP lifecycle mode: temporary (idle timeout) or persistent (restore on launch). */
export const STORAGE_KEY_AI_EXTERNAL_MCP_MODE = 'quolldesk_ai_external_mcp_mode_v1';
/** External MCP idle timeout in minutes (temporary mode only). */
export const STORAGE_KEY_AI_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES = 'quolldesk_ai_external_mcp_idle_timeout_minutes_v1';
/** External MCP: whether host_open should surface/focus the main window (default true). */
export const STORAGE_KEY_AI_EXTERNAL_MCP_FOCUS_ON_HOST_OPEN = 'quolldesk_ai_external_mcp_focus_on_host_open_v1';
/** Idle timeout for terminal sessions opened by an AI through host_open. */
export const STORAGE_KEY_AI_SESSION_IDLE_TIMEOUT_MINUTES = 'quolldesk_ai_session_idle_timeout_minutes_v1';
/** External MCP: whether host_open sessions stay hidden from the tab bar (default false). */
export const STORAGE_KEY_AI_EXTERNAL_MCP_SILENT_SESSIONS = 'quolldesk_ai_external_mcp_silent_sessions_v1';
/** External MCP confirm-mode approval alert: off, unfocused, or always. Default unfocused. */
export const STORAGE_KEY_AI_EXTERNAL_MCP_APPROVAL_ALERT = 'quolldesk_ai_external_mcp_approval_alert_v1';
/** Shared AI privacy settings for QuollDesk-managed context and tools. Device-local and off by default. */
export const STORAGE_KEY_AI_PRIVACY = 'quolldesk_ai_privacy_v1';
/** Legacy External MCP privacy key, read only when no shared AI privacy preference exists. */
export const STORAGE_KEY_AI_EXTERNAL_MCP_REDACTION = 'quolldesk_ai_external_mcp_redaction_v1';
/** External MCP Streamable HTTP listener. Off unless the user enables it. */
export const STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_ENABLED = 'quolldesk_ai_external_mcp_http_enabled_v1';
/** Fixed Streamable HTTP port so client configs stay stable across restarts. */
export const STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_PORT = 'quolldesk_ai_external_mcp_http_port_v1';
/** When true, HTTP may bind an address other than 127.0.0.1. */
export const STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_ALLOW_CUSTOM_BIND = 'quolldesk_ai_external_mcp_http_allow_custom_bind_v1';
/** IP address used only when custom bind is enabled. */
export const STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_LISTEN_ADDRESS = 'quolldesk_ai_external_mcp_http_listen_address_v1';
/** Address copied into client configs when the listener is a wildcard bind. */
export const STORAGE_KEY_AI_EXTERNAL_MCP_HTTP_CLIENT_HOST = 'quolldesk_ai_external_mcp_http_client_host_v1';
/** AI panel diagnostic hide list (comma-separated part names). */
export const STORAGE_KEY_AI_PANEL_DIAGNOSTIC_HIDE = 'quolldesk.aiDebug.hide';
/** AI panel React profiler toggle. */
export const STORAGE_KEY_AI_PANEL_DIAGNOSTIC_PROFILE = 'quolldesk.aiDebug.profile';

// SFTP Transfer Concurrency
export const STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY = 'quolldesk_sftp_transfer_concurrency_v1';
/**
 * Legacy key only. Folder full-tree pre-scan was removed; values are ignored
 * so old localStorage / sync payloads do not resurrect a live setting.
 */
export const STORAGE_KEY_SFTP_FOLDER_PRESCAN = 'quolldesk_sftp_folder_prescan_v1';
/** Skip files when target size + mtime already match the source (rsync-like). */
export const STORAGE_KEY_SFTP_SKIP_UNCHANGED = 'quolldesk_sftp_skip_unchanged_v1';
/**
 * @deprecated Legacy transfer-pool idle TTL. No longer read; SSH keep-alive uses
 * STORAGE_KEY_SSH_TRANSPORT_IDLE_TTL_MS. Kept so old localStorage entries are ignored safely.
 */
export const STORAGE_KEY_SFTP_TRANSFER_POOL_IDLE_TTL_MS = 'quolldesk_sftp_transfer_pool_idle_ttl_ms_v1';
/** Shared SSH transport idle park TTL in ms (0 = keep until app quit). */
export const STORAGE_KEY_SSH_TRANSPORT_IDLE_TTL_MS = 'quolldesk_ssh_transport_idle_ttl_ms_v1';

// Workspace Focus Indicator Style
export const STORAGE_KEY_WORKSPACE_FOCUS_STYLE = 'quolldesk_workspace_focus_style_v1';

/**
 * Default side panel layout (split panes + tools) the user promoted from a
 * live workspace; applied automatically to freshly connected sessions.
 * Device-local only, not part of the sync payload.
 */
export const STORAGE_KEY_WORKSPACE_LAYOUT_PRESET = 'quolldesk_workspace_layout_preset_v1';

// Vault: Show Recently Connected hosts section
export const STORAGE_KEY_SHOW_RECENT_HOSTS = 'quolldesk_show_recent_hosts_v1';
export const STORAGE_KEY_HOST_CLICK_BEHAVIOR = 'quolldesk_host_click_behavior_v1';
export const STORAGE_KEY_SHOW_ONLY_UNGROUPED_HOSTS_IN_ROOT = 'quolldesk_show_only_ungrouped_hosts_in_root_v1';

// Top tabs: Show standalone SFTP view tab
export const STORAGE_KEY_SHOW_SFTP_TAB = 'quolldesk_show_sftp_tab_v1';
export const STORAGE_KEY_SHOW_HOST_TREE_SIDEBAR = 'quolldesk_show_host_tree_sidebar_v1';

// Shortcuts: Cmd/Ctrl+[1...9] and Ctrl+Tab skip pinned Vault/SFTP tabs
export const STORAGE_KEY_SHELL_ONLY_TAB_NUMBER_SHORTCUTS = 'quolldesk_shell_only_tab_number_shortcuts_v1';

// Shortcuts: show 1...9 badge on tabs that match number switch shortcuts
export const STORAGE_KEY_SHOW_TAB_NUMBER_BADGES = 'quolldesk_show_tab_number_badges_v1';

// Shortcuts: disable terminal font zoom shortcuts
export const STORAGE_KEY_DISABLE_TERMINAL_FONT_ZOOM = 'quolldesk_disable_terminal_font_zoom_v1';

/** Host IDs for which the "enable Network Device Mode" suggestion has already been shown/handled (suggest once per host). */
export const STORAGE_KEY_NETWORK_DEVICE_SUGGEST_HANDLED = 'quolldesk_network_device_suggest_handled_v1';

// Group Configurations (default settings inherited by hosts)
export const STORAGE_KEY_GROUP_CONFIGS = 'quolldesk_group_configs_v1';
/** Crash-recovery journal for the plugin importer multi-key Vault commit. */
export const STORAGE_KEY_PLUGIN_IMPORT_TRANSACTION = 'quolldesk_plugin_import_transaction_v1';

// Side Panel
export const STORAGE_KEY_SIDE_PANEL_WIDTH = 'quolldesk_side_panel_width';
export const STORAGE_KEY_SIDE_PANEL_HEIGHT = 'quolldesk_side_panel_height';
export const STORAGE_KEY_TERMINAL_SIDE_PANEL_TAB_ORDER = 'quolldesk_terminal_side_panel_tab_order_v1';
export const STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN = 'quolldesk_terminal_side_panel_auto_open_v1';
export const STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN_TAB = 'quolldesk_terminal_side_panel_auto_open_tab_v1';
export const STORAGE_KEY_LOCAL_SHELL_SIDE_PANEL_AUTO_OPEN = 'quolldesk_local_shell_side_panel_auto_open_v1';
export const STORAGE_KEY_LOCAL_SHELL_SIDE_PANEL_AUTO_OPEN_TAB = 'quolldesk_local_shell_side_panel_auto_open_tab_v1';
export const STORAGE_KEY_WORKSPACE_FOCUS_SIDEBAR_WIDTH = 'quolldesk_workspace_focus_sidebar_width';
export const STORAGE_KEY_TERMINAL_HOST_TREE_WIDTH = 'quolldesk_terminal_host_tree_width_v1';
export const STORAGE_KEY_TERMINAL_HOST_TREE_COLLAPSED = 'quolldesk_terminal_host_tree_collapsed_v1';
export const STORAGE_KEY_TERMINAL_COMPOSE_BAR_OPEN = 'quolldesk_terminal_compose_bar_open_v1';
/** Opt-in "broadcast without password protection" switch (terminal compose bar, issue #3488). */
export const STORAGE_KEY_TERMINAL_BROADCAST_PASSWORD_BYPASS = 'quolldesk_terminal_broadcast_password_bypass_v1';
export const STORAGE_KEY_TERMINAL_SEARCH_OPEN = 'quolldesk_terminal_search_open_v1';
export const STORAGE_KEY_TERMINAL_ENCODING_BY_HOST_PREFIX = 'quolldesk_terminal_encoding_by_host_v1:';
export const STORAGE_KEY_TERMINAL_YMODEM_SEND_DIR = 'quolldesk_terminal_ymodem_send_dir_v1';

// Port Forwarding (transient cross-window broadcast key)
export const STORAGE_KEY_PF_RECONNECT_CANCEL = '__quolldesk_pf_cancel_reconnect';

// Default SSH Key Passphrases (for ~/.ssh keys not managed in the vault)
export const STORAGE_KEY_DEFAULT_KEY_PASSPHRASES = 'quolldesk_default_key_passphrases_v1';

// Plugin sync sidecars / availability. Literals MUST match domain/sync
// SYNC_STORAGE_KEYS (PLUGIN_SIDECARS_* / AVAILABLE_PLUGIN_SYNC_PROVIDERS).
export const STORAGE_KEY_PLUGIN_SIDECARS_LAST_KNOWN = 'quolldesk_plugin_sidecars_last_known_v1';
export const STORAGE_KEY_PLUGIN_SIDECARS_PENDING_REMOTE = 'quolldesk_plugin_sidecars_pending_remote_v1';
export const STORAGE_KEY_AVAILABLE_PLUGIN_SYNC_PROVIDERS = 'quolldesk_available_plugin_sync_providers_v1';

// Debug Flags (no _v1 suffix — developer-only, not persisted data)
export const STORAGE_KEY_DEBUG_HOTKEYS = 'debug.hotkeys';
export const STORAGE_KEY_DEBUG_UPDATE_DEMO = 'debug.updateDemo';

// Portable monitor configuration. Runtime samples never use storage.
export const STORAGE_KEY_MONITOR_PANELS = 'quolldesk_monitor_panels_v1';
export const STORAGE_KEY_MONITOR_TABLE_COLUMNS = 'quolldesk_monitor_table_columns_v1';

export const STORAGE_KEY_MONITOR_HIDDEN_COLUMNS = "quolldesk_monitor_hidden_columns_v1";

// Preferred application for saved terminal logs (independent of SFTP associations).
export const STORAGE_KEY_SESSION_LOG_APPLICATION = "quolldesk.sessionLogApplication";

// Database query workbench
/** Per-dialect SQL query history, most recent first, capped at 50: `{ mysql: string[], postgresql: string[] }`. */
export const STORAGE_KEY_DB_QUERY_HISTORY = 'quolldesk_db_query_history_v1';
/** Per-dialect favorite SQL queries, capped at 50: `{ mysql: string[], postgresql: string[] }`. */
export const STORAGE_KEY_DB_QUERY_FAVORITES = 'quolldesk_db_query_favorites_v1';
/** Last chosen charset for the BLOB viewer's text preview: a blobViewer BlobEncodingId. */
export const STORAGE_KEY_DB_BLOB_ENCODING = 'quolldesk_db_blob_encoding_v1';
