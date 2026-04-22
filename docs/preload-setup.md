# Preload Setup Details (CC v2.1.112 and earlier)

The preload interceptor works with Node.js-based Claude Code versions (v2.1.112 and earlier). It does **not** work on CC v2.1.113+ (Bun binary) — use the [proxy](../README.md#quick-start-proxy-recommended) instead.

## Installation

Requires Node.js >= 18 and Claude Code installed via npm (not the standalone binary).

```bash
npm install -g claude-code-cache-fix
```

## Usage

The preload works as a Node.js module that intercepts API requests before they leave your machine.

### Option A: Wrapper script (recommended)

Create a wrapper script (e.g. `~/bin/claude-fixed`):

```bash
#!/bin/bash
NPM_GLOBAL_ROOT="$(npm root -g 2>/dev/null)"

CLAUDE_NPM_CLI="$NPM_GLOBAL_ROOT/@anthropic-ai/claude-code/cli.js"
CACHE_FIX="$NPM_GLOBAL_ROOT/claude-code-cache-fix/preload.mjs"

if [ ! -f "$CLAUDE_NPM_CLI" ]; then
  echo "Error: Claude Code npm package not found at $CLAUDE_NPM_CLI" >&2
  echo "Install with: npm install -g @anthropic-ai/claude-code" >&2
  exit 1
fi

if [ ! -f "$CACHE_FIX" ]; then
  echo "Error: claude-code-cache-fix not found at $CACHE_FIX" >&2
  echo "Install with: npm install -g claude-code-cache-fix" >&2
  exit 1
fi

exec env NODE_OPTIONS="--import $CACHE_FIX" node "$CLAUDE_NPM_CLI" "$@"
```

```bash
chmod +x ~/bin/claude-fixed
```

Adjust `CLAUDE_NPM_CLI` if your npm global prefix differs. Find it with:
```bash
npm root -g
```

### Option B: Shell alias

```bash
alias claude='NODE_OPTIONS="--import claude-code-cache-fix" node "$(npm root -g)/@anthropic-ai/claude-code/cli.js"'
```

### Option C: Direct invocation

```bash
NODE_OPTIONS="--import claude-code-cache-fix" claude
```

> **Note**: This only works if `claude` points to the npm/Node installation. The standalone binary uses a different execution path that bypasses Node.js preloads.

### Windows users

On Windows, `NODE_OPTIONS="--import ..."` doesn't work the same way as on Linux/macOS. Use the included `claude-fixed.bat` wrapper instead:

1. After installing both packages globally:
   ```bat
   npm install -g claude-code-cache-fix
   npm install -g @anthropic-ai/claude-code
   ```

2. Copy `claude-fixed.bat` from this package to a directory in your PATH (e.g., `C:\Users\<you>\bin\`):
   ```bat
   copy "%NPM_ROOT%\claude-code-cache-fix\claude-fixed.bat" C:\Users\%USERNAME%\bin\
   ```
   Or find the file manually at your npm global root (run `npm root -g` to locate it).

3. Run Claude Code with the interceptor active:
   ```bat
   claude-fixed [any claude args...]
   ```

The wrapper dynamically resolves your npm global root, constructs a `file:///` URL for the preload module (converting backslashes to forward slashes for Node.js), and launches Claude Code with the interceptor loaded. All environment variables (`CACHE_FIX_DEBUG`, `CACHE_FIX_IMAGE_KEEP_LAST`, etc.) work the same as on Linux/macOS.

Credit: [@TomTheMenace](https://github.com/anthropics/claude-code/issues/38335) contributed the Windows wrapper and validated the interceptor across a 7.5-hour, 536-call Opus 4.6 session on Windows — 98.4% cache hit rate, 81% of calls had fingerprint instability that the interceptor corrected.

## VS Code (preload mode)

If you're using the preload interceptor (not proxy mode) with VS Code, the `claude-code.environmentVariables` setting does **not** propagate `NODE_OPTIONS`, so a process wrapper is required.

**Linux / macOS** — create `~/bin/claude-vscode-wrapper`:

```bash
#!/bin/bash
NPM_ROOT="$(npm root -g 2>/dev/null)"
PRELOAD="$NPM_ROOT/claude-code-cache-fix/preload.mjs"
shift  # VS Code passes the original claude path as $1
export NODE_OPTIONS="--import $PRELOAD"
exec node "$NPM_ROOT/@anthropic-ai/claude-code/cli.js" "$@"
```

```bash
chmod +x ~/bin/claude-vscode-wrapper
```

Add to VS Code `settings.json`:

```json
{
  "claudeCode.claudeProcessWrapper": "/home/YOUR_USERNAME/bin/claude-vscode-wrapper"
}
```

**Windows** — `.bat`/`.cmd` wrappers fail because the extension uses `child_process.spawn()` without `shell: true`. Use the C wrapper source included in this package (`tools/claude-vscode-wrapper.c`):

```cmd
cl tools\claude-vscode-wrapper.c /Fe:claude-vscode-wrapper.exe
```

Then set in VS Code `settings.json`:

```json
{
  "claudeCode.claudeProcessWrapper": "C:\\path\\to\\claude-vscode-wrapper.exe"
}
```

Credit: [@JEONG-JIWOO](https://github.com/JEONG-JIWOO) and [@X-15](https://github.com/X-15) for the VS Code extension investigation and C wrapper ([#16](https://github.com/cnighswonger/claude-code-cache-fix/issues/16)).
