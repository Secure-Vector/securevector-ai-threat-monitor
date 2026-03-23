"""
Default permissions and policies for the Skill Scanner Policy Engine.

These are seeded into the database on first run (V19 migration).
Users can toggle, add, or remove entries via the UI.
"""

# ---------------------------------------------------------------------------
# Default Permissions — organized by category
# Each entry: (pattern, classification, label)
#   classification: "safe" (auto-allow), "review" (warn), "dangerous" (block)
# ---------------------------------------------------------------------------

NETWORK_PERMISSIONS = [
    # --- SAFE: LLM Providers ---
    ("*.openai.com", "safe", "OpenAI API"),
    ("*.anthropic.com", "safe", "Anthropic / Claude API"),
    ("*.googleapis.com", "safe", "Google AI / Vertex AI"),
    ("*.mistral.ai", "safe", "Mistral API"),
    ("*.cohere.ai", "safe", "Cohere API"),
    ("*.cohere.com", "safe", "Cohere API"),
    ("*.huggingface.co", "safe", "HuggingFace"),
    ("*.groq.com", "safe", "Groq API"),
    ("*.together.ai", "safe", "Together AI"),
    ("*.fireworks.ai", "safe", "Fireworks AI"),
    ("*.perplexity.ai", "safe", "Perplexity API"),
    ("*.replicate.com", "safe", "Replicate"),
    ("*.deepinfra.com", "safe", "DeepInfra"),
    ("*.ai21.com", "safe", "AI21 Labs"),
    ("*.deepseek.com", "safe", "DeepSeek API"),
    ("*.sambanova.ai", "safe", "SambaNova"),
    # --- SAFE: Search APIs ---
    ("*.bing.com", "safe", "Bing Search"),
    ("*.bingapis.com", "safe", "Bing Search API"),
    ("*.brave.com", "safe", "Brave Search"),
    ("serpapi.com", "safe", "SerpAPI"),
    ("*.tavily.com", "safe", "Tavily Search"),
    ("*.wolframalpha.com", "safe", "Wolfram Alpha"),
    ("*.wikipedia.org", "safe", "Wikipedia"),
    ("*.duckduckgo.com", "safe", "DuckDuckGo"),
    # --- SAFE: Code Platforms ---
    ("*.github.com", "safe", "GitHub"),
    ("*.githubusercontent.com", "safe", "GitHub Raw Content"),
    ("*.gitlab.com", "safe", "GitLab"),
    ("*.npmjs.org", "safe", "npm Registry"),
    ("*.pypi.org", "safe", "PyPI"),
    # --- SAFE: Databases & BaaS ---
    ("*.supabase.co", "safe", "Supabase"),
    ("*.firebaseio.com", "safe", "Firebase"),
    ("*.mongodb.net", "safe", "MongoDB Atlas"),
    ("*.neon.tech", "safe", "Neon Postgres"),
    ("*.upstash.io", "safe", "Upstash"),
    ("*.turso.io", "safe", "Turso"),
    # --- SAFE: Messaging ---
    ("*.slack.com", "safe", "Slack API"),
    ("*.discord.com", "safe", "Discord API"),
    ("api.telegram.org", "safe", "Telegram Bot API"),
    ("*.sendgrid.net", "safe", "SendGrid"),
    ("*.twilio.com", "safe", "Twilio"),
    ("*.resend.com", "safe", "Resend"),
    # --- SAFE: Storage ---
    ("*.s3.amazonaws.com", "safe", "AWS S3"),
    ("*.storage.googleapis.com", "safe", "Google Cloud Storage"),
    ("*.blob.core.windows.net", "safe", "Azure Blob"),
    # --- SAFE: Vector DBs ---
    ("*.pinecone.io", "safe", "Pinecone"),
    ("*.weaviate.io", "safe", "Weaviate"),
    ("*.qdrant.io", "safe", "Qdrant"),
    ("*.chroma.ai", "safe", "Chroma"),
    # --- SAFE: Observability ---
    ("*.sentry.io", "safe", "Sentry"),
    ("*.datadoghq.com", "safe", "Datadog"),
    ("*.langsmith.com", "safe", "LangSmith"),
    ("*.helicone.ai", "safe", "Helicone"),
    # --- REVIEW ---
    ("*.ngrok.io", "review", "ngrok tunnel"),
    ("*.replit.com", "review", "Replit sandbox"),
    ("*.webhook.site", "review", "Webhook testing"),
    ("*.pipedream.com", "review", "Pipedream"),
    ("*.airtable.com", "review", "Airtable"),
    ("*.notion.so", "review", "Notion API"),
    ("*.zapier.com", "review", "Zapier automation"),
    ("*.fly.io", "review", "Fly.io deployment"),
    ("*.railway.app", "review", "Railway deployment"),
    ("*.vercel.app", "review", "Vercel deployment"),
    ("*.herokuapp.com", "review", "Heroku apps"),
    # --- DANGEROUS ---
    ("*.burpcollaborator.net", "dangerous", "Burp Suite exfil"),
    ("*.interact.sh", "dangerous", "OOB exfiltration"),
    ("*.interactsh.com", "dangerous", "OOB exfiltration"),
    ("*.oastify.com", "dangerous", "OAST exfiltration"),
    ("*.dnslog.cn", "dangerous", "DNS exfiltration"),
    ("*.ceye.io", "dangerous", "DNS exfiltration"),
    ("*.transfer.sh", "dangerous", "Anonymous file share"),
    ("*.file.io", "dangerous", "Ephemeral file share"),
    ("*.0x0.st", "dangerous", "Anonymous file host"),
    ("*.serveo.net", "dangerous", "Ephemeral tunnel"),
    ("169.254.169.254", "dangerous", "Cloud metadata SSRF"),
    ("metadata.google.internal", "dangerous", "GCP metadata SSRF"),
]

ENV_VAR_PERMISSIONS = [
    # --- SAFE: LLM API Keys ---
    ("OPENAI_API_KEY", "safe", "OpenAI API key"),
    ("ANTHROPIC_API_KEY", "safe", "Anthropic API key"),
    ("GOOGLE_API_KEY", "safe", "Google API key"),
    ("MISTRAL_API_KEY", "safe", "Mistral API key"),
    ("COHERE_API_KEY", "safe", "Cohere API key"),
    ("HUGGINGFACE_TOKEN", "safe", "HuggingFace token"),
    ("HF_TOKEN", "safe", "HuggingFace token"),
    ("GROQ_API_KEY", "safe", "Groq API key"),
    ("TOGETHER_API_KEY", "safe", "Together AI key"),
    ("FIREWORKS_API_KEY", "safe", "Fireworks AI key"),
    ("REPLICATE_API_TOKEN", "safe", "Replicate token"),
    ("PERPLEXITY_API_KEY", "safe", "Perplexity key"),
    ("DEEPSEEK_API_KEY", "safe", "DeepSeek key"),
    # --- SAFE: Search Keys ---
    ("SERPAPI_API_KEY", "safe", "SerpAPI key"),
    ("TAVILY_API_KEY", "safe", "Tavily key"),
    ("BRAVE_SEARCH_API_KEY", "safe", "Brave Search key"),
    ("BING_API_KEY", "safe", "Bing API key"),
    # --- SAFE: Database ---
    ("DATABASE_URL", "safe", "Database connection"),
    ("SUPABASE_URL", "safe", "Supabase URL"),
    ("SUPABASE_KEY", "safe", "Supabase key"),
    ("MONGODB_URI", "safe", "MongoDB URI"),
    ("REDIS_URL", "safe", "Redis URL"),
    ("PINECONE_API_KEY", "safe", "Pinecone key"),
    # --- SAFE: Messaging ---
    ("SLACK_BOT_TOKEN", "safe", "Slack bot token"),
    ("DISCORD_BOT_TOKEN", "safe", "Discord bot token"),
    ("TELEGRAM_BOT_TOKEN", "safe", "Telegram bot token"),
    ("SENDGRID_API_KEY", "safe", "SendGrid key"),
    ("TWILIO_ACCOUNT_SID", "safe", "Twilio SID"),
    ("RESEND_API_KEY", "safe", "Resend key"),
    # --- SAFE: Config ---
    ("NODE_ENV", "safe", "Node environment"),
    ("DEBUG", "safe", "Debug flag"),
    ("LOG_LEVEL", "safe", "Log level"),
    ("PORT", "safe", "Port number"),
    ("HOST", "safe", "Host address"),
    ("SENTRY_DSN", "safe", "Sentry DSN"),
    ("LANGCHAIN_API_KEY", "safe", "LangChain key"),
    ("LANGSMITH_API_KEY", "safe", "LangSmith key"),
    # --- REVIEW: Cloud/Infra ---
    ("AWS_ACCESS_KEY_ID", "review", "AWS access key"),
    ("AWS_SECRET_ACCESS_KEY", "review", "AWS secret key"),
    ("AWS_SESSION_TOKEN", "review", "AWS session token"),
    ("GITHUB_TOKEN", "review", "GitHub token"),
    ("GH_TOKEN", "review", "GitHub token"),
    ("GITLAB_TOKEN", "review", "GitLab token"),
    ("STRIPE_SECRET_KEY", "review", "Stripe secret key"),
    ("JWT_SECRET", "review", "JWT signing secret"),
    ("SECRET_KEY", "review", "Application secret"),
    ("ENCRYPTION_KEY", "review", "Encryption key"),
    ("SMTP_PASSWORD", "review", "SMTP password"),
    ("AZURE_CLIENT_SECRET", "review", "Azure client secret"),
    ("NPM_TOKEN", "review", "npm publish token"),
    # --- DANGEROUS ---
    ("SSH_PRIVATE_KEY", "dangerous", "SSH private key"),
    ("SSH_KEY", "dangerous", "SSH key"),
    ("GPG_PRIVATE_KEY", "dangerous", "GPG private key"),
    ("SUDO_PASSWORD", "dangerous", "Sudo password"),
    ("ROOT_PASSWORD", "dangerous", "Root password"),
    ("PRIVATE_KEY", "dangerous", "Private key"),
    ("MASTER_KEY", "dangerous", "Master key"),
    ("MASTER_SECRET", "dangerous", "Master secret"),
    ("VAULT_TOKEN", "dangerous", "HashiCorp Vault token"),
    ("KUBE_TOKEN", "dangerous", "Kubernetes token"),
    ("LDAP_BIND_PASSWORD", "dangerous", "LDAP password"),
    ("DATABASE_ADMIN_PASSWORD", "dangerous", "DB admin password"),
    ("MYSQL_ROOT_PASSWORD", "dangerous", "MySQL root password"),
    ("POSTGRES_PASSWORD", "dangerous", "Postgres password"),
]

FILE_PATH_PERMISSIONS = [
    # --- SAFE ---
    ("/tmp/", "safe", "System temp directory"),
    ("./output/", "safe", "Project output directory"),
    ("./outputs/", "safe", "Project outputs directory"),
    ("./results/", "safe", "Project results directory"),
    ("./build/", "safe", "Build directory"),
    ("./dist/", "safe", "Distribution directory"),
    ("./logs/", "safe", "Project logs directory"),
    ("./.cache/", "safe", "Project cache directory"),
    ("./data/", "safe", "Project data directory"),
    ("~/.cache/", "safe", "User cache directory"),
    ("~/.cache/huggingface/", "safe", "HuggingFace cache"),
    ("~/.cache/torch/", "safe", "PyTorch cache"),
    # --- REVIEW ---
    ("~/Documents/", "review", "User documents"),
    ("~/Desktop/", "review", "User desktop"),
    ("~/Downloads/", "review", "User downloads"),
    ("~/.config/", "review", "App config directory"),
    ("./.env", "review", "Environment file"),
    ("./.github/", "review", "CI/CD config"),
    ("~/.gitconfig", "review", "Git global config"),
    ("~/.aws/config", "review", "AWS config"),
    # --- DANGEROUS ---
    ("/etc/shadow", "dangerous", "System password hashes"),
    ("/etc/passwd", "dangerous", "System user database"),
    ("/etc/sudoers", "dangerous", "Sudo config"),
    ("~/.ssh/", "dangerous", "SSH credentials"),
    ("~/.gnupg/", "dangerous", "GPG keyrings"),
    ("~/.aws/credentials", "dangerous", "AWS credentials"),
    ("~/.kube/config", "dangerous", "Kubernetes credentials"),
    ("~/.docker/config.json", "dangerous", "Docker registry auth"),
    ("~/.npmrc", "dangerous", "npm auth tokens"),
    ("~/.pypirc", "dangerous", "PyPI credentials"),
    ("~/.git-credentials", "dangerous", "Git stored passwords"),
    ("/etc/hosts", "dangerous", "DNS override"),
    ("/etc/crontab", "dangerous", "Scheduled tasks"),
    ("~/.bashrc", "dangerous", "Shell startup script"),
    ("~/.zshrc", "dangerous", "Shell startup script"),
    ("~/.bash_profile", "dangerous", "Shell login script"),
    ("/etc/ld.so.preload", "dangerous", "Shared lib injection"),
]

SHELL_COMMAND_PERMISSIONS = [
    # --- SAFE ---
    ("echo", "safe", "Print text"),
    ("cat", "safe", "Read file"),
    ("ls", "safe", "List directory"),
    ("head", "safe", "Read file head"),
    ("tail", "safe", "Read file tail"),
    ("wc", "safe", "Word count"),
    ("sort", "safe", "Sort lines"),
    ("jq", "safe", "JSON processor"),
    ("date", "safe", "Show date"),
    ("whoami", "safe", "Current user"),
    ("git status", "safe", "Git status"),
    ("git log", "safe", "Git log"),
    ("git diff", "safe", "Git diff"),
    # --- REVIEW ---
    ("curl", "review", "HTTP requests"),
    ("wget", "review", "HTTP downloads"),
    ("pip install", "review", "Install Python package"),
    ("npm install", "review", "Install Node package"),
    ("git clone", "review", "Clone repository"),
    ("git push", "review", "Push to remote"),
    ("docker run", "review", "Run container"),
    ("docker exec", "review", "Execute in container"),
    ("python", "review", "Python interpreter"),
    ("node", "review", "Node.js interpreter"),
    ("ssh", "review", "Remote shell"),
    ("scp", "review", "Remote file copy"),
    # --- DANGEROUS ---
    ("rm -rf /", "dangerous", "Recursive delete root"),
    ("sudo", "dangerous", "Privilege escalation"),
    ("su", "dangerous", "Switch user"),
    ("chmod 777", "dangerous", "World-writable permissions"),
    ("chmod +s", "dangerous", "Set SUID bit"),
    ("nc", "dangerous", "Netcat (reverse shell)"),
    ("ncat", "dangerous", "Ncat (reverse shell)"),
    ("netcat", "dangerous", "Netcat (reverse shell)"),
    ("crontab", "dangerous", "Scheduled task creation"),
    ("useradd", "dangerous", "Create user account"),
    ("passwd", "dangerous", "Change password"),
    ("iptables", "dangerous", "Firewall modification"),
    ("mkfs", "dangerous", "Format filesystem"),
    ("dd", "dangerous", "Raw disk write"),
    ("nmap", "dangerous", "Network scanning"),
    ("tcpdump", "dangerous", "Packet capture"),
    ("base64 -d | sh", "dangerous", "Encoded shell execution"),
]

TRUSTED_PUBLISHERS = [
    ("openclaw", "trusted"),
    ("securevector", "trusted"),
]

# Risk score weights per finding category
RISK_SCORE_WEIGHTS = {
    "network_domain": 2,
    "env_var_read": 2,
    "shell_exec": 5,
    "code_exec": 5,
    "dynamic_import": 4,
    "file_write": 3,
    "base64_literal": 1,
    "compiled_code": 3,
    "rule_match": 3,
    "missing_manifest": 1,
    "symlink_escape": 3,
    "scan_limit": 0,
}

# Risk score thresholds
RISK_SCORE_THRESHOLDS = {
    "allow": 3,     # 0-3: allow
    "warn": 6,      # 4-6: warn
    # 7+: block
}
