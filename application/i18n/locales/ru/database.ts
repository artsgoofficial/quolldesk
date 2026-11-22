import type { Messages } from '../types';

/**
 * Russian database messages. The ru locale is still catching up to full key
 * parity with en (see localeParityLocales.test.ts LOCALES_PENDING_PARITY), so
 * this file starts with the keys introduced by the five-SQL-engine expansion;
 * the rest of the db.* namespace falls back to en until translated.
 */
export const ruDatabaseMessages: Messages = {
  'db.form.type': 'Тип',
  'db.form.databaseFile': 'Файл базы данных',
  'db.form.browse': 'Обзор...',
  'db.form.fileNewHint': 'Если файл не существует, он будет создан',
  'db.form.readOnlyOpen': 'Открыть в режиме «только чтение»',
  'db.form.mssqlAuthHint': 'Только проверка подлинности SQL Server (имя пользователя/пароль) — встроенная проверка подлинности Windows не поддерживается',
  'db.designer.sqliteColumnRebuild': 'SQLite не может применить это изменение через ALTER TABLE — пересоздайте таблицу.',
  'db.designer.mssqlDefaultUnsupported': 'SQL Server не поддерживает изменение значений по умолчанию для столбцов здесь — измените значение по умолчанию отдельной инструкцией ALTER.',
};

export default ruDatabaseMessages;
