import assert from "node:assert/strict";
import test from "node:test";

import {
  TERMINAL_SIDE_PANEL_AUTO_OPEN_TABS,
  resolveTerminalSidePanelAutoOpen,
  resolveSessionSidePanelAutoOpen,
  type TerminalSidePanelAutoOpenTab,
} from "./terminalSidePanelAutoOpen.ts";
import { TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER } from "../application/state/terminalSidePanelTabs.ts";

test("terminal side panel auto-open stays off by default", () => {
  assert.equal(
    resolveTerminalSidePanelAutoOpen({
      enabled: false,
      selectedTab: "scripts",
      sftpAvailable: true,
    }),
    null,
  );
});

test("terminal side panel auto-open returns the selected non-SFTP pane", () => {
  assert.equal(
    resolveTerminalSidePanelAutoOpen({
      enabled: true,
      selectedTab: "scripts",
      sftpAvailable: false,
    }),
    "scripts",
  );
});

test("terminal side panel auto-open skips SFTP when the session cannot use it", () => {
  assert.equal(
    resolveTerminalSidePanelAutoOpen({
      enabled: true,
      selectedTab: "sftp",
      sftpAvailable: false,
    }),
    null,
  );
});

test("terminal side panel auto-open accepts every selectable side pane", () => {
  const tabs: TerminalSidePanelAutoOpenTab[] = [...TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER];

  assert.deepEqual(TERMINAL_SIDE_PANEL_AUTO_OPEN_TABS, TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER);

  assert.deepEqual(
    tabs.map((selectedTab) =>
      resolveTerminalSidePanelAutoOpen({
        enabled: true,
        selectedTab,
        sftpAvailable: true,
      }),
    ),
    tabs,
  );
});

const preferences = {
  terminalEnabled: true,
  terminalTab: "notes" as const,
  localEnabled: true,
  localTab: "sftp" as const,
  legacySftpEnabled: false,
};

test("local sessions use their separate auto-open preference", () => {
  assert.equal(resolveSessionSidePanelAutoOpen({ ...preferences, session: { protocol: "local" } }), "sftp");
  assert.equal(resolveSessionSidePanelAutoOpen({ ...preferences, localEnabled: false, session: { protocol: "local" } }), null);
});

test("SSH, mosh and legacy sessions use remote preferences", () => {
  for (const protocol of ["ssh", "mosh", undefined] as const) {
    assert.equal(resolveSessionSidePanelAutoOpen({ ...preferences, session: { protocol } }), "notes");
    assert.equal(resolveSessionSidePanelAutoOpen({ ...preferences, terminalTab: "sftp", localEnabled: false, session: { protocol } }), "sftp");
  }
});

test("legacy SFTP auto-open preserves remote behavior without overriding local opt-out", () => {
  const options = { ...preferences, terminalEnabled: false, localEnabled: false, legacySftpEnabled: true };
  assert.equal(resolveSessionSidePanelAutoOpen({ ...options, session: { protocol: "local" } }), null);
  assert.equal(resolveSessionSidePanelAutoOpen({ ...options, session: { protocol: "ssh" } }), "sftp");
});

test("explicit per-session SFTP requests take priority on supported transports", () => {
  for (const protocol of ["ssh", "mosh", "local", undefined] as const) {
    assert.equal(resolveSessionSidePanelAutoOpen({ ...preferences, localEnabled: false, session: { protocol, autoOpenSidePanel: "sftp" } }), "sftp");
  }
  for (const protocol of ["serial", "telnet", "plugin:example"] as const) {
    assert.equal(resolveSessionSidePanelAutoOpen({ ...preferences, terminalTab: "sftp", legacySftpEnabled: true, session: { protocol, autoOpenSidePanel: "sftp" } }), null);
  }
});

test("Browser auto-open skips unsupported terminal protocols", () => {
  for (const protocol of ['ssh', 'mosh', 'local', undefined] as const) {
    assert.equal(resolveSessionSidePanelAutoOpen({ ...preferences, terminalTab: 'browser', localTab: 'browser', session: { protocol } }), 'browser');
  }
  for (const protocol of ['telnet', 'serial', 'et', 'plugin:example'] as const) {
    assert.equal(resolveSessionSidePanelAutoOpen({ ...preferences, terminalTab: 'browser', session: { protocol } }), null);
  }
});

test("database sessions never auto-open terminal-bound panes", () => {
  const dbProtocols = ['redis', 'mysql', 'postgresql', 'mariadb', 'mssql', 'sqlite'] as const;
  for (const protocol of dbProtocols) {
    for (const boundTab of ['sftp', 'browser', 'scripts', 'history', 'system'] as const) {
      assert.equal(
        resolveSessionSidePanelAutoOpen({ ...preferences, terminalTab: boundTab, session: { protocol } }),
        null,
        `${boundTab} @ ${protocol}`,
      );
    }
    assert.equal(resolveSessionSidePanelAutoOpen({ ...preferences, terminalTab: 'ai', session: { protocol } }), 'ai');
    assert.equal(resolveSessionSidePanelAutoOpen({ ...preferences, terminalTab: 'theme', session: { protocol } }), 'theme');
  }
  assert.equal(resolveSessionSidePanelAutoOpen({ ...preferences, terminalTab: 'notes', session: { protocol: 'redis' } }), 'notes');
});

test("shell-capable sessions keep every terminal-bound auto-open target", () => {
  for (const protocol of ['ssh', 'mosh', undefined, 'telnet', 'serial', 'et'] as const) {
    assert.equal(
      resolveSessionSidePanelAutoOpen({ ...preferences, terminalTab: 'scripts', session: { protocol } }),
      'scripts',
      `scripts @ ${protocol}`,
    );
    assert.equal(
      resolveSessionSidePanelAutoOpen({ ...preferences, terminalTab: 'system', session: { protocol } }),
      'system',
      `system @ ${protocol}`,
    );
  }
  // Local sessions follow their own preference path, unchanged by the DB gate.
  assert.equal(
    resolveSessionSidePanelAutoOpen({ ...preferences, terminalTab: 'scripts', session: { protocol: 'local' } }),
    'sftp',
  );
});
