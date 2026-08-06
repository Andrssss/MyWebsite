// netlify/functions/_tech_keywords.js
//
// Canonical [detectionKeyword, displayLabel] pairs — the single source of
// truth for every technology extractTechnologies() (_experience_core.mjs)
// can recognize. Also consumed by jobs.js's /jobs/technologies endpoint so
// the frontend chip list can show every possible technology (even ones no
// currently-loaded job has yet), not just whatever happens to be present in
// the loaded page.
//
// CommonJS on purpose: jobs.js (CJS) requires it directly; _experience_core.mjs
// (ESM) imports the named export via Node's CJS/ESM interop.
const TECH_KEYWORDS = [
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

  // design (2026-08-06: UX/UI Design category carve-out — keeping this list
  // short and unambiguous; deliberately omits "sketch"/"miro" which collide
  // with ordinary English words/names in raw job-description text)
  ["figma", "Figma"], ["adobe xd", "Adobe XD"],

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

  // added from an audit of the AI-scraped bucket's free-text technologies
  // field against this list (2026-08-06) — recurring, unambiguous terms only;
  // see the "AI-scraped technologies cleanup" memory for the full rationale.
  ["microservices", "Microservices"], ["agile", "Agile"],
  ["devops", "DevOps"], ["data warehouse", "Data Warehouse"], ["dwh", "Data Warehouse"],
  ["istqb", "ISTQB"], ["oop", "OOP"], ["debian", "Debian"], ["rxjs", "RxJS"],
  ["centos", "CentOS"], ["gitops", "GitOps"], ["iis", "IIS"],
  ["pyspark", "Apache Spark"], ["sap", "SAP"], ["splunk", "Splunk"],
  ["ccna", "CCNA"], ["ccnp", "CCNP"], ["cissp", "CISSP"], ["oscp", "OSCP"], ["ceh", "CEH"],
  ["business intelligence", "Business Intelligence"], ["computer vision", "Computer Vision"],
  ["cuda", "CUDA"], ["cybersecurity", "Cybersecurity"], ["dagster", "Dagster"],
  ["data lake", "Data Lake"], ["data science", "Data Science"],
  ["generative ai", "Generative AI"], ["penetration testing", "Penetration Testing"],
  ["ejb", "EJB"], ["jboss", "JBoss"], ["jsf", "JSF"], ["juniper", "Juniper"],
  ["manageengine", "ManageEngine"], ["polarion", "Polarion"],
  ["rds", "Amazon RDS"], ["redhat", "RedHat"], ["rhel", "RedHat"],
  ["smarty", "Smarty"], ["spi", "SPI"], ["stl", "STL"], ["svn", "SVN"],
  ["teamcity", "TeamCity"], ["ubuntu", "Ubuntu"], ["veeam", "Veeam"],
  ["wan", "WAN"], ["xsd", "XSD"], ["asyncio", "asyncio"], ["intune", "Microsoft Intune"],
];

module.exports = { TECH_KEYWORDS };
