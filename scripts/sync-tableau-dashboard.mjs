import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import vm from "node:vm";

const DEFAULTS = {
  serverUrl: "https://nsfwnbi.nsf.or.th",
  siteContentUrl: "nsf",
  restApiVersion: "3.27",
  datasourceLuid: "08ae6a5c-4b0d-418f-8881-95a11ed5ab28"
};

const YEAR_AD = 2026;
const YEAR_BE = YEAR_AD + 543;
const PERIOD_START = `${YEAR_AD}-01-01`;
const PERIOD_END = `${YEAR_AD}-12-31`;
const DATA_FILE = new URL("../data/2569.js", import.meta.url);
const LIVE_FILE = new URL("../data/tableau-live.js", import.meta.url);
const INDEX_FILE = new URL("../index.html", import.meta.url);
const THAI_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const CHANNEL_NAMES = new Map([
  ["บ. ทรู มันนี่ จำกัด", "ทรูมันนี่"],
  ["ธ. กรุงไทย จำกัด (มหาชน)", "ธ.กรุงไทย"],
  ["ธ. กสิกรไทย จำกัด (มหาชน)", "ธ.กสิกรไทย"],
  ["บ. แอดวานซ์ เอ็มเปย์ จำกัด", "แอดวานซ์ เอ็มเปย์"],
  ["กองทุนการออมแห่งชาติ (agent)", "กอช. (agent)"],
  ["ธ. ออมสิน", "ธ.ออมสิน"],
  ["ธ. เพื่อการเกษตรและสหกรณ์การเกษตร", "ธ.ก.ส."],
  ["สำนักงานคลังจังหวัด", "สนง.คลังจังหวัด"],
  ["บริษัท ช้อปปี้เพย์ (ประเทศไทย) จำกัด", "ช้อปปี้เพย์"],
  ["ร้านเซเว่นอีเลฟเว่น", "เซเว่นอีเลฟเว่น"],
  ["กองทุนการออมแห่งชาติ", "กอช. (สำนักงาน)"],
  ["บริษัท ฟอร์ท สมาร์ท เซอร์วิส จำกัด(มหาชน)(บุญเติม)", "บุญเติม"],
  ["ธ. อาคารสงเคราะห์", "ธ.อาคารสงเคราะห์"],
  ["บริษัท ซีพี แอ็กซ์ตร้า จำกัด (มหาชน)", "ซีพี แอ็กซ์ตร้า"]
]);
const CHANNEL_TYPE_LABELS = new Map([
  ["1", "เคาน์เตอร์ / สาขา"],
  ["2", "ตู้เติมเงิน"],
  ["3", "แอป / e-Wallet"],
  ["4", "ไม่ทราบ"],
  ["5", "โมบายแบงก์กิ้ง"],
  ["6", "ตัวแทน / เจ้าหน้าที่"]
]);

const serverUrl = (process.env.TABLEAU_SERVER_URL || DEFAULTS.serverUrl).replace(/\/$/, "");
const siteContentUrl = process.env.TABLEAU_SITE_CONTENT_URL || DEFAULTS.siteContentUrl;
const restApiVersion = process.env.TABLEAU_REST_API_VERSION || DEFAULTS.restApiVersion;
const datasourceLuid = process.env.TABLEAU_DATASOURCE_LUID || DEFAULTS.datasourceLuid;
const patName = requireSecret("TABLEAU_PAT_NAME");
const patSecret = requireSecret("TABLEAU_PAT_SECRET");

function requireSecret(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function describeNetworkError(error) {
  const details = [error?.message || "unknown network error"];
  if (error?.cause?.code) details.push(`code=${error.cause.code}`);
  if (error?.cause?.message && error.cause.message !== error?.message) {
    details.push(`cause=${error.cause.message}`);
  }
  return details.join("; ");
}

async function requestJson(url, init, label) {
  let response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(90_000),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...init.headers
      }
    });
  } catch (error) {
    throw new Error(`${label} could not reach Tableau Server: ${describeNetworkError(error)}`);
  }

  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text.slice(0, 300) };
    }
  }

  if (!response.ok) {
    const safeMessage = body?.error?.detail || body?.error?.summary || body?.message || "No error detail returned";
    throw new Error(`${label} failed with HTTP ${response.status}: ${safeMessage}`);
  }
  if (body?.error && Object.keys(body.error).length) {
    const safeMessage = body.error.detail || body.error.summary || "Tableau returned a query error";
    throw new Error(`${label} failed: ${safeMessage}`);
  }
  return body;
}

async function signIn() {
  const body = await requestJson(
    `${serverUrl}/api/${restApiVersion}/auth/signin`,
    {
      method: "POST",
      body: JSON.stringify({
        credentials: {
          personalAccessTokenName: patName,
          personalAccessTokenSecret: patSecret,
          site: { contentUrl: siteContentUrl }
        }
      })
    },
    "PAT sign-in"
  );
  const token = body?.credentials?.token;
  if (!token) throw new Error("PAT sign-in succeeded but returned no credentials token");
  return token;
}

async function signOut(token) {
  try {
    await fetch(`${serverUrl}/api/${restApiVersion}/auth/signout`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: { "X-Tableau-Auth": token }
    });
  } catch {
    // The Tableau session expires automatically. Do not hide a completed sync.
  }
}

function calculation(fieldCaption, formula) {
  return { fieldCaption, fieldAlias: fieldCaption, calculation: formula };
}

function periodFilters(types) {
  return [
    {
      field: { fieldCaption: "TYPE" },
      filterType: "SET",
      values: types,
      exclude: false
    },
    {
      field: { fieldCaption: "TR_DATE" },
      filterType: "QUANTITATIVE_DATE",
      quantitativeFilterType: "RANGE",
      minDate: PERIOD_START,
      maxDate: PERIOD_END
    }
  ];
}

async function queryDatasource(token, label, fields, types) {
  const body = await requestJson(
    `${serverUrl}/api/v1/vizql-data-service/query-datasource`,
    {
      method: "POST",
      headers: { "X-Tableau-Auth": token },
      body: JSON.stringify({
        datasource: { datasourceLuid },
        query: { fields, filters: periodFilters(types) },
        options: { debug: false, disaggregate: false, returnFormat: "OBJECTS" }
      })
    },
    label
  );
  if (!Array.isArray(body?.data)) throw new Error(`${label} returned no aggregate rows`);
  return body.data;
}

function expectSingleRow(rows, label) {
  if (rows.length !== 1 || !rows[0] || typeof rows[0] !== "object") {
    throw new Error(`${label} expected exactly one aggregate row`);
  }
  return rows[0];
}

function numberField(row, name, label) {
  const raw = row?.[name];
  if (raw === null || raw === undefined || raw === "") {
    throw new Error(`${label} is missing aggregate field ${name}`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${label} is missing aggregate field ${name}`);
  return value;
}

function textField(row, name, label) {
  const value = row?.[name];
  if (value === null || value === undefined || value === "") return "ไม่ระบุ";
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${label} has an invalid aggregate dimension`);
  }
  return String(value).trim() || "ไม่ระบุ";
}

function normalizeDate(value, label) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) throw new Error(`${label} returned an invalid maximum TR_DATE`);
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  if (iso < PERIOD_START || iso > PERIOD_END) throw new Error(`${label} returned TR_DATE outside ${YEAR_AD}`);
  return iso;
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function thaiDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${THAI_MONTHS[month - 1]} ${year + 543}`;
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + Number(row[field] || 0), 0);
}

function assertClose(actual, expected, tolerance, label) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label} did not reconcile with the Tableau summary`);
  }
}

function loadBaseData(source) {
  const context = { window: {} };
  vm.runInNewContext(source, context, { timeout: 1_000, filename: "data/2569.js" });
  if (!context.window.NSF_DATA) throw new Error("Could not read the current dashboard snapshot");
  return context.window.NSF_DATA;
}

function monthlyRows(rows, asOf) {
  return rows
    .map((row) => {
      const monthDate = normalizeDate(textField(row, "month", "Monthly query"), "Monthly query");
      const key = monthDate.slice(0, 7);
      const monthIndex = Number(key.slice(5, 7)) - 1;
      return {
        key,
        label: THAI_MONTHS[monthIndex],
        members: Math.round(numberField(row, "members", "Monthly query")),
        money: roundMoney(numberField(row, "money", "Monthly query")),
        memberAsOf: thaiDate(asOf),
        moneyAsOf: thaiDate(asOf),
        ...(key === asOf.slice(0, 7) ? { partial: true } : {})
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

function channelRows(rows) {
  return rows
    .map((row) => {
      const full = textField(row, "name", "Channel query");
      return {
        name: CHANNEL_NAMES.get(full) || full,
        full,
        members: Math.round(numberField(row, "members", "Channel query")),
        money: roundMoney(numberField(row, "money", "Channel query"))
      };
    })
    .sort((a, b) => b.members - a.members || b.money - a.money);
}

function channelTypeRows(rows) {
  return rows
    .map((row) => {
      const code = textField(row, "code", "Channel-type query");
      return {
        code,
        label: CHANNEL_TYPE_LABELS.get(code) || `รหัส ${code}`,
        members: Math.round(numberField(row, "members", "Channel-type query")),
        money: roundMoney(numberField(row, "money", "Channel-type query"))
      };
    })
    .sort((a, b) => b.members - a.members || b.money - a.money);
}

const baseSource = await readFile(DATA_FILE, "utf8");
const base = loadBaseData(baseSource);
let token;

try {
  token = await signIn();

  const [summaryRows, followRows, monthResult, channelResult, channelTypeResult] = await Promise.all([
    queryDatasource(token, "New-member summary query", [
      calculation("members", "COUNTD([INVESTOR_CODE])"),
      calculation("money", "SUM([PRINCIPLE])"),
      calculation("avg", "AVG([PRINCIPLE])"),
      calculation("median", "MEDIAN([PRINCIPLE])"),
      calculation("min", "MIN([PRINCIPLE])"),
      calculation("max", "MAX([PRINCIPLE])"),
      calculation("asOf", "MAX([TR_DATE])")
    ], ["1", "3"]),
    queryDatasource(token, "Subsequent-contribution summary query", [
      calculation("members", "COUNTD([INVESTOR_CODE])"),
      calculation("rows", "COUNT([INVESTOR_CODE])"),
      calculation("money", "SUM([PRINCIPLE])")
    ], ["2", "4"]),
    queryDatasource(token, "Monthly aggregate query", [
      { fieldCaption: "TR_DATE", function: "TRUNC_MONTH", fieldAlias: "month", sortPriority: 1 },
      { fieldCaption: "INVESTOR_CODE", function: "COUNTD", fieldAlias: "members" },
      { fieldCaption: "PRINCIPLE", function: "SUM", fieldAlias: "money" }
    ], ["1", "3"]),
    queryDatasource(token, "Channel aggregate query", [
      { fieldCaption: "TR_CHANNEL_NAME", fieldAlias: "name" },
      { fieldCaption: "INVESTOR_CODE", function: "COUNTD", fieldAlias: "members" },
      { fieldCaption: "PRINCIPLE", function: "SUM", fieldAlias: "money" }
    ], ["1", "3"]),
    queryDatasource(token, "Channel-type aggregate query", [
      { fieldCaption: "TR_CHANNEL_TYPE", fieldAlias: "code" },
      { fieldCaption: "INVESTOR_CODE", function: "COUNTD", fieldAlias: "members" },
      { fieldCaption: "PRINCIPLE", function: "SUM", fieldAlias: "money" }
    ], ["1", "3"])
  ]);

  const summary = expectSingleRow(summaryRows, "New-member summary query");
  const follow = expectSingleRow(followRows, "Subsequent-contribution summary query");
  const members = Math.round(numberField(summary, "members", "New-member summary query"));
  const money = roundMoney(numberField(summary, "money", "New-member summary query"));
  const avg = roundMoney(numberField(summary, "avg", "New-member summary query"));
  const median = roundMoney(numberField(summary, "median", "New-member summary query"));
  const min = roundMoney(numberField(summary, "min", "New-member summary query"));
  const max = roundMoney(numberField(summary, "max", "New-member summary query"));
  const asOf = normalizeDate(textField(summary, "asOf", "New-member summary query"), "New-member summary query");

  if (!Number.isInteger(members) || members < 1 || members > 1_000_000) {
    throw new Error("New-member total is outside the approved validation range");
  }
  const previousMembers = Number(base?.totals?.members || 0);
  if (previousMembers && members < previousMembers * 0.8) {
    throw new Error("New-member total decreased by more than 20%; refusing to overwrite the dashboard");
  }
  if (money < 0 || avg < 0 || median < 0 || min < 0 || max < min) {
    throw new Error("New-member monetary aggregates failed validation");
  }
  assertClose(avg, money / members, 0.1, "Average first contribution");

  const months = monthlyRows(monthResult, asOf);
  const channels = channelRows(channelResult);
  const channelTypes = channelTypeRows(channelTypeResult);
  if (!months.length || !channels.length || !channelTypes.length) {
    throw new Error("One or more approved aggregate breakdowns returned no rows");
  }
  assertClose(roundMoney(sum(months, "money")), money, 1, "Monthly money");
  assertClose(roundMoney(sum(channels, "money")), money, 1, "Channel money");
  assertClose(roundMoney(sum(channelTypes, "money")), money, 1, "Channel-type money");
  if (Math.abs(sum(months, "members") - members) > Math.max(10, members * 0.02)) {
    throw new Error("Monthly member counts differ from the distinct-member total by more than 2%");
  }

  const followMembers = Math.round(numberField(follow, "members", "Subsequent-contribution summary query"));
  const followRowsCount = Math.round(numberField(follow, "rows", "Subsequent-contribution summary query"));
  const followMoney = roundMoney(numberField(follow, "money", "Subsequent-contribution summary query"));
  if (followMembers < 0 || followMembers > members || followRowsCount < followMembers || followMoney < 0) {
    throw new Error(
      `Subsequent-contribution aggregates failed validation: members=${followMembers}, rows=${followRowsCount}, money=${followMoney}`
    );
  }

  let memberDrive;
  if (base.memberDrive) {
    const allocated = (base.memberDrive.weekly || []).reduce(
      (total, week) => total + Object.values(week.values || {}).reduce((subtotal, value) => subtotal + Number(value || 0), 0),
      0
    );
    const pendingMembers = Math.max(0, members - Number(base.memberDrive.carryOver || 0) - allocated);
    memberDrive = {
      asOf,
      pending: {
        members: pendingMembers,
        from: base.memberDrive.pending?.from || "2026-08-10",
        to: asOf,
        label: "รอจัดสรรเข้าแคมเปญ"
      }
    };
  }

  const displayDate = thaiDate(asOf);
  const live = {
    meta: {
      periodEnd: asOf,
      periodLabel: `1 ม.ค. – ${displayDate}`,
      dataAsOf: displayDate,
      summaryAsOf: displayDate,
      summaryMembers: members,
      summarySource: "Tableau · VIEW_BI_DS (VizQL Data Service)",
      latestSource: "Tableau · VIEW_BI_DS",
      autoRefresh: "tableau-10m",
      liveSections: ["totals", "followThrough", "months", "channels", "channelTypes"]
    },
    totals: { members, money, avg, median, min, max },
    followThrough: {
      members: followMembers,
      rows: followRowsCount,
      money: followMoney,
      avgPerMember: followMembers ? Math.round(followMoney / followMembers) : 0
    },
    ...(memberDrive ? { memberDrive } : {}),
    months,
    channels,
    channelTypes
  };

  const payload = `/* Generated from aggregate-only Tableau VDS queries. Do not edit manually. */\nwindow.NSF_TABLEAU_LIVE = ${JSON.stringify(live, null, 2)};\n`;
  const fingerprint = createHash("sha256").update(payload).digest("hex").slice(0, 12);
  let index = await readFile(INDEX_FILE, "utf8");
  const cachePattern = /data\/tableau-live\.js\?v=[A-Za-z0-9._-]+/g;
  const cacheMatches = index.match(cachePattern);
  if (!cacheMatches || cacheMatches.length !== 1) {
    throw new Error("Expected one Tableau live-data cache-buster in index.html");
  }
  index = index.replace(cachePattern, `data/tableau-live.js?v=${fingerprint}`);

  await writeFile(LIVE_FILE, payload, "utf8");
  await writeFile(INDEX_FILE, index, "utf8");

  console.log(`Tableau aggregate sync passed: ${members.toLocaleString("en-US")} members as of ${displayDate}`);
  console.log(`Approved live sections: ${live.meta.liveSections.join(", ")}`);
  console.log("No person-level rows, unrestricted metadata, or credentials were written to the repository");
} finally {
  if (token) await signOut(token);
}
