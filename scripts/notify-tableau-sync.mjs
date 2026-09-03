const token = process.env.GH_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const result = process.env.TABLEAU_SYNC_RESULT;
const runId = process.env.GITHUB_RUN_ID;
const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";
const issueTitle = "[Dashboard] Tableau sync unavailable";

if (!token) throw new Error("GH_TOKEN is not configured");
if (!repository || !repository.includes("/")) {
  throw new Error("GITHUB_REPOSITORY is not configured");
}

const [owner, repo] = repository.split("/");
const runUrl = `${serverUrl}/${repository}/actions/runs/${runId}`;

async function github(path, init = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      ...init.headers
    }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`GitHub API ${init.method || "GET"} ${path} failed with HTTP ${response.status}`);
  }
  return body;
}

const issues = await github(`/repos/${owner}/${repo}/issues?state=open&per_page=100`);
const openIssue = issues.find((issue) => !issue.pull_request && issue.title === issueTitle);

if (result === "failure") {
  if (openIssue) {
    console.log(`Alert issue #${openIssue.number} is already open`);
    process.exit(0);
  }

  const body = [
    "การอัปเดต Dashboard จาก Tableau ล้มเหลวและต้องตรวจสอบ",
    "",
    `- Workflow run: ${runUrl}`,
    `- Result: ${result}`,
    "",
    "ระบบจะลองใหม่ตามรอบอัตโนมัติ และจะปิด issue นี้เมื่อเชื่อมต่อและตรวจข้อมูลสำเร็จอีกครั้ง",
    "",
    "หมายเหตุ: issue นี้ไม่มี PAT หรือข้อมูลระดับบุคคล"
  ].join("\n");

  let created;
  try {
    created = await github(`/repos/${owner}/${repo}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: issueTitle, body, assignees: [owner] })
    });
  } catch {
    created = await github(`/repos/${owner}/${repo}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: issueTitle, body })
    });
  }
  console.log(`Opened alert issue #${created.number}`);
  process.exit(0);
}

if (result === "success" && openIssue) {
  await github(`/repos/${owner}/${repo}/issues/${openIssue.number}/comments`, {
    method: "POST",
    body: JSON.stringify({
      body: `Tableau sync recovered successfully: ${runUrl}`
    })
  });
  await github(`/repos/${owner}/${repo}/issues/${openIssue.number}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed", state_reason: "completed" })
  });
  console.log(`Resolved alert issue #${openIssue.number}`);
  process.exit(0);
}

console.log(`No alert change is needed for workflow result: ${result}`);
