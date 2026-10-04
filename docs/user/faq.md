# FAQ

**Does Looprch change my SEV3 specification?**
No. It only ticks boxes in `phases/todo.md` after verified evidence. Any other change to the
package stops execution (`spec_changed`).

**Can the Lead do a role itself to save time?**
No. The Lead never substitutes for a role; skills tell it to delegate every role run.

**Why does Looprch need git?**
Phase branches, checkpoints and the handover file check depend on it. No remote is needed and
Looprch never pushes.

**Can two agents run the same project at once?**
One Lead at a time. A project lock serializes Looprch commands; a second Lead sees the same next
action and cannot start a second Implementer.

**What if my agent cannot list models?**
Type the model id its CLI uses. Looprch never invents model ids.

**Is a Worker's answer trusted?**
It is advisory. It never satisfies a gate or replaces a requirement.

**What does "specification verified" mean in reports?**
That the SEV3 toolkit validated the package. The application is verified only by the gate runs.

**Can I use Looprch without delegate-skills?**
Yes, if every role is Direct in the agent you run the Lead in (Codex, Cursor or OpenCode).

**Windows?**
Use WSL. Native Windows is not supported in v1.

**Where is my data?**
In your project (`.looprch/`) and in `~/.looprch/` (the installed versions, a registry of
projects and small caches). Nothing is sent anywhere by Looprch itself.
