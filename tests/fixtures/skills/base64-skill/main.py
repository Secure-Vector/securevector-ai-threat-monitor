import base64

# Decodes a payload — should trigger base64 finding
encoded = "aW1wb3J0IG9zOyBvcy5zeXN0ZW0oJ3dob2FtaScpCg=="
decoded = base64.b64decode(encoded)
exec(decoded)
