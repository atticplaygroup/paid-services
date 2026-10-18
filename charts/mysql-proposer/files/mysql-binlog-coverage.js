#!/usr/bin/env -S mysqlsh --no-defaults --js --file
// GTID sets come only from the exported binlogs, including their previous history.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allowed = new Set(os.getenv("MYSQL_EXPORT_SCHEMAS").split(","));
const history = new Map();
let start = null, previous = false, firstPrevious = false;
const one = BigInt(1), maximum = (one << BigInt(63)) - one;

function add(set, uuid, first, last) {
  if (first < one || last < first || last > maximum) throw new Error("invalid GTID interval");
  uuid = uuid.toLowerCase();
  if (!set.has(uuid)) set.set(uuid, []);
  const intervals = set.get(uuid), tail = intervals[intervals.length - 1];
  if (tail && tail[0] <= first && first <= tail[1] + one) tail[1] = last > tail[1] ? last : tail[1];
  else intervals.push([first, last]);
}
function parse(set, text) {
  for (const group of text.replace(/,+$/, "").split(",")) {
    const parts = group.split(":"), uuid = parts.shift();
    if (!uuidPattern.test(uuid) || !parts.length) throw new Error("invalid GTID set");
    for (const interval of parts) {
      const bounds = interval.split("-");
      add(set, uuid, BigInt(bounds[0]), BigInt(bounds[bounds.length - 1]));
    }
  }
}
function encode(set) {
  return Array.from(set.keys()).sort().map(uuid => {
    const merged = [];
    for (const interval of set.get(uuid).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) {
      const tail = merged[merged.length - 1];
      if (tail && interval[0] <= tail[1] + one) tail[1] = interval[1] > tail[1] ? interval[1] : tail[1];
      else merged.push(interval.slice());
    }
    return uuid + ":" + merged.map(([a, b]) => a === b ? String(a) : a + "-" + b).join(":");
  }).join(",");
}
for (const line of os.loadTextFile(os.getenv("BINLOG_METADATA_FILE")).split("\n")) {
  if (line.startsWith("#") && line.includes("Previous-GTIDs")) {
    previous = true;
    firstPrevious = start === null;
    if (firstPrevious) start = new Map();
    continue;
  }
  if (previous) {
    const match = line.match(/^# ([0-9a-f-]+:[0-9:,-]+)$/i);
    if (match) {
      parse(history, match[1]);
      if (firstPrevious) parse(start, match[1]);
      continue;
    }
    previous = false;
  }
  const table = line.match(/Table_map: `([^`]+)`/);
  if (table && !allowed.has(table[1])) throw new Error("retained binlogs contain excluded schema " + table[1]);
  const transaction = line.match(/^SET @@SESSION.GTID_NEXT= '([^']+)'/);
  if (transaction) {
    if (transaction[1] === "ANONYMOUS") throw new Error("retained binlogs contain anonymous transactions");
    if (transaction[1] !== "AUTOMATIC") parse(history, transaction[1]);
  }
}
if (start === null) throw new Error("binlogs lack Previous-GTIDs history");
print(JSON.stringify({gtid_start: encode(start), gtid_end: encode(history)}));
