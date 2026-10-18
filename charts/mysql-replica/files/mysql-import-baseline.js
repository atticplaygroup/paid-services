#!/usr/bin/env -S mysqlsh --no-defaults --js --file
function required(name) {
  const value = os.getenv(name);
  if (!value) throw new Error("missing env: " + name);
  return value;
}
const directory = required("BASELINE_DIR");
const metadata = JSON.parse(os.loadTextFile(os.getenv("BASELINE_METADATA_FILE") || directory + "/@.json"));
if (metadata.consistent !== true || metadata.gtidExecutedInconsistent !== false ||
    typeof metadata.gtidExecuted !== "string" || !Array.isArray(metadata.schemas)) {
  throw new Error("invalid baseline GTID metadata");
}
shell.connect({
  scheme: "mysql",
  host: required("MYSQL_HOST"),
  port: Number(required("MYSQL_PORT")),
  user: required("MYSQL_USER"),
  password: required("MYSQL_PASSWORD"),
});
const connection = shell.getSession();
// A baseline replaces the selected schemas and replica history, without local GTIDs.
connection.runSql("SET SESSION sql_log_bin=0");
for (const schema of metadata.schemas) {
  connection.runSql("DROP DATABASE IF EXISTS `" + schema.replace(/`/g, "``") + "`");
}
connection.runSql("RESET MASTER");
// Shell needs LOCAL INFILE during load; restore the previous setting afterwards.
const localInfile = connection.runSql("SELECT @@GLOBAL.local_infile").fetchOne()[0];
try {
  connection.runSql("SET GLOBAL local_infile=ON");
  const storageOptions = os.getenv("BASELINE_STORAGE") === "s3" ? {
    s3BucketName: required("S3_BUCKET"),
    s3Region: os.getenv("AWS_REGION") || "us-east-1",
    s3EndpointOverride: os.getenv("S3_ENDPOINT") || "",
  } : {};
  util.loadDump(directory, Object.assign(storageOptions, {
    threads: Number(os.getenv("MYSQL_LOAD_THREADS") || "4"),
    skipBinlog: true,
    updateGtidSet: "replace",
    resetProgress: true,
    showProgress: false,
  }));
} finally {
  connection.runSql("SET GLOBAL local_infile=" + (localInfile ? "ON" : "OFF"));
}
const matches = connection.runSql(
  "SELECT GTID_SUBSET(?, @@GLOBAL.gtid_executed) AND GTID_SUBSET(@@GLOBAL.gtid_executed, ?)",
  [metadata.gtidExecuted, metadata.gtidExecuted],
).fetchOne()[0];
if (matches !== 1) throw new Error("restored GTIDs do not match baseline metadata");
print("baseline import complete\n");
