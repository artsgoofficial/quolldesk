/// <reference path="./types/global/quolldesk-bridge-session.d.ts" />
/// <reference path="./types/global/quolldesk-bridge-sftp.d.ts" />
/// <reference path="./types/global/quolldesk-bridge-sync.d.ts" />
/// <reference path="./types/global/quolldesk-bridge-files.d.ts" />
/// <reference path="./types/global/quolldesk-bridge-ai.d.ts" />
/// <reference path="./types/global/quolldesk-bridge-app.d.ts" />
/// <reference path="./types/global/quolldesk-bridge-system.d.ts" />
/// <reference path="./types/global/quolldesk-bridge-script.d.ts" />
/// <reference path="./types/global/quolldesk-bridge-database.d.ts" />
declare module "*.cjs" {
  const value: Record<string, unknown>;
  export = value;
}

declare module 'react' {
  interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
    webkitdirectory?: string | boolean;
  }
}

declare global {
  // Proxy configuration for SSH connections
  interface QuollDeskProxyConfig {
    type: 'http' | 'socks5' | 'command';
    host: string;
    port: number;
    command?: string;
    username?: string;
    password?: string;
  }

  // Discovered local shell (e.g. CMD, PowerShell, WSL, Git Bash)
  interface DiscoveredShell {
    id: string;
    name: string;
    command: string;
    args?: string[];
    icon: string;
    isDefault?: boolean;
  }

  interface QuollDeskTotpConfig {
    uri: string;
    autoSubmit?: boolean;
    promptPattern?: string;
  }

  // Jump host configuration for SSH tunneling
  interface QuollDeskJumpHost {
    hostname: string;
    hostId?: string;
    port: number;
    username: string;
    authMethod?: import("./domain/models").HostAuthMethod;
    requiresMfa?: boolean;
    password?: string;
    totp?: QuollDeskTotpConfig;
    privateKey?: string;
    certificate?: string;
    passphrase?: string;
    publicKey?: string;
    keyId?: string;
    keySource?: 'generated' | 'imported' | 'reference';
    label?: string; // Display label for UI
    proxy?: QuollDeskProxyConfig;
    identityFilePaths?: string[];
    useSshAgent?: boolean;
    agentPublicKeys?: string[];
    identityAgent?: string;
    identitiesOnly?: boolean;
    addKeysToAgent?: string;
    useKeychain?: boolean;
    // ET server port on this hop, used only when ET tunnels through it as a
    // jump host (--jport). Defaults to 2022 in the bridge when omitted.
    etPort?: number;
    // Resolved keepalive for THIS hop (caller has already applied host
    // override / global fallback). interval in seconds, 0 = disabled.
    keepaliveInterval?: number;
    keepaliveCountMax?: number;
    // Per-hop SSH connection timeouts, resolved from the saved host.
    sshTcpConnectTimeoutMs?: number;
    sshAuthReadyTimeoutMs?: number;
    verifyHostKeys?: boolean;
    // Per-hop algorithm settings, mirroring the target-host fields. When
    // omitted the bridge falls back to the target host's settings so a
    // single setting on the leaf still covers the chain (matches the
    // pre-existing behavior of `legacyAlgorithms`).
    legacyAlgorithms?: boolean;
    skipEcdsaHostKey?: boolean;
    algorithmOverrides?: import("./domain/models").HostAlgorithmOverrides;
  }

  // Host key information for verification
  // Reserved for future host key verification UI feature
  interface _QuollDeskHostKeyInfo {
    hostname: string;
    port: number;
    keyType: string;
    fingerprint: string;
    publicKey?: string;
  }

  interface QuollDeskSSHOptions {
    keyLabel?: string;
    sessionId?: string;
    hostId?: string;
    hostLabel?: string;
    hostname: string;
    username: string;
    authMethod?: import("./domain/models").HostAuthMethod;
    requiresMfa?: boolean;
    port?: number;
    password?: string;
    totp?: QuollDeskTotpConfig;
    privateKey?: string;
    // Optional OpenSSH user certificate
    certificate?: string;
    publicKey?: string; // OpenSSH public key line
    keyId?: string;
    keySource?: 'generated' | 'imported' | 'reference';
    agentForwarding?: boolean;
    x11Forwarding?: boolean;
    x11Display?: string;
    cols?: number;
    rows?: number;
    charset?: string;
    extraArgs?: string[];
    startupCommand?: string;
    passphrase?: string;
    knownHosts?: import("./domain/models").KnownHost[];
    verifyHostKeys?: boolean;
    /**
     * When true, an untrusted host key fails the dial instead of waiting for
     * a renderer prompt. Transfer opens set this: their session id is not the
     * SFTP page's host-key dialog, so an unanswered prompt leaves the upload
     * on "Waiting...".
     */
    hostKeyUnattended?: boolean;
    // Environment variables to set in the remote shell
    env?: Record<string, string>;
    // Proxy configuration
    proxy?: QuollDeskProxyConfig;
    // Jump hosts (bastion chain)
    jumpHosts?: QuollDeskJumpHost[];
    // SSH-level keepalive interval in seconds (0 = disabled)
    keepaliveInterval?: number;
    // Unanswered keepalives before ssh2 declares the connection dead
    keepaliveCountMax?: number;
    // Maximum time to establish the TCP connection
    sshTcpConnectTimeoutMs?: number;
    // Maximum time for SSH handshake and authentication
    sshAuthReadyTimeoutMs?: number;
    // Enable legacy SSH algorithms for older network equipment
    legacyAlgorithms?: boolean;
    // Drop ecdsa-sha2-* from offered host-key algorithms (#1027)
    skipEcdsaHostKey?: boolean;
    // Per-category algorithm override lists (advanced, see HostAlgorithmOverrides)
    algorithmOverrides?: import("./domain/models").HostAlgorithmOverrides;
    // Use sudo for SFTP server
    sudo?: boolean;
    // Remote file protocol: auto (SFTP then SCP fallback) | sftp | scp
    fileProtocol?: 'auto' | 'sftp' | 'scp';
    // Saved host password used by background system tools when they need sudo.
    sudoAutofillPassword?: string;
    // Session log configuration for real-time streaming
    sessionLog?: { enabled: boolean; directory: string; format: string; timestampsEnabled?: boolean };
    // SSH connection diagnostics. Does not capture terminal output.
    sshDebugLogEnabled?: boolean;
    // Boot generation for correlating host-key prompts with a terminal start.
    bootEpoch?: number;
    // Local SSH key file paths (from SSH config IdentityFile)
    identityFilePaths?: string[];
    useSshAgent?: boolean;
    agentPublicKeys?: string[];
    identityAgent?: string;
    identitiesOnly?: boolean;
    addKeysToAgent?: string;
    useKeychain?: boolean;
    // When set, reuse the already-authenticated SSH connection of this existing
    // session by opening a new shell channel on it, instead of dialing a fresh
    // connection. Lets a duplicated tab skip a second MFA prompt (issue #1204).
    // The bridge falls back to a fresh connection if the source is gone.
    sourceSessionId?: string;
    /** Require openSftpForSession to use exactly the requested live session. */
    requireExactSourceSession?: boolean;
    /** Use the named live terminal only; never open a dedicated/fresh login. */
    reuseExactSessionOnly?: boolean;
    // Skip POSIX process discovery when copying a network-device session.
    skipShellPidDiscovery?: boolean;
    /**
     * When false, terminal/SFTP opens must dial a fresh SSH connection and
     * must not borrow a live, parked, or in-flight registry transport. Used by
     * connect-time terminal automation and dedicated bulk transfers.
     * Default true (normal terminal, browse, and MFA-skip reuse).
     */
    reuseTransport?: boolean;
    /** Runtime stamp for one session channel on this TCP. Set after a recognized bastion banner, not from saved host settings. */
    singleChannelSsh?: boolean;
    /** Original unsaved-password profile; main retains only its digest for live SFTP borrowing. */
    sftpReuseOptions?: QuollDeskSSHOptions;
  }

  interface SftpStatResult {
    name: string;
    type: 'file' | 'directory' | 'symlink';
    size: number;
    /** False when the endpoint cannot report a size (stat-less SCP); size is a placeholder 0. */
    sizeKnown?: boolean;
    lastModified: number; // timestamp
    permissions?: string; // e.g., "rwxr-xr-x"
    owner?: string;
    group?: string;
    /** Local-only filesystem identity; undefined for remote SFTP stats. */
    dev?: number;
    ino?: number;
  }

  interface SftpTransferProgress {
    transferId: string;
    bytesTransferred: number;
    totalBytes: number;
    speed: number; // bytes per second
  }

  // Port Forwarding Types
  interface PortForwardOptions {
    ruleId?: string;
    tunnelId: string;
    type: 'local' | 'remote' | 'dynamic';
    localPort: number;
    bindAddress?: string;
    remoteHost?: string;
    remotePort?: number;
    // SSH connection details
    hostname: string;
    hostId?: string;
    port?: number;
    username: string;
    authMethod?: import("./domain/models").HostAuthMethod;
    requiresMfa?: boolean;
    password?: string;
    totp?: QuollDeskTotpConfig;
    privateKey?: string;
    certificate?: string;
    keyId?: string;
    passphrase?: string;
    knownHosts?: import("./domain/models").KnownHost[];
    verifyHostKeys?: boolean;
    proxy?: QuollDeskProxyConfig;
    jumpHosts?: QuollDeskJumpHost[];
    identityFilePaths?: string[];
    useSshAgent?: boolean;
    agentPublicKeys?: string[];
    identityAgent?: string;
    identitiesOnly?: boolean;
    addKeysToAgent?: string;
    useKeychain?: boolean;
    legacyAlgorithms?: boolean;
    skipEcdsaHostKey?: boolean;
    algorithmOverrides?: import("./domain/models").HostAlgorithmOverrides;
    // Resolved keepalive for the target connection (caller has already
    // applied host override / global fallback). interval in seconds.
    keepaliveInterval?: number;
    keepaliveCountMax?: number;
    sshTcpConnectTimeoutMs?: number;
    sshAuthReadyTimeoutMs?: number;
    reuseTransport?: boolean;
  }

  interface PortForwardResult {
    tunnelId: string;
    success: boolean;
    localPort?: number;
    cancelled?: boolean;
    blockedByCleanup?: boolean;
    reused?: boolean;
    status?: 'inactive' | 'connecting' | 'active' | 'error';
    error?: string;
  }

  interface PortForwardStatusResult {
    tunnelId: string;
    status: 'inactive' | 'connecting' | 'active' | 'error';
    type?: 'local' | 'remote' | 'dynamic';
    error?: string;
  }

  type PortForwardRuntimePhase =
    | 'connecting'
    | 'active'
    | 'stopping'
    | 'error'
    | 'inactive';

  interface PortForwardRuntimeRecord {
    ruleId?: string;
    tunnelId: string;
    phase: PortForwardRuntimePhase | string;
    error?: string;
    cleanupRequired?: boolean;
    revision: number;
    updatedAt: number;
  }

  interface PortForwardRuntimeSnapshot {
    epoch: string;
    revision: number;
    records: PortForwardRuntimeRecord[];
  }

  type PortForwardRuntimeEvent =
    | {
        epoch: string;
        revision: number;
        kind: 'upsert';
        record: PortForwardRuntimeRecord;
      }
    | {
        epoch: string;
        revision: number;
        kind: 'remove';
        tunnelId: string;
        ruleId?: string;
      };

  interface QuollDeskWindowsPtyInfo {
    backend: 'conpty' | 'winpty';
    buildNumber?: number;
  }

  type PortForwardStatusCallback = (status: 'inactive' | 'connecting' | 'active' | 'error', error?: string) => void;
  type PortForwardRuntimeEventCallback = (event: PortForwardRuntimeEvent) => void;

  interface QuollDeskPluginRuntimeStatus {
    available: boolean;
    experimental: true;
    credentialStorageAvailable?: boolean;
  }

  interface QuollDeskPluginCatalogSnapshot {
    entries: QuollDeskPluginCatalogEntry[];
    source: "registry" | "cached" | "builtin";
    error: string | null;
  }

  interface QuollDeskPluginCatalogEntry {
    selectionToken?: string;
    id: string;
    version: string;
    name: string;
    description: string;
    author: string;
    repository: string;
    commit: string;
    license: string;
    readme: string;
    manifest: import("@quolldesk/plugin-contract").PluginManifest;
    artifact?: { url: string; sha256: string };
  }

  type QuollDeskPluginAuthorRequest =
    | { kind: 'catalog'; pluginId: string; selectionToken: string; sourceId: string }
    | { kind: 'installed'; pluginId: string };
  interface QuollDeskPluginAuthorPresentation {
    author: string;
    avatar: string | null;
    officialMaintained: boolean;
    sourceId: string;
    version: string;
    archiveSha256: string | null;
  }

  type PluginPermissionMode = 'allow' | 'ask' | 'deny';
  type QuollDeskPluginPermissionPrompt = import('@quolldesk/plugin-contract').PermissionRequest & {
    actionToken: string; resources: string[];
  };
  interface QuollDeskPluginPermissionSnapshot {
    policyRevision?: string;
    policies?: Array<{ permission: string; resources: string[]; mode: PluginPermissionMode }>;
    grants: Array<{
      permission: string; resource: string; resourceKind: string;
      scope: 'always' | 'application' | 'session'; sessionId: string | null; grantedAt: number;
      matchesCurrentActivation: boolean;
    }>;
    audit: Array<{ event: string; createdAt: number; permission?: string; scope?: string; mode?: PluginPermissionMode; action?: string }>;
  }

  interface QuollDeskPluginSource {
    id: string;
    kind: 'official' | 'third-party' | 'local' | 'github';
    name: string;
    origin: string | null;
    enabled?: boolean;
    tag?: string;
    commit?: string;
    assetId?: number;
  }
  interface QuollDeskGitHubPluginPreview {
    token: string;
    source: QuollDeskPluginSource;
    manifest: import("@quolldesk/plugin-contract").PluginManifest;
    archiveSha256: string;
    assetName: string;
    size: number;
  }
  interface QuollDeskInstalledPlugin {
    source?: QuollDeskPluginSource;
    id: string;
    enabled: boolean;
    activeVersion: string | null;
    manifest: import("@quolldesk/plugin-contract").PluginManifest | null;
    archiveSha256?: string | null;
    runtime: {
      status: string;
      kind: 'browser' | 'utility' | null;
      lastError: string | null;
      quarantinedAt: number | null;
    };
  }

  interface QuollDeskExtensionProviderContribution {
    pluginId: string;
    pluginVersion: string;
    pluginDisplayName?: string;
    provider: import("@quolldesk/plugin-contract").ProviderContribution;
  }

  interface QuollDeskExtensionProviderRequest {
    providerId: string;
    kind: 'connection' | 'authentication' | 'importer';
    operation: string;
    requestId?: string;
    payload?: import("@quolldesk/plugin-contract").JsonValue;
    deadlineMs?: number;
  }

  interface QuollDeskPluginConnectionStartRequest {
    requestId?: string;
    sessionId: string;
    protocol?: string;
    hostLabel?: string;
    hostname?: string;
    providerId: string;
    configuration: import("@quolldesk/plugin-contract").JsonValue;
    columns: number;
    rows: number;
    credential?: import("@quolldesk/plugin-contract").CredentialRef | import("@quolldesk/plugin-contract").SecretRef;
    authenticationProviderId?: string;
    sessionLog?: { enabled: boolean; directory: string; format: string; timestampsEnabled?: boolean };
    deadlineMs?: number;
  }

  interface QuollDeskPluginImporterPreview {
    providerId: string;
    result: import("@quolldesk/plugin-contract").ImporterParseResult;
    records: ReadonlyArray<import("@quolldesk/plugin-contract").ImporterRecord>;
  }

  interface QuollDeskPluginImporterProgressEvent {
    requestId: string;
    providerId: string;
    progress: Extract<import("@quolldesk/plugin-contract").ImporterRecord, { type: "progress" }>;
  }

  interface QuollDeskPluginAuthenticationChallengeOpenEvent {
    requestId: string;
    challengeRequestId: string;
    challenge: import("@quolldesk/plugin-contract").AuthenticationChallenge;
  }

  interface QuollDeskPluginAuthenticationChallengeCancelEvent {
    requestId: string;
    challengeRequestId: string;
    challengeId?: string;
    cancelled: true;
  }

  type QuollDeskPluginAuthenticationChallengeEvent =
    | QuollDeskPluginAuthenticationChallengeOpenEvent
    | QuollDeskPluginAuthenticationChallengeCancelEvent;

  interface QuollDeskPluginLogStatus {
    saveToDisk: boolean;
    verbose: boolean;
    droppedRecords: number;
    writeErrors: number;
    pendingBytes: number;
    maxBytes: number;
    retentionDays: number;
  }

  interface QuollDeskBridge {
    getPluginLogStatus?(): Promise<QuollDeskPluginLogStatus>;
    configurePluginLogs?(settings: { saveToDisk: boolean; verbose: boolean }): Promise<QuollDeskPluginLogStatus>;
    openPluginLogFolder?(): Promise<QuollDeskPluginLogStatus>;
    exportPluginLogs?(): Promise<QuollDeskPluginLogStatus>;
    clearPluginLogs?(): Promise<QuollDeskPluginLogStatus>;
    getPluginRuntimeStatus?(): Promise<QuollDeskPluginRuntimeStatus>;
    getPluginSourceBinding?(pluginId: string): Promise<QuollDeskPluginSource | null>;
    resetPluginSource?(pluginId: string, expectedSourceId: string): Promise<void>;
    listPluginSources?(): Promise<QuollDeskPluginSource[]>;
    addPluginSource?(source: { name: string; address: string }): Promise<QuollDeskPluginSource>;
    updatePluginSource?(source: { id: string; name: string; enabled: boolean }): Promise<QuollDeskPluginSource>;
    removePluginSource?(id: string, disablePlugins: boolean): Promise<void>;
    listPluginCatalog?(sourceId?: string): Promise<QuollDeskPluginCatalogSnapshot>;
    getPluginAuthorPresentation?(request: QuollDeskPluginAuthorRequest): Promise<QuollDeskPluginAuthorPresentation | null>;
    onPluginCatalogChanged?(callback: (event: { sourceId: string }) => void): () => void;
    getPluginCatalogReadme?(id: string, selectionToken?: string, sourceId?: string): Promise<string>;
    getPluginCatalogReadmeImages?(id: string, selectionToken?: string, sourceId?: string): Promise<Record<string, string>>;
    installCatalogPlugin?(id: string, selectionToken?: string, sourceId?: string, acceptedSourceId?: string): Promise<QuollDeskInstalledPlugin>;
    setPluginAIHostReady?(ready: boolean): Promise<boolean>;
    setPluginAgentHostReady?(ready: boolean): Promise<boolean>;
    respondPluginAgentHost?(response: import("@quolldesk/plugin-contract").PluginAgentHostResponse): Promise<boolean>;
    onPluginAgentHostRequest?(callback: (request: import("@quolldesk/plugin-contract").PluginAgentHostRequest) => void): () => void;
    respondPluginAIHost?(response: import("@quolldesk/plugin-contract").PluginAIHostResponse): Promise<boolean>;
    onPluginAIHostRequest?(callback: (request: import("@quolldesk/plugin-contract").PluginAIHostRequest) => void): () => void;
    setPluginInteractionReady?(ready: boolean): Promise<boolean>;
    respondPluginInteraction?(response: import("@quolldesk/plugin-contract").HostInteractionResponse): Promise<import("@quolldesk/plugin-contract").HostInteractionReceipt>;
    onPluginInteraction?(callback: (event: import("@quolldesk/plugin-contract").HostInteractionEvent) => void): () => void;
    listPlugins?(): Promise<QuollDeskInstalledPlugin[]>;
    setPluginPermissionMode?(pluginId: string, permission: string, mode: PluginPermissionMode, policyRevision: string): Promise<boolean>;
    setPluginPermissionReady?(ready: boolean): Promise<boolean>;
    respondPluginPermission?(response: { requestId: string; actionToken: string; decision: 'allow' | 'deny' | 'cancel' }): Promise<boolean>;
    onPluginPermission?(callback: (event: QuollDeskPluginPermissionPrompt | { requestId: string; closed: true }) => void): () => void;
    getPluginPermissions?(pluginId: string): Promise<QuollDeskPluginPermissionSnapshot>;
    revokePluginPermissions?(pluginId: string): Promise<QuollDeskInstalledPlugin>;
    installPluginPackage?(archivePath: string, options?: { enable?: boolean }): Promise<QuollDeskInstalledPlugin>;
    prepareGitHubPlugin?(repository: string): Promise<QuollDeskGitHubPluginPreview>;
    installGitHubPlugin?(token: string): Promise<QuollDeskInstalledPlugin>;
    discardGitHubPlugin?(token: string): Promise<void>;
    setPluginEnabled?(pluginId: string, enabled: boolean): Promise<QuollDeskInstalledPlugin>;
    restartPlugin?(pluginId: string): Promise<QuollDeskInstalledPlugin>;
    uninstallPlugin?(pluginId: string): Promise<boolean>;
    setPluginTerminalTarget?(target: import("@quolldesk/plugin-contract").HostTerminalTarget): Promise<boolean>;
    getPluginThemes?(): Promise<import("@quolldesk/plugin-contract").ThemePackCatalog>;
    applyPluginTheme?(request: import("@quolldesk/plugin-contract").ThemePackApplyRequest): Promise<import("@quolldesk/plugin-contract").ThemePackCatalog>;
    onPluginThemesChanged?(callback: () => void): () => void;
    getPluginContributions?(options?: QuollDeskPluginContributionQuery): Promise<QuollDeskPluginContributionSnapshot>;
    getPluginBrandIcon?(pluginId: string): Promise<{ light: string; dark?: string } | null>;
    getPluginContributionIcon?(pluginId: string, icon: Extract<QuollDeskPluginIconReference, { kind: 'package' }>): Promise<{ light: string; dark?: string }>;
    executePluginCommand?(command: string, args?: unknown, context?: Record<string, unknown>): Promise<unknown>;
    updatePluginSetting?(pluginId: string, settingId: string, value: unknown, scopeId?: string): Promise<{ restartRequired: boolean }>;
    resetPluginSetting?(pluginId: string, settingId: string, scopeId?: string): Promise<{ restartRequired: boolean }>;
    setPluginEnvironment?(environment: QuollDeskPluginEnvironment): Promise<void>;
    listPluginTerminalProviders?(options: QuollDeskTerminalProviderQuery): Promise<ReadonlyArray<QuollDeskTerminalProviderContribution>>;
    providePluginTerminal?(request: QuollDeskTerminalProviderRequest): Promise<ReadonlyArray<QuollDeskTerminalProviderResult>>;
    cancelPluginTerminalRequest?(requestId: string): Promise<boolean>;
    publishPluginTerminalSessionEvent?(event: QuollDeskTerminalSessionEvent): Promise<ReadonlyArray<{ pluginId: string; delivered: boolean }>>;
    listPluginExtensionProviders?(options: { kind: 'connection' | 'authentication' | 'importer' | 'sync'; locale?: string }): Promise<ReadonlyArray<QuollDeskExtensionProviderContribution>>;
    updatePluginCredentialCatalog?(entries: ReadonlyArray<{ id: string; ciphertext: string }>): Promise<number>;
    invokePluginExtensionProvider?(request: QuollDeskExtensionProviderRequest): Promise<import("@quolldesk/plugin-contract").JsonValue>;
    cancelPluginExtensionRequest?(requestId: string): Promise<boolean>;
    pluginSyncConnect?(request: {
      requestId?: string;
      providerId: string;
      configuration?: unknown;
      credential?: unknown;
      deadlineMs?: number;
    }): Promise<{ account: { id: string; email?: string; name?: string; avatarUrl?: string } }>;
    pluginSyncDisconnect?(request: { requestId?: string; providerId: string; deadlineMs?: number }): Promise<null>;
    pluginSyncGetAccount?(request: { requestId?: string; providerId: string; deadlineMs?: number }): Promise<{
      account: { id: string; email?: string; name?: string; avatarUrl?: string } | null;
    }>;
    pluginSyncGetCapabilities?(request: { requestId?: string; providerId: string; deadlineMs?: number }): Promise<{
      revisions: boolean;
      conditionalWrites: boolean;
      atomicReplacement: boolean;
      maxObjectBytes?: number;
      maxObjects?: number;
    }>;
    pluginSyncReadObject?(request: {
      requestId?: string;
      providerId: string;
      key: string;
      preferStream?: boolean;
      deadlineMs?: number;
    }): Promise<{
      found: boolean;
      key: string;
      data?: Uint8Array | null;
      streamed?: boolean;
      transferId?: string;
      byteLength?: number;
      revision?: string;
      contentType?: string;
    }>;
    pluginSyncReadChunk?(request: {
      requestId: string;
      transferId: string;
      maxBytes?: number;
    }): Promise<{ chunk: Uint8Array; done: boolean }>;
    pluginSyncWriteObject?(request: {
      requestId?: string;
      providerId: string;
      key: string;
      data: Uint8Array;
      expectedRevision?: string | null;
      preferStream?: boolean;
      deadlineMs?: number;
    }): Promise<{ created: boolean; revision?: string }>;
    pluginSyncWriteBegin?(request: {
      requestId?: string;
      providerId: string;
      key: string;
      byteLength: number;
      expectedRevision?: string | null;
      deadlineMs?: number;
    }): Promise<{ transferId: string; windowBytes: number }>;
    pluginSyncWriteChunk?(request: {
      requestId: string;
      transferId: string;
      sequence: number;
      chunk: Uint8Array;
    }): Promise<{ accepted: number }>;
    pluginSyncWriteCommit?(request: {
      requestId: string;
      transferId: string;
    }): Promise<{ created: boolean; revision?: string }>;
    pluginSyncDeleteObject?(request: {
      requestId?: string;
      providerId: string;
      key: string;
      expectedRevision?: string;
      deadlineMs?: number;
    }): Promise<{ deleted: boolean }>;
    pluginSyncPutSecret?(request: {
      providerId: string;
      key: string;
      value: string;
    }): Promise<{ kind: 'secret'; id: string; key: string; created?: boolean }>;
    pluginSyncDeleteSecrets?(request: {
      providerId: string;
      keys?: string[];
    }): Promise<{ deleted: number }>;
    pluginSyncRestoreSecrets?(request: {
      providerId: string;
      keys: string[];
      discard?: boolean;
    }): Promise<{ restored: number; discarded?: number }>;
    collectPluginSyncSidecars?(): Promise<unknown>;
    applyPluginSyncSidecars?(bundle: unknown): Promise<{ applied: boolean; count?: number; entries?: unknown }>;
    pluginHostReady?(): boolean;
    startPluginConnection?(request: QuollDeskPluginConnectionStartRequest): Promise<{ sessionId: string; providerId: string; status: 'connecting' | 'connected'; diagnostics: ReadonlyArray<import("@quolldesk/plugin-contract").ProviderValidationIssue> }>;
    writePluginConnection?(sessionId: string, data: Uint8Array): Promise<void>;
    controlPluginConnection?(sessionId: string, operation: 'resize' | 'signal' | 'reconnect' | 'close' | 'getStatus', payload?: Record<string, unknown>): Promise<unknown>;
    detectPluginImporter?(request: { providerId: string; sample: Uint8Array; fileName?: string; mediaType?: string; deadlineMs?: number }): Promise<import("@quolldesk/plugin-contract").ImporterDetectResult>;
    selectPluginImporterFile?(): Promise<{ selectionToken: string; fileName: string; sample: Uint8Array } | null>;
    releasePluginImporterFile?(selectionToken: string): Promise<boolean>;
    parsePluginImporterFile?(request: { requestId?: string; providerId: string; selectionToken: string; mediaType?: string; options?: import("@quolldesk/plugin-contract").JsonValue; deadlineMs?: number }): Promise<QuollDeskPluginImporterPreview>;
    onPluginImporterProgress?(callback: (event: QuollDeskPluginImporterProgressEvent) => void): () => void;
    respondPluginAuthenticationChallenge?(response: {
      requestId: string;
      challengeRequestId: string;
      challengeId: string;
      response?: string | boolean | ReadonlyArray<string>;
      cancelled?: boolean;
    }): Promise<void>;
    onPluginAuthenticationChallenge?(callback: (event: QuollDeskPluginAuthenticationChallengeEvent) => void): () => void;
    onPluginConnectionData?(callback: (event: { sessionId: string; data: Uint8Array }) => void): () => void;
    onPluginConnectionClosed?(callback: (event: { sessionId: string; reason: string }) => void): () => void;
    getPluginViewResource?(payload: import('@quolldesk/plugin-contract').PluginViewResourceRequest): Promise<import('@quolldesk/plugin-contract').PluginViewResourceResult>;
    openHostDrawnPluginView?(payload: QuollDeskPluginViewOpenRequest): Promise<{ instanceId: string }>;
    closeHostDrawnPluginView?(instanceId: string): Promise<void>;
    sendHostDrawnPluginViewEvent?(instanceId: string, event: import('@quolldesk/plugin-contract').HostDrawnViewEvent): Promise<void>;
    onHostDrawnPluginViewUpdate?(callback: (event: import('@quolldesk/plugin-contract').HostDrawnViewMessage & { viewId: string }) => void): () => void;
    onPluginContributionsChanged?(callback: (event: { reason: string; pluginId: string | null; revision: number }) => void): () => void;
    onPluginViewClosed?(callback: (event: QuollDeskPluginViewClosedEvent) => void): () => void;
    getPluginScopeCatalog?(): Promise<QuollDeskPluginScopeCatalog>;
    setPluginScopeCatalog?(catalog: QuollDeskPluginScopeCatalog): Promise<void>;
    onPluginScopeCatalogChanged?(callback: (catalog: QuollDeskPluginScopeCatalog) => void): () => void;
  }

  interface QuollDeskPluginContributionQuery {
    locale?: string;
    context?: Record<string, unknown>;
    menuContexts?: Partial<Record<string, Record<string, unknown>>>;
    scopeIds?: Partial<Record<'workspace' | 'host' | 'session' | 'device', string>>;
  }

  interface QuollDeskPluginSettingContribution {
    group?: string;
    id: string;
    label: string;
    description?: string;
    placeholder?: string;
    control: string;
    scope: string;
    scopeId: string | null;
    value?: unknown;
    secret?: boolean;
    configured: boolean;
    visible: boolean;
    restartRequired?: boolean;
    required?: boolean;
    options?: ReadonlyArray<{ value: string; label: string; description?: string }>;
    minimum?: number;
    maximum?: number;
    step?: number;
    sortable?: boolean;
    valueSchema?: unknown;
  }

  type QuollDeskPluginIconReference =
    | { kind: 'theme'; name: string }
    | { kind: 'package'; light: string; dark?: string };

  interface QuollDeskPluginContributionSnapshot {
    locale: string;
    plugins: ReadonlyArray<{
      id: string;
      version: string;
      displayName: string;
      description: string;
      commands: ReadonlyArray<{ id: string; title: string; category?: string; description?: string; icon?: QuollDeskPluginIconReference; enabled: boolean }>;
      keybindings: ReadonlyArray<{ command: string; key: string; mac?: string; linux?: string; windows?: string; args?: unknown; enabled: boolean }>;
      menus: ReadonlyArray<{
        id: string;
        command: string;
        alt?: string;
        location: string;
        title: string;
        visible: boolean;
        enabled: boolean;
        checked?: boolean;
        order?: number;
        group?: string;
        shortcut?: string;
        showKeybinding?: boolean;
        icon?: QuollDeskPluginIconReference;
      }>;
      settings: ReadonlyArray<QuollDeskPluginSettingContribution>;
      views: ReadonlyArray<{ id: string; title: string; location: string; icon?: QuollDeskPluginIconReference; order?: number; visible: boolean }>;
    }>;
  }

  interface QuollDeskPluginEnvironment {
    locale: string;
    theme: string;
    reducedMotion: boolean;
    highContrast: boolean;
    themeTokens?: Record<string, string>;
  }

  type QuollDeskTerminalProviderKind =
    | 'terminal.completion'
    | 'terminal.decoration'
    | 'terminal.link'
    | 'terminal.hover'
    | 'terminal.matcher'
    | 'terminal.semantic'
    | 'terminal.prompt'
    | 'terminal.background'
    | 'terminal.theme';

  interface QuollDeskTerminalProviderContribution {
    pluginId: string;
    pluginVersion: string;
    runtimeId?: string;
    pluginDisplayName: string;
    provider: {
      id: string;
      label: string;
      description?: string;
      kind: QuollDeskTerminalProviderKind;
      capabilities?: ReadonlyArray<string>;
      configurationSchema?: unknown;
    };
  }

  interface QuollDeskTerminalProviderQuery {
    kind: QuollDeskTerminalProviderKind;
    locale?: string;
    preferredProviderIds?: ReadonlyArray<string>;
  }

  interface QuollDeskTerminalSessionSnapshot {
    sessionId: string;
    hostId?: string;
    workspaceId?: string;
    protocol: string;
    status: 'connecting' | 'connected' | 'disconnected';
    cwd?: string;
    title?: string;
    shellType?: 'posix' | 'fish' | 'powershell' | 'cmd' | 'unknown';
    cols?: number;
    rows?: number;
    alternateScreen?: boolean;
  }

  interface QuollDeskTerminalSessionEvent {
    type:
      | 'snapshot'
      | 'created'
      | 'connected'
      | 'reconnected'
      | 'cwdChanged'
      | 'titleChanged'
      | 'resized'
      | 'alternateScreenChanged'
      | 'commandSubmitted'
      | 'commandCompleted'
      | 'disconnected'
      | 'disposed';
    session: QuollDeskTerminalSessionSnapshot;
    exitCode?: number;
  }

  interface QuollDeskTerminalProviderRequest {
    requestId: string;
    kind: QuollDeskTerminalProviderKind;
    operation: string;
    session: QuollDeskTerminalSessionSnapshot;
    payload?: unknown;
    locale?: string;
    preferredProviderIds?: ReadonlyArray<string>;
    deadlineMs?: number;
  }

  type QuollDeskTerminalProviderResult = {
    pluginId: string;
    pluginVersion: string;
    runtimeId?: string;
    providerId: string;
    kind: QuollDeskTerminalProviderKind;
    requestId: string;
    status: 'ok';
    result: unknown;
  } | {
    pluginId: string;
    pluginVersion: string;
    runtimeId?: string;
    providerId: string;
    kind: QuollDeskTerminalProviderKind;
    requestId: string;
    status: 'cancelled';
  } | {
    pluginId: string;
    pluginVersion: string;
    providerId: string;
    kind: QuollDeskTerminalProviderKind;
    requestId: string;
    status: 'failed';
    error: { code: number; message: string; data?: unknown };
  };

  type QuollDeskPluginViewOpenRequest = import('@quolldesk/plugin-contract').HostDrawnViewOpenRequest;

  interface QuollDeskPluginViewClosedEvent {
    instanceId: string;
    pluginId: string;
    viewId: string;
    reason: string;
  }

  type QuollDeskPluginSettingScopeKind = 'workspace' | 'host' | 'session' | 'device';

  type QuollDeskPluginScopeCatalog = Record<
    QuollDeskPluginSettingScopeKind,
    ReadonlyArray<{ id: string; label: string }>
  >;

  interface Window {
    quolldesk?: QuollDeskBridge;
  }

}

export { };
