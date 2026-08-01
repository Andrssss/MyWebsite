/* =========================
   EXPERIENCE EXTRACTION — shared core
   Per-source extractors + generic enrichment helper.
   Used by source cron files (cron_jobs_*-background.mjs) and
   by cron_experience-background.mjs for LinkedIn.
   ========================= */

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { logFetchError } from "./_error-logger.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL missing");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

/* ======================
   Helpers
====================== */
function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export const INTERNSHIP_KEYWORDS = [
  "gyakornok", "intern", "internship", "trainee",
  "pályakezdő", "palyakezdo", "diákmunka", "diakmunka",
  "tehetsegprogram", "tehetségprogram", "talent", "student", "students", "early career",
];

// "graduate" (e.g. "New College Graduate", "Graduate Software Engineer") means
// someone who has ALREADY finished their studies and is being hired as a
// full-time entry-level employee — that's "junior", not "diákmunka" (which in
// this app specifically means still-enrolled/part-time student work). Titles
// that are genuinely internship-shaped despite also saying "graduate" (e.g.
// "Graduate Trainee Program") still resolve to diákmunka via the separate
// "intern"/"trainee" keyword above — isInternshipTitle is checked first.
// Fixed 2026-07-30 after NVIDIA's "Formal Verification Engineer - New College
// Graduate" AI-scraped find got mislabeled diákmunka.
export const JUNIOR_KEYWORDS = [
  "junior", "graduate",
];

export const MID_KEYWORDS = [
  "medior", "mid-level", "mid level",
];

// Word-boundary match so e.g. "intern" doesn't fire on "internal"/"international"
// and "mid" (from "mid-level") doesn't fire on "midtown" etc.
function hasKeyword(text, keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
}

export function isInternshipTitle(title) {
  const t = normalizeText(title);
  return INTERNSHIP_KEYWORDS.some(k => hasKeyword(t, k));
}

export function isJuniorTitle(title) {
  const t = normalizeText(title);
  return JUNIOR_KEYWORDS.some(k => hasKeyword(t, k));
}

export function isMidLevelTitle(title) {
  const t = normalizeText(title);
  return MID_KEYWORDS.some(k => hasKeyword(t, k));
}

// Senior detection — kept in sync with isSeniorExperience in src/JobWatcher.jsx
// (frontend hides/filters on this same rule; used here so cron_daily_stats.mjs
// excludes senior postings from the statistics the same way).
export const SENIOR_MIN_YEARS = 5;
export function isSeniorExperience(experience) {
  const n = normalizeText(experience);
  if (/\b(senior|szenior|lead)\b/.test(n)) return true;
  const nums = n.match(/\d+/g);
  if (!nums) return false;
  return Math.min(...nums.map(x => parseInt(x, 10))) >= SENIOR_MIN_YEARS;
}

// Sources that are inherently student/intern focused
export const INTERN_SOURCES = [
  "minddiak", "muisz", "zyntern", "schonherz",
  "tudasdiak", "tudatosdiak", "ydiak", "qdiak", "miszisz",
];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* ======================
   Fetch
====================== */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/121.0.0.0 Safari/537.36";

export function fetchText(url, redirectLeft = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;

    const req = lib.request(
      u,
      {
        method: "GET",
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,*/*",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip,deflate,br",
        },
        timeout: 25000,
      },
      (res) => {
        const code = res.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(code)) {
          const loc = res.headers.location;
          if (!loc) return reject(new Error(`HTTP ${code} (no Location) for ${url}`));
          if (redirectLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
          const nextUrl = new URL(loc, url).toString();
          res.resume();
          return resolve(fetchText(nextUrl, redirectLeft - 1));
        }

        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;
        if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());
        else if (enc.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());

        let data = "";
        stream.setEncoding("utf8");
        stream.on("data", c => data += c);
        stream.on("end", () => {
          if (code >= 200 && code < 300) resolve(data);
          else reject(new Error(`HTTP ${code} for ${url}`));
        });
        stream.on("error", reject);
      }
    );

    req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on("error", reject);
    req.end();
  });
}

/* ======================
   Experience regex (shared)
====================== */
export function extractYearsFromText(text) {
  if (!text) return null;

  // Betű→szám határra szóközt szúrunk. A hirdetés-leírásokban a felsorolás-pontok
  // gyakran elválasztó nélkül összeérnek ("…végzettség1-5 év", "…field2–3 years"):
  // a betűhöz tapadt szám elé nincs \b, így a tartomány-regex az ALSÓ határt
  // elvesztette és csak a felső számot fogta ("5 év" a "1-5 év" helyett). A block-
  // padding ezt nem oldja meg, ha a pontok közt nincs block-elem (csak szövegcsomó).
  text = String(text).replace(/(\p{L})(\d)/gu, "$1 $2");

  const patterns = [
    // "N év" / "N-M év" / "N–M+ years" / "N+ years" — az opcionális [-–]tartomány
    // UTÁN álló '+' is a matchbe kerül. Külön "\d+\+ years" pattern nélkül,
    // különben "5–7+ years"-ből csak a "7+ years" maradt (a tartomány eleje
    // elveszett — 2026-07-20 user-jelzés az alllocaljobs badge-ekre).
    /\b\d+\s?(?:[-–]\s?\d+)?\s?\+?\s?(?:év|éves|eves|years?|yrs?)\b/gi,
    /\bminimum\s?\d+\s?(?:év|eves|years?|yrs?)\b/gi,
    /\bat least\s?\d+\s?\+?\s?(?:years?)\b/gi,
    // Ékezetes és ékezet nélküli forma is ("Legalább 5 év" / "legalabb 5 ev") —
    // a /i flag miatt a kis/nagy kezdőbetű mindkettőnél lefedve.
    /\blegal[áa]bb\s+\d+\s?(?:[ée]ves|[ée]v|years?)\b/gi,
    /\btobb\s?eves\b/gi,
    /\bseveral\s?years?\b/gi,
  ];

  const matches = [];
  for (const regex of patterns) {
    const found = text.match(regex);
    if (found) matches.push(...found);
  }

  if (!matches.length) return null;

  const maxReasonable = 15;
  const filtered = matches.filter(m => {
    const nums = m.match(/\d+/g)?.map(n => parseInt(n, 10)) || [];
    return nums.every(n => n <= maxReasonable);
  });

  if (!filtered.length) return null;

  const normalized = [...new Set(
    filtered.map(m => m.replace(/\s+/g, " ").trim().toLowerCase())
  )];
  // Egy másik matchbe teljesen beleférő találatot eldobunk ("minimum 3 years"
  // elnyeli a puszta "3 years"-t) — így nem "3 years, minimum 3 years" a badge.
  return normalized
    .filter((m, _i, arr) => !arr.some((other) => other !== m && other.includes(m)))
    .join(", ");
}

/* ======================
   Source-specific extractors
====================== */

// LinkedIn: .description / .show-more-less-html__markup
export function extractLinkedInExperience(html) {
  const $ = cheerioLoad(html);
  // Block elemek közé szóközt szúrunk, különben a szomszédos <li>-k szövege
  // összeragad: a LinkedIn a követelményeket sibling <li>-kben adja
  // ("…végzettség</li><li>3-5 év…"), és padding nélkül a cheerio .text()
  // "végzettség3-5 év"-et csinál — így a "3" elé nincs \b, a tartomány-regex
  // csak a "5 év"-et fogja meg, és egy 3–5 éves junior/medior hirdetés
  // senior-ként olvasódik. Ugyanaz a fix, amit az extractBodyExperience használ.
  $("li, p, div, br, h1, h2, h3, h4, h5, h6, td, th, tr").each((_, el) => {
    $(el).prepend(" ").append(" ");
  });
  const description = normalizeWhitespace(
    $(".description, .job-description, #job-details, .show-more-less-html__markup")
      .first()
      .text()
  ) || null;

  return extractYearsFromText(description);
}

// profession-intern: #box_az-allashoz-tartozo-elvarasok, with body fallback
export function extractProfessionExperience(html) {
  const $ = cheerioLoad(html);
  const box = $("#box_az-allashoz-tartozo-elvarasok");
  const listText = box.find("ul > li")
    .map((i, el) => normalizeWhitespace($(el).text()))
    .get()
    .join(" ");

  let description = normalizeWhitespace(box.text()) || "";
  description = description ? description + " " + listText : listText || null;

  const fromBox = extractYearsFromText(description);
  if (fromBox) return fromBox;

  // Fallback: full body scan (handles English-language jobs, variant layouts)
  const pageText = normalizeWhitespace($("body").text());
  return extractYearsFromText(pageText);
}

// aam, karrierhungaria, cvcentrum, dreamjobs, melonjobs: full body text
export function extractBodyExperience(html) {
  const $ = cheerioLoad(html);
  // Insert spaces between block elements so adjacent <li>/<p>/<div> texts
  // don't get concatenated (e.g. "végzettség3 év" → no \b before digit).
  $("li, p, div, br, h1, h2, h3, h4, h5, h6, td, th, tr").each((_, el) => {
    $(el).prepend(" ").append(" ");
  });
  const pageText = normalizeWhitespace($("body").text());
  return extractYearsFromText(pageText);
}

// bluebird.hu: Thrive builderes oldal — a hirdetés szövege a
// section.tcb-post-content-ben van; a body-fallback azért biztonságos, mert a
// céges boilerplate ("több mint 20 éves tapasztalattal") a 15 éves
// plauzibilitási plafonon fennakad.
export function extractBluebirdExperience(html) {
  const $ = cheerioLoad(html);
  $("li, p, div, br, h1, h2, h3, h4, h5, h6, td, th, tr").each((_, el) => {
    $(el).prepend(" ").append(" ");
  });
  const scoped = normalizeWhitespace($("section.tcb-post-content").text());
  if (scoped) {
    const fromScoped = extractYearsFromText(scoped);
    if (fromScoped) return fromScoped;
  }
  return extractYearsFromText(normalizeWhitespace($("body").text()));
}

// talent.com: current markup renders the posting into a
// [class*="jobDescriptionColumn"] container (CSS-modules hash suffix, hence
// the substring match). Neither __NEXT_DATA__ nor JSON-LD are emitted anymore,
// so without this the code fell through to a full-body scan — which also
// picks up the "Hasonló munkák" (similar jobs) sidebar and its embedded JSON,
// polluting results with unrelated postings' years/keywords.
export function extractTalentExperience(html) {
  const $ = cheerioLoad(html);

  // 0. Scoped job-description container (current talent.com markup)
  const scoped = normalizeWhitespace($('[class*="jobDescriptionColumn"]').first().text());
  if (scoped) {
    const fromScoped = extractYearsFromText(scoped);
    if (fromScoped) return fromScoped;
  }

  // 1. Try __NEXT_DATA__ (legacy Next.js SSR blob)
  const nextDataMatch = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      // talent.com puts job description in props.pageProps.job.description or similar
      const jobStr = JSON.stringify(data?.props?.pageProps ?? data);
      const result = extractYearsFromText(jobStr);
      if (result) return result;
    } catch {
      // ignore JSON parse errors
    }
  }

  // 2. Try JSON-LD structured data (legacy)
  const jsonLdMatches = html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of jsonLdMatches) {
    try {
      const obj = JSON.parse(m[1]);
      const text = JSON.stringify(obj);
      const result = extractYearsFromText(text);
      if (result) return result;
    } catch {
      // ignore
    }
  }

  // 3. Last-resort fallback: full body text (may include unrelated sidebar content)
  return extractYearsFromText(normalizeWhitespace($("body").text()));
}

// kuka: "What you need to succeed" section
export function extractKukaExperience(html) {
  const idx = html.indexOf("What you need to succeed");
  if (idx === -1) return extractBodyExperience(html);
  const section = html.substring(idx, idx + 3000);
  const $ = cheerioLoad(section);
  return extractYearsFromText($.text());
}

/* ======================
   Technology keyword extraction — shared core
   Runs on the SAME html a source already fetched for experience, no extra
   fetch. Curated for junior/entry-level programming job ads: languages,
   web/backend frameworks, databases, cloud/devops, tools, data/AI, mobile.
   Very short/ambiguous tokens that collide with ordinary English/Hungarian
   words (bare "r", bare "go") are intentionally left out to keep false
   positives low.
====================== */
export const TECH_KEYWORDS = [
  // languages
  ["javascript", "JavaScript"], ["typescript", "TypeScript"], ["python", "Python"],
  ["java", "Java"], ["c++", "C++"], ["c#", "C#"], ["golang", "Go"], ["kotlin", "Kotlin"],
  ["swift", "Swift"], ["php", "PHP"], ["ruby", "Ruby"], ["scala", "Scala"], ["rust", "Rust"],
  ["matlab", "MATLAB"], ["perl", "Perl"], ["sql", "SQL"], ["pl/sql", "PL/SQL"], ["bash", "Bash"],
  ["objective-c", "Objective-C"], ["dart", "Dart"], ["elixir", "Elixir"], ["haskell", "Haskell"],
  ["vba", "VBA"], ["abap", "ABAP"], ["cobol", "COBOL"], ["groovy", "Groovy"],

  // web / frontend
  ["html", "HTML"], ["css", "CSS"], ["sass", "Sass"], ["scss", "SCSS"], ["react", "React"],
  ["react native", "React Native"], ["angular", "Angular"], ["vue", "Vue"], ["svelte", "Svelte"],
  ["next.js", "Next.js"], ["nuxt", "Nuxt"], ["jquery", "jQuery"], ["webpack", "Webpack"],
  ["vite", "Vite"], ["tailwind", "Tailwind"], ["bootstrap", "Bootstrap"],

  // backend / frameworks
  ["node.js", "Node.js"], ["nodejs", "Node.js"], ["express", "Express"], ["nestjs", "NestJS"],
  [".net", ".NET"], [".net framework", ".NET Framework"], ["asp.net", "ASP.NET"],
  ["spring boot", "Spring Boot"], ["spring", "Spring"],
  ["django", "Django"], ["flask", "Flask"], ["fastapi", "FastAPI"], ["laravel", "Laravel"],
  ["symfony", "Symfony"], ["rails", "Ruby on Rails"], ["hibernate", "Hibernate"],
  ["entity framework", "Entity Framework"], ["wpf", "WPF"], ["j2ee", "Java EE"],
  ["java ee", "Java EE"], ["jee", "Java EE"], ["java se", "Java SE"], ["jpa", "JPA"],
  ["quarkus", "Quarkus"], ["graphql", "GraphQL"], ["grpc", "gRPC"], ["linq", "LINQ"],
  ["razor", "Razor"], ["blazor", "Blazor"], ["maui", "MAUI"], ["akka", "Akka"],
  ["redux", "Redux"], ["angularjs", "AngularJS"], ["xamarin", "Xamarin"], ["swiftui", "SwiftUI"],
  ["firebase", "Firebase"], ["supabase", "Supabase"], ["liquibase", "Liquibase"],
  ["cakephp", "CakePHP"], ["yii", "Yii"], ["weblogic", "WebLogic"], ["glassfish", "GlassFish"],
  ["wildfly", "WildFly"], ["delphi", "Delphi"], ["liferay", "Liferay"], ["joomla", "Joomla"],
  ["drupal", "Drupal"], ["wordpress", "WordPress"], ["woocommerce", "WooCommerce"], ["wcf", "WCF"],
  ["webassembly", "WebAssembly"],

  // data / databases
  ["postgresql", "PostgreSQL"], ["postgres", "PostgreSQL"], ["mysql", "MySQL"],
  ["mssql", "MSSQL"], ["sql server", "SQL Server"], ["oracle", "Oracle"], ["mongodb", "MongoDB"],
  ["power bi", "Power BI"], ["powerbi", "Power BI"], ["redis", "Redis"],
  ["elasticsearch", "Elasticsearch"], ["opensearch", "OpenSearch"], ["kibana", "Kibana"],
  ["elk", "ELK Stack"], ["sqlite", "SQLite"], ["mariadb", "MariaDB"], ["nosql", "NoSQL"],
  ["spark", "Apache Spark"], ["t-sql", "T-SQL"], ["delta lake", "Delta Lake"],
  ["databricks", "Databricks"], ["snowflake", "Snowflake"], ["dataiku", "Dataiku"],
  ["pandas", "Pandas"], ["numpy", "NumPy"], ["tableau", "Tableau"],
  ["dynamics 365", "Dynamics 365"], ["d365", "Dynamics 365"], ["dynamodb", "DynamoDB"],
  ["redshift", "Redshift"], ["kdb", "kdb+/q"], ["db2", "DB2"],

  // cloud / devops
  ["aws", "AWS"], ["azure", "Azure"], ["gcp", "GCP"], ["google cloud", "GCP"],
  ["docker", "Docker"], ["kubernetes", "Kubernetes"], ["openshift", "OpenShift"], ["helm", "Helm"],
  ["github actions", "GitHub Actions"], ["github", "GitHub"], ["ci/cd", "CI/CD"], ["linux", "Linux"],
  ["unix", "UNIX"], ["jenkins", "Jenkins"], ["gitlab", "GitLab"], ["ansible", "Ansible"],
  ["puppet", "Puppet"], ["terraform", "Terraform"],
  ["prometheus", "Prometheus"], ["grafana", "Grafana"], ["datadog", "Datadog"],
  ["pagerduty", "PagerDuty"], ["nagios", "Nagios"],
  ["rabbitmq", "RabbitMQ"], ["kafka", "Kafka"], ["activemq", "ActiveMQ"],
  ["azure devops", "Azure DevOps"], ["argocd", "ArgoCD"], ["vmware", "VMware"], ["kvm", "KVM"],
  ["proxmox", "Proxmox"], ["openstack", "OpenStack"], ["tanzu", "Tanzu"], ["xen", "Xen"],
  ["aks", "AKS"], ["eks", "EKS"], ["lambda", "Lambda"], ["cloudformation", "CloudFormation"],
  ["cloudwatch", "CloudWatch"], ["azure synapse", "Azure Synapse"],
  ["azure data factory", "Azure Data Factory"], ["azure monitor", "Azure Monitor"],
  ["azure bicep", "Bicep"], ["bicep", "Bicep"], ["microsoft graph", "Microsoft Graph"],
  ["entra id", "Entra ID"], ["sccm", "SCCM"], ["microsoft intune", "Microsoft Intune"],
  ["dbt", "dbt"], ["redmine", "Redmine"],

  // tools / practices
  ["git", "Git"],
  ["rest api", "REST API"], ["rest apis", "REST API"],
  ["selenium", "Selenium"], ["maven", "Maven"], ["gradle", "Gradle"],
  ["json", "JSON"], ["xml", "XML"], ["uml", "UML"], ["bpmn", "BPMN"], ["solid", "SOLID"],
  ["infrastructure as code", "Infrastructure as Code"], ["swagger", "Swagger"],
  ["openapi", "OpenAPI"], ["scrum", "Scrum"], ["kanban", "Kanban"], ["itil", "ITIL"],
  ["itsm", "ITSM"], ["cmdb", "CMDB"], ["etl", "ETL"], ["elt", "ELT"],

  // testing
  ["cypress", "Cypress"], ["playwright", "Playwright"], ["jmeter", "JMeter"],
  ["soapui", "SoapUI"], ["testng", "TestNG"], ["junit", "JUnit"], ["jest", "Jest"],
  ["mocha", "Mocha"], ["mockito", "Mockito"], ["ranorex", "Ranorex"], ["sonarqube", "SonarQube"],
  ["appium", "Appium"], ["bugzilla", "Bugzilla"], ["katalon", "Katalon"], ["tosca", "Tosca"],
  ["loadrunner", "LoadRunner"], ["robot framework", "Robot Framework"],
  ["rest-assured", "REST Assured"], ["restassured", "REST Assured"], ["testrail", "TestRail"],
  ["zephyr", "Zephyr"], ["rxjava", "RxJava"], ["insomnia", "Insomnia"], ["tdd", "TDD"],
  ["uat", "UAT"], ["acceptance testing", "UAT"],
  ["test automation", "Test Automation"], ["automated testing", "Test Automation"],
  ["manual testing", "Manual Testing"], ["unit testing", "Unit Testing"],
  ["integration testing", "Integration Testing"], ["regression testing", "Regression Testing"],
  ["functional testing", "Functional Testing"], ["performance testing", "Performance Testing"],
  ["load testing", "Load Testing"], ["stress testing", "Stress Testing"],
  ["smoke testing", "Smoke Testing"], ["exploratory testing", "Exploratory Testing"],
  ["api testing", "API Testing"], ["cross-browser testing", "Cross-browser Testing"],
  ["mobile testing", "Mobile Testing"], ["usability testing", "Usability Testing"],


  // collaboration / project tools
  ["jira", "Jira"], ["confluence", "Confluence"], ["postman", "Postman"],
  ["atlassian", "Atlassian"], ["excel", "Excel"], ["powerpoint", "PowerPoint"],
  ["visio", "Visio"], ["visual studio", "Visual Studio"], ["intellij", "IntelliJ"],
  ["android studio", "Android Studio"],

  // systems / infra / security
  ["powershell", "PowerShell"], ["vbscript", "VBScript"],
  ["windows server", "Windows Server"], ["windows", "Windows"],
  ["active directory", "Active Directory"], ["ldap", "LDAP"], ["kerberos", "Kerberos"],
  ["openssh", "OpenSSH"], ["cisco", "Cisco"], ["nginx", "NGINX"], ["zabbix", "Zabbix"],
  ["jwt", "JWT"], ["siem", "SIEM"], ["aspice", "ASPICE"], ["microsoft 365", "Microsoft 365"],
  ["m365", "Microsoft 365"], ["office 365", "Microsoft 365"],
  ["microsoft office", "Microsoft Office"], ["ms office", "Microsoft Office"],
  ["group policy", "Group Policy"], ["microsoft exchange", "Microsoft Exchange"],
  ["hashicorp vault", "HashiCorp Vault"], ["keycloak", "Keycloak"], ["cyberark", "CyberArk"],
  ["big-ip", "F5 BIG-IP"], ["fortinet", "Fortinet"], ["palo alto", "Palo Alto Networks"],
  ["meraki", "Cisco Meraki"], ["wireshark", "Wireshark"], ["openssl", "OpenSSL"],
  ["vpn", "VPN"], ["dns", "DNS"], ["dhcp", "DHCP"], ["tcp/ip", "TCP/IP"], ["vlan", "VLAN"],
  ["acl", "ACL"], ["websocket", "WebSockets"], ["websockets", "WebSockets"],
  ["mqtt", "MQTT"], ["lamp", "LAMP"], ["lemp", "LEMP"], ["iptables", "iptables"],
  ["fail2ban", "fail2ban"], ["cpanel", "cPanel"], ["graylog", "Graylog"], ["ajax", "Ajax"],
  ["rpa", "RPA"], ["uipath", "UiPath"], ["sharepoint", "SharePoint"],
  ["scada", "SCADA"], ["modbus", "Modbus"], ["erp", "ERP"], ["mes", "MES"], ["voip", "VoIP"],
  ["mdm", "MDM"],

  // data / AI
  ["machine learning", "Machine Learning"], ["deep learning", "Deep Learning"],
  ["nlp", "NLP"], ["llm", "LLM"], ["llms", "LLM"], ["pytorch", "PyTorch"],
  ["tensorflow", "TensorFlow"], ["xgboost", "XGBoost"], ["langchain", "LangChain"],
  ["prompt engineering", "Prompt Engineering"], ["ai agents", "AI Agents"],
  ["rag", "RAG"], ["mcp", "MCP"],

  // mobile
  ["android", "Android"], ["ios", "iOS"], ["flutter", "Flutter"], ["ionic", "Ionic"],
  ["cocoapods", "CocoaPods"], ["rxswift", "RxSwift"], ["uikit", "UIKit"], ["xctest", "XCTest"],
  ["mvvm", "MVVM"],
];

function techBoundaryRegex(keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Right boundary also accepts a directly-following digit — a version-number
  // suffix (HTML5, CSS3, C++11, C++20, PHP7, Vue3) otherwise fails to match
  // since a digit counts as "still part of the word" under [^a-z0-9] alone.
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$|\\d)`, "i");
}

// Extracts a comma-joined list of recognized technology keywords from an
// already-fetched job detail page — piggybacks on whatever html a source
// fetched for extractBodyExperience/etc, no extra network call.
//
// Scanning the whole page body is unsafe on sites that render unrelated job
// cards on the same page (LinkedIn's "people also viewed", talent.com's
// related-search widgets, Next.js RSC payloads embedded in <script> tags):
// their titles/descriptions false-positive match tech keywords that were
// never in *this* posting. So prefer a scoped description container/blob
// when the markup gives us one, and only fall back to the full body text.
export function extractTechnologies(html) {
  const $ = cheerioLoad(html);
  $("script, style, noscript").remove();
  $("li, p, div, br, h1, h2, h3, h4, h5, h6, td, th, tr").each((_, el) => {
    $(el).prepend(" ").append(" ");
  });

  // LinkedIn: same container used by extractLinkedInExperience.
  // talent.com (current markup): [class*="jobDescriptionColumn"] (CSS-modules
  // hash suffix, hence substring match) — neither JSON-LD nor __NEXT_DATA__
  // below are emitted by the site anymore, they're kept as legacy fallbacks.
  let text = normalizeWhitespace(
    $('.description, .job-description, #job-details, .show-more-less-html__markup, [class*="jobDescriptionColumn"]').first().text()
  );

  if (!text) {
    // zyntern (Vue SPA): the visible body is only navbar/footer — the posting
    // lives in the <job-profile :data="..."> attribute as entity-escaped JSON
    // whose description/requirements/offer fields hold the ad's HTML. Without
    // this the whole source silently extracted nothing (12/12 aktív hirdetés
    // '' markerrel, 2026-07-08).
    const jobProfileData = $("job-profile").attr(":data");
    if (jobProfileData) {
      try {
        const obj = JSON.parse(jobProfileData);
        const parts = [];
        for (const key of ["description", "requirements", "offer"]) {
          if (typeof obj?.[key] === "string" && obj[key]) parts.push(obj[key]);
        }
        if (Array.isArray(obj?.skills)) {
          for (const s of obj.skills) {
            if (typeof s === "string") parts.push(s);
            else if (typeof s?.name === "string") parts.push(s.name);
          }
        }
        if (parts.length) {
          const $desc = cheerioLoad(parts.join(" "));
          $desc("li, p, div, br, h1, h2, h3, h4, h5, h6, td, th, tr").each((_, el) => {
            $desc(el).prepend(" ").append(" ");
          });
          text = normalizeWhitespace($desc.text());
        }
      } catch {
        // ignore malformed :data JSON
      }
    }
  }

  if (!text) {
    // talent.com (Next.js): description lives in JSON-LD JobPosting.description,
    // not in the visible body — everything else on the page (related listings,
    // RSC data chunks) is noise for this posting.
    for (const m of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const obj = JSON.parse(m[1]);
        const graph = Array.isArray(obj["@graph"]) ? obj["@graph"] : [obj];
        const posting = graph.find(n => n && n["@type"] === "JobPosting");
        if (posting?.description) {
          const $desc = cheerioLoad(posting.description);
          $desc("li, p, div, br, h1, h2, h3, h4, h5, h6, td, th, tr").each((_, el) => {
            $desc(el).prepend(" ").append(" ");
          });
          text = normalizeWhitespace($desc.text());
          break;
        }
      } catch {
        // ignore malformed JSON-LD
      }
    }
  }

  if (!text) {
    // Legacy talent.com (pages router) fallback, scoped to the job object
    // rather than the whole pageProps blob (which also carries related jobs).
    const nextDataMatch = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (nextDataMatch) {
      try {
        const data = JSON.parse(nextDataMatch[1]);
        const job = data?.props?.pageProps?.job;
        if (job) text = JSON.stringify(job);
      } catch {
        // ignore malformed JSON
      }
    }
  }

  const matchKeywords = (t) => {
    const found = new Set();
    for (const [key, label] of TECH_KEYWORDS) {
      if (techBoundaryRegex(key).test(t)) found.add(label);
    }
    return found;
  };

  let found = text ? matchKeywords(text) : new Set();

  // Scoped selectors are a substring/generic-id match (e.g. #job-details),
  // so they can lock onto an unrelated element (profession.hu's hidden
  // "Állás részletei" heading uses that exact id) and yield real-but-wrong
  // text. A SHORT scoped text (a heading/label, not a real description) is
  // the actual signal something other than the description got matched —
  // fall back to the full body in that case rather than reporting no
  // technologies at all.
  //
  // Zero keyword hits alone is NOT that signal: a long, genuinely-scoped
  // description can legitimately mention none of TECH_KEYWORDS (e.g. a
  // non-software/architecture role) — falling back to the full body then
  // picks up unrelated sidebar content instead (talent.com's "Hasonló
  // munkák" related-jobs widget, confirmed live 2026-07-29: a Kyndryl
  // "Mainframe Application Architecture" posting with a real ~5000-char
  // description mentioning no tracked tech got stamped with Java/Angular/
  // Spring Boot/Django/Next.js — all pulled from OTHER postings' titles
  // listed elsewhere on the same page). MIN_TRUSTED_LENGTH is chosen well
  // above "Állás részletei" (~16 chars) and well below any real posting.
  const MIN_TRUSTED_LENGTH = 200;
  if (!found.size && text.length < MIN_TRUSTED_LENGTH) {
    const bodyText = normalizeWhitespace($("body").text());
    if (bodyText !== text) found = matchKeywords(bodyText);
  }

  return found.size ? [...found].join(", ") : null;
}

// Ensure the column exists at most once per warm container (mirrors
// _active_core.mjs's ensureActiveSchema for the `active` column).
let _techSchemaReady = false;
export async function ensureTechnologiesColumn(client) {
  if (_techSchemaReady) return;
  await client.query(`ALTER TABLE job_posts ADD COLUMN IF NOT EXISTS technologies text`);
  _techSchemaReady = true;
}

/* ======================
   Generic enrichment
====================== */
/**
 * Enrich job_posts.experience by fetching each job URL and applying an extractor.
 *
 * @param {object} opts
 * @param {string} opts.sourceFilter  - SQL fragment, e.g. "source = 'kuka'"
 * @param {(html:string) => string|null} opts.extract
 * @param {string} [opts.label]       - log label
 * @param {string} [opts.jobName]     - cron job name (for error logging)
 * @param {number} [opts.intervalMinutes=30]
 * @param {number} [opts.limit=300]
 * @param {string[]} [opts.extraInternKeywords]
 * @param {string} [opts.experienceCondition] - default "(experience IS NULL OR experience = '-')"
 * @param {number} [opts.sleepMs=250]
 */
export async function enrichExperience({
  sourceFilter,
  extract,
  label,
  jobName,
  intervalMinutes = 30,
  limit = 300,
  extraInternKeywords,
  experienceCondition = "(experience IS NULL OR experience = '-')",
  sleepMs = 250,
}) {
  const tag = label || sourceFilter;
  const job = jobName || "experience-enrich";
  const client = await pool.connect();

  try {
    await ensureTechnologiesColumn(client);

    const { rows } = await client.query(
      `SELECT id, url, title
         FROM job_posts
        WHERE first_seen >= NOW() - INTERVAL '${intervalMinutes} minutes'
          AND ${experienceCondition}
          AND ${sourceFilter}
        ORDER BY first_seen DESC
        LIMIT ${limit}`
    );

    console.log(`[experience:${tag}] ${rows.length} rows to enrich`);

    let success = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const html = await fetchText(row.url);
        let experience = extract(html);
        const technologies = extractTechnologies(html);

        // Title always overrides (highest priority)
        if (
          isInternshipTitle(row.title) ||
          extraInternKeywords?.some(k => normalizeText(row.title).includes(k))
        ) {
          experience = "diákmunka";
        } else if (isJuniorTitle(row.title)) {
          experience = "junior";
        } else if (isMidLevelTitle(row.title)) {
          experience = "medior";
        }

        // Tech precedence: fresh extract > existing value > '' marker (the
        // marker says "body checked, no keyword" so the cross-source
        // technologies backfill never re-fetches this row).
        await client.query(
          `UPDATE job_posts SET experience = $1, technologies = COALESCE($3, technologies, '') WHERE id = $2`,
          [experience || "-", row.id, technologies]
        );

        success++;
        await sleep(sleepMs);
      } catch (err) {
        await logFetchError(job, {
          url: row.url,
          message: err.message,
          extra: { source: tag, jobId: row.id },
        });
        console.error(`[experience:${tag}] FAILED ID:`, row.id, "|", err.message);

        const fallback = (
          isInternshipTitle(row.title) || extraInternKeywords?.some(k => normalizeText(row.title).includes(k))
        ) ? "diákmunka"
          : isJuniorTitle(row.title) ? "junior"
          : isMidLevelTitle(row.title) ? "medior"
          : "-";

        await client.query(
          `UPDATE job_posts SET experience = $1 WHERE id = $2`,
          [fallback, row.id]
        );

        failed++;
      }
    }

    console.log(`[experience:${tag}] done — success: ${success}, failed: ${failed}`);
    return { success, failed, total: rows.length };
  } finally {
    client.release();
  }
}

