#!/usr/bin/env -S mysqlsh --no-defaults --js --file
function required(name) {
  const value = os.getenv(name);
  if (!value) throw new Error("missing env: " + name);
  return value;
}
shell.connect({
  scheme: "mysql",
  host: required("MYSQL_HOST"),
  port: Number(required("MYSQL_PORT")),
  user: required("MYSQL_USER"),
  password: required("MYSQL_PASSWORD"),
});
const directory = required("OUTPUT_DIR");
const schemas = required("MYSQL_EXPORT_SCHEMAS").split(",");
const sourceSession = shell.getSession();
const sourceStatus = sourceSession.runSql("SHOW MASTER STATUS").fetchOne();
const filter = sourceStatus && sourceStatus[2] ? sourceStatus[2].split(",").sort() : [];
const sourceSettings = sourceSession.runSql("SELECT @@GLOBAL.binlog_format, @@GLOBAL.binlog_rows_query_log_events").fetchOne();
if (!sourceStatus || JSON.stringify(filter) !== JSON.stringify(schemas.slice().sort()) || sourceStatus[3] ||
    sourceSettings[0] !== "ROW" || sourceSettings[1] !== 0) {
  throw new Error("source must use ROW binlogs, disable binlog_rows_query_log_events, and set binlog-do-db exactly to MYSQL_EXPORT_SCHEMAS with no binlog-ignore-db");
}
util.dumpInstance(directory, {
  includeSchemas: schemas,
  users: false,
  consistent: true,
  threads: Number(os.getenv("MYSQL_DUMP_THREADS") || "4"),
  showProgress: false,
});
// Native metadata describes the workers' shared snapshot, not a later source query.
const metadata = JSON.parse(os.loadTextFile(directory + "/@.json"));
if (metadata.consistent !== true || metadata.gtidExecutedInconsistent !== false ||
    typeof metadata.gtidExecuted !== "string" || !metadata.binlogFile ||
    typeof metadata.binlogPosition !== "number") {
  throw new Error("missing or inconsistent dump recovery metadata");
}
print("baseline export complete: " + directory + "\n");
