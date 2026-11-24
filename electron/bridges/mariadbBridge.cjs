"use strict";
/**
 * MariaDB Bridge — quolldesk:mariadb:*。mysql2 原生兼容 MariaDB 协议;
 * EXPLAIN/SHOW 系列行为与 MySQL 一致,信息schema 元数据共用。
 */
const { createMysqlFamilyBridge } = require("./dbCommon/mysqlFamily.cjs");
const family = createMysqlFamilyBridge({ channel: "mariadb", dialect: "mariadb" });
module.exports = family;
