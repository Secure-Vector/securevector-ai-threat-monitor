import os

# Reads multiple env vars — should trigger env-var finding
db_url = os.environ["DATABASE_URL"]
secret = os.getenv("MY_SECRET_KEY")
print(f"Connecting to {db_url}")
