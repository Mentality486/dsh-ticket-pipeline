
const fs = require("fs");
const p = "scripts/feishu-checks.mjs";
let s = fs.readFileSync(p, "utf8");
const before = s;
const old1 = String.raw`/\/bitable\/v1\/apps\/[^/]+\/tables/.test(r.url))
    assert.equal(tablesCalls.length, 2`;
const new1 = String.raw`/\/bitable\/v1\/apps\/[^/]+\/tables$/.test(r.url))
    assert.equal(tablesCalls.length, 2`;
s = s.replace(old1, new1);
s = s.split("
").filter(l => !l.includes("DBG tables:")).join("
");
if (s === before) { console.log("NO-CHANGE"); process.exit(1); }
fs.writeFileSync(p, s);
console.log("PATCHED");
