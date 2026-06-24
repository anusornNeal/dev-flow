# Local File Editing in DevFlow

DevFlow provides several tools for agents to edit files in the local repository workspace. Choosing the right tool prevents data loss, patch failures, and payload rejections.

## 1. safe_edit_local_file (Focused Edit)

**When to use:**
- Large central files (routes, contracts, main services) where full-file overwrites are dangerous.
- Small targeted insertions or text replacements where diff patches might fail due to lack of context.
- When you only need to change a single block, import, or function and want to prevent payload bloat.

**How it works:**
You send an exact text anchor (e.g., a function signature or existing block) and the replacement or insertion content. It applies the edit atomically without reading or sending the rest of the file.

## 2. apply_patch (Unified Diff Patch)

**When to use:**
- When editing multiple blocks across the same file in a structured way.
- When your language model is confident in generating unified diff syntax.

**How it works:**
Applies a standard `.patch` payload. Has a payload size cap (usually 100KB) to prevent giant diffs from slowing down the system.

## 3. write_local_file (Full Replace)

**When to use:**
- Creating brand new files.
- Completely replacing a small file (e.g., small scripts, config files).

**How it works:**
Overwrites the file entirely. Do not use this for large files, as the payload size might exceed DevFlow's limits (typically 1MB), and sending large files repeatedly wastes tokens and context window space.
