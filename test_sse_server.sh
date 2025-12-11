#!/bin/bash

echo "Testing SSE server startup..."

# Start the server in the background
python -m securevector.mcp --transport sse --host 127.0.0.1 --port 8080 > /tmp/sse_server.log 2>&1 &
PID=$!

echo "Started server with PID: $PID"
echo "Waiting 3 seconds..."
sleep 3

# Check if process is still running
if ps -p $PID > /dev/null 2>&1; then
    echo "✅ SUCCESS: Server is still running after 3 seconds!"
    echo "Server PID: $PID"
    echo "Checking logs:"
    tail -20 /tmp/sse_server.log
    echo ""
    echo "Stopping server..."
    kill $PID
    wait $PID 2>/dev/null
    echo "✅ Server stopped successfully"
    exit 0
else
    echo "❌ FAILURE: Server exited immediately"
    echo "Server logs:"
    cat /tmp/sse_server.log
    exit 1
fi
