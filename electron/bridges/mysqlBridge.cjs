"use strict";
/**
 * MySQL Bridge — quolldesk:mysql:* 频道。实现体在 dbCommon/mysqlFamily.cjs
 * (与 MariaDB 桥共享,差异仅频道前缀与 dialect 标签)。
 */
const { createMysqlFamilyBridge } = require("./dbCommon/mysqlFamily.cjs");
const family = createMysqlFamilyBridge({ channel: "mysql", dialect: "mysql" });
module.exports = family;
