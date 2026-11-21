import React from "react";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { useAiDatabaseAccessState } from "../../../../application/state/useAiDatabaseAccessState";
import { SettingCard, SettingRow, SettingsSection, Toggle } from "../../settings-ui";

/**
 * "AI database access" master switch (spec §6): disables the database.* and
 * redis.* capability tools on both AI surfaces (built-in agent + MCP server).
 */
export const DatabaseAccessSettings: React.FC = () => {
  const { t } = useI18n();
  const { enabled, setEnabled } = useAiDatabaseAccessState();

  return (
    <SettingsSection title={t("ai.access.title")}>
      <SettingCard divided>
        <SettingRow
          anchorId="ai-database-access-enable"
          label={t("ai.access.enable")}
          description={t("ai.access.enable.description")}
        >
          <Toggle
            checked={enabled}
            onChange={(next) => setEnabled(next)}
          />
        </SettingRow>
      </SettingCard>
    </SettingsSection>
  );
};
