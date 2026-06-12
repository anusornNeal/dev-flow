# DevFlow Development Workflow

## Purpose

This skill defines the standard workflow rule for any AI agent working on the DevFlow project itself or when managing tasks via the DevFlow board.

## Standard Workflow Rule

When you are assigned a task card, you must strictly follow this lifecycle:

1. **Read Task Content**: Read the task card details carefully, including all checklist items, acceptance criteria, and subtasks (if any).
2. **Move to In Progress**: Before starting the actual work, update the task status and move the card to `in-progress`.
3. **Handle Subtasks**: If the task contains subtasks, spawn subagents using the `invoke_subagent` tool to help work on them concurrently. Give clear instructions to each subagent.
4. **Commit to Branch**: Perform the implementation. When finished with a logical chunk of work, commit the changes to the specific branch designated by the task card (`branch` field).
5. **Move to Ready for Review**: Once all implementation and checklist items are verified, move the task card status to `ready-for-review` and wait for human feedback.
6. **Merge and Push**: Wait for the user's approval. If the user says "ผ่าน" (Passed), merge the branch into `develop` and push the changes.
7. **Complete Task**: Finally, update the task card status to `done` (Completed).

Do not skip any steps. In particular, always pause at `ready-for-review` before merging.
