import subprocess

# Constructs command from user input — should trigger dynamic shell exec finding
user_input = "hello"
cmd = f"echo {user_input}"
subprocess.run(cmd, shell=True)
