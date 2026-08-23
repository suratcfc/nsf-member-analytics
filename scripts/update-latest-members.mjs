import { readFile, writeFile } from "node:fs/promises";

const SOURCE_URL = "https://dashboard.nsf.or.th/";
const DATA_FILE = new URL("../data/2569.js", import.meta.url);
const THAI_MONTHS = {
  "ม.ค": 1, "ก.พ": 2, "มี.ค": 3, "เม.ย": 4,
  "พ.ค": 5, "มิ.ย": 6, "ก.ค": 7, "ส.ค": 8,
  "ก.ย": 9, "ต.ค": 10, "พ.ย": 11, "ธ.ค": 12
};

const response = await fetch(SOURCE_URL, {
  headers: { "user-agent": "nsf-member-analytics/1.0 (+https://github.com/suratcfc/nsf-member-analytics)" }
});
if (!response.ok) throw new Error(`Dashboard source returned HTTP ${response.status}`);

const html = (await response.text()).replaceAll("&nbsp;", " ");
const dateMatch = html.match(/รายงานข้อมูลสมาชิก[\s\S]{0,300}?ณ วันที่\s*(\d{1,2})\s*([ก-๙.]+)\s*(\d{4})/);
const memberMatch = html.match(/สมาชิกใหม่[\s\S]{0,1500}?<h3[^>]*>\s*([\d,]+)/i);
if (!dateMatch || !memberMatch) throw new Error("Could not find the published date or new-member total");

const day = Number(dateMatch[1]);
const monthLabel = dateMatch[2].replace(/\.$/, "");
const month = THAI_MONTHS[monthLabel];
const yearBE = Number(dateMatch[3]);
const members = Number(memberMatch[1].replaceAll(",", ""));
if (!month || !Number.isInteger(day) || day < 1 || day > 31 || yearBE < 2569) {
  throw new Error(`Unexpected published date: ${dateMatch[0]}`);
}
if (!Number.isInteger(members) || members < 1 || members > 146000) {
  throw new Error(`Unexpected new-member total: ${memberMatch[1]}`);
}

const iso = `${yearBE - 543}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const displayDate = `${day} ${monthLabel}. ${yearBE}`;
const periodLabel = `1 ม.ค. – ${displayDate}`;
let data = await readFile(DATA_FILE, "utf8");

function replaceOne(pattern, replacement, label) {
  const matches = data.match(pattern);
  if (!matches || matches.length !== 1) throw new Error(`Expected one ${label} field`);
  data = data.replace(pattern, replacement);
}
replaceOne(/periodEnd:\s*"[^"]+"/g, `periodEnd: "${iso}"`, "periodEnd");
replaceOne(/periodLabel:\s*"[^"]+"/g, `periodLabel: "${periodLabel}"`, "periodLabel");
replaceOne(/dataAsOf:\s*"[^"]+"/g, `dataAsOf: "${displayDate}"`, "dataAsOf");
replaceOne(/(totals:\s*\{\s*members:\s*)\d+/g, `$1${members}`, "totals.members");

await writeFile(DATA_FILE, data, "utf8");
console.log(`Latest member total: ${members.toLocaleString("en-US")} as of ${displayDate}`);
