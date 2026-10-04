# Quickstart

From a SEV3 package to the first closed phase.

```sh
# 1. Install Looprch once
npx looprch@latest install

# 2. Put the SEV3 package at the root of your project (phases/ and requirements/)
cd my-project

# 3. Attach the agents you use (interactive picker, or --agents for scripts)
looprch add .
looprch add . --agents cursor,codex,opencode --yes

# 4. Make sure git has an identity (Looprch never invents one)
git config --global user.name "Your Name"
git config --global user.email you@example.com
```

Then open the project in your agent and run the init skill (`/lr-init`; in Codex `$lr-init`;
in Kimi Code `/skill:lr-init`). It checks readiness, verifies the SEV3 package, asks you to
acknowledge the gate commands and configures every role (agent, Direct or Delegate, model).

```text
/lr-doctor     # anything missing?
/lr-phase      # run the first phase and stop
/lr-status     # where are we?
/lr-auto       # run the remaining phases until the closure phase
/lr-finish     # closure phase + final report
```

The first phase asks once to commit your current files as `looprch: baseline`. Every phase then
runs on its own branch `looprch/P-NNN` and is merged and tagged when it closes.

From a terminal you can always see the state with `looprch status` and `looprch log`.
