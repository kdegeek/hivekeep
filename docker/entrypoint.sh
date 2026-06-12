#!/bin/sh
set -e

# Fix ownership of data directory for volume mounts created as root.
# This succeeds for named volumes and root-created mounts; it can fail silently
# for a bind-mounted host directory owned by a different UID, so we verify
# writability below rather than trusting the chown.
chown -R hivekeep:hivekeep /app/data 2>/dev/null || true

# Verify the data directory is actually writable by the runtime user (hivekeep).
# A non-writable bind mount would otherwise surface much later as an opaque
# EACCES when the server tries to open the database or write the encryption key.
if ! gosu hivekeep sh -c 'touch /app/data/.write-test 2>/dev/null && rm -f /app/data/.write-test 2>/dev/null'; then
  echo "ERROR: /app/data is not writable by the 'hivekeep' user inside the container." >&2
  echo "Hivekeep stores its database, uploads and encryption key there, so it cannot start." >&2
  echo "" >&2
  echo "This usually means a bind-mounted host directory is owned by another user." >&2
  echo "Fix it one of these ways:" >&2
  echo "  1. Use a named volume instead of a host path:" >&2
  echo "       docker run -v hivekeep-data:/app/data ... ghcr.io/marlburrow/hivekeep:latest" >&2
  echo "  2. Or give the host directory to the container user (UID/GID 1001):" >&2
  echo "       sudo chown -R 1001:1001 /path/to/your/host/data" >&2
  exit 1
fi

# Ensure HIVEKEEP_VERSION is set from package.json if not already provided
if [ -z "$HIVEKEEP_VERSION" ] && [ -f /app/package.json ]; then
  HIVEKEEP_VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' /app/package.json | head -1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
  export HIVEKEEP_VERSION
fi

# Drop to non-root user and exec the command
exec gosu hivekeep "$@"
