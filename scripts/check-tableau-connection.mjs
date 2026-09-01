const DEFAULTS = {
  serverUrl: "https://nsfwnbi.nsf.or.th",
  siteContentUrl: "nsf",
  restApiVersion: "3.27",
  datasourceLuid: "08ae6a5c-4b0d-418f-8881-95a11ed5ab28"
};

// Only these aggregate-safe fields may be acknowledged in logs. The metadata
// response can contain person-level field names, so never print it wholesale.
const SAFE_REQUIRED_FIELDS = [
  "INVESTOR_CODE",
  "PRINCIPLE",
  "TR_DATE",
  "TYPE",
  "TR_CHANNEL_NAME",
  "TR_CHANNEL_TYPE"
];

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
  const causeCode = error?.cause?.code;
  const causeMessage = error?.cause?.message;

  if (causeCode) details.push(`code=${causeCode}`);
  if (causeMessage && causeMessage !== error?.message) details.push(`cause=${causeMessage}`);

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
    // Limit diagnostics to the network error and its code. Never log request
    // bodies, headers, PAT values, Tableau responses, or unrestricted metadata.
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
  const siteLuid = body?.credentials?.site?.id;
  if (!token || !siteLuid) throw new Error("PAT sign-in succeeded but returned no credentials token or site LUID");
  return { token, siteLuid };
}

async function signOut(token) {
  try {
    await fetch(`${serverUrl}/api/${restApiVersion}/auth/signout`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: { "X-Tableau-Auth": token }
    });
  } catch {
    // The short-lived session expires on its own. A sign-out failure must not
    // hide the result of the permission check.
  }
}

async function readMetadata(token) {
  return requestJson(
    `${serverUrl}/api/v1/vizql-data-service/read-metadata`,
    {
      method: "POST",
      headers: { "X-Tableau-Auth": token },
      body: JSON.stringify({ datasource: { datasourceLuid } })
    },
    "VizQL Data Service metadata check"
  );
}

let session;
try {
  session = await signIn();
  const metadata = await readMetadata(session.token);
  const captions = new Set(
    (Array.isArray(metadata?.data) ? metadata.data : [])
      .map((field) => field?.fieldCaption)
      .filter((caption) => typeof caption === "string")
  );
  const missing = SAFE_REQUIRED_FIELDS.filter((field) => !captions.has(field));

  if (missing.length) {
    throw new Error(`Connected safely, but required aggregate fields are missing: ${missing.join(", ")}`);
  }

  console.log("Tableau connection check passed");
  console.log(`Server: ${serverUrl}`);
  console.log(`Site: ${siteContentUrl}`);
  console.log(`Datasource: ${datasourceLuid}`);
  console.log(`Approved aggregate fields found: ${SAFE_REQUIRED_FIELDS.join(", ")}`);
  console.log("No Tableau data rows or unrestricted metadata were written to logs");
} finally {
  if (session?.token) await signOut(session.token);
}
