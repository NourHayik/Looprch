# Looprch Commands and Integration Guide

## 1. Purpose

Looprch is the project execution orchestrator. It consumes the structured project definition produced by **SEV3**, coordinates the specialized AI roles that execute it, and preserves the project's execution state.

**delegate-skills is not a Looprch phase, role, or workflow step.** It is an optional execution/delegation tool that Looprch can use when a configured role should be executed by an external coding-agent CLI.

```text
SEV3 = defines the project
Looprch = orchestrates the project
Direct / Delegate = how Looprch invokes a configured agent
delegate-skills = the tool used when Delegate mode is selected
```

For example, an Implementer remains an Implementer in both cases:

```text
Implementer
   ├── Direct   → Looprch invokes the configured agent directly
   └── Delegate → Looprch uses delegate-skills to invoke the configured external agent
```

# 2. Looprch Commands

## `/lr-init`

### Purpose

`/lr-init` initializes Looprch for a project. It connects Looprch to the project's SEV3 package and establishes the **persistent AI execution configuration** that should be reused throughout the lifetime of that project.

### Asking the user about agents/models

During initialization, Looprch should interactively ask which AI agent/model should perform each configurable role, including the primary roles:

- Planner
- Plan Debater
- Implementer
- Tester
- Reviewer

It should also establish the Worker agent configuration.

Where supported, the user may configure preferred agents and approved fallback agents.

These choices are **project configuration**. Looprch should not ask the user to select the same models again at the beginning of every phase.

### Choosing Direct or Delegate

For every configured agent, `/lr-init` should also establish how Looprch will invoke it.

There are two conceptual invocation modes:

#### Direct

Looprch invokes the configured agent through a supported direct execution path.

```text
Planner
  Agent: Codex
  Mode: Direct
```

When Planner work is required, Looprch invokes that configured Codex agent directly.

#### Delegate

Looprch invokes the configured external agent through **delegate-skills**.

```text
Implementer
  Agent: OpenCode
  Mode: Delegate
```

When Implementer work is required, Looprch prepares the Implementer task and context, then uses delegate-skills to invoke the configured OpenCode agent.

**Delegate is not a new role or lifecycle stage. It only describes how Looprch reaches the agent assigned to an existing role.**

### Example project configuration

```text
Planner
  Agent: Codex
  Mode: Direct

Plan Debater
  Agent: Kimi
  Mode: Delegate

Implementer
  Agent: OpenCode
  Mode: Delegate

Tester
  Agent: Gemini
  Mode: Direct

Reviewer
  Agent: Codex
  Mode: Direct

Worker
  Preferred agents: ...
  Invocation: Direct and/or Delegate as configured
```

### Persisting the configuration

Looprch should save these selections as part of the project configuration and reuse them across:

- all project phases;
- `/lr-phase` and `/lr-auto`;
- pause/resume cycles;
- different Lead sessions;
- application restarts;
- long-running project execution.

For example, if initialization establishes:

```text
Planner = Codex / Direct
Implementer = OpenCode / Delegate
Tester = Gemini / Direct
Reviewer = Codex / Direct
```

Looprch should continue using those assignments unless the project configuration is intentionally changed.

### Relationship with SEV3

`/lr-init` is the main connection point between the project definition and the execution configuration:

```text
SEV3 project package
        +
Role → Agent assignments
        +
Direct / Delegate choices
        ↓
     /lr-init
        ↓
Persistent Looprch project configuration
```

SEV3 remains the source of the structured project definition. Looprch manages execution. The saved role/model assignments determine which agents are used, while Direct or Delegate determines how each configured agent is invoked.

## `/lr-doctor`

### Purpose

Checks whether the Looprch execution environment is ready.

It inspects the configured environment, project metadata, required tooling, and execution setup.

### Typical use

Use it:

- after initialization;
- after changing agent/model configuration;
- after changing the execution environment;
- when Looprch cannot start or continue correctly;
- when checking whether required integrations are available.

It is primarily a readiness and diagnostics command.

---

## `/lr-status`

### Purpose

Shows the current state of the Looprch execution.

It provides a concise view of:

- the current phase;
- the current workflow stage;
- active work;
- blockers;
- the next expected action.

### Typical use

Use it whenever you want to know:

> "What is Looprch doing now, and what should happen next?"

It is useful for both the user and the Lead when resuming a long-running project.

---

## `/lr-phase`

### Purpose

Executes the current eligible project phase.

Looprch coordinates the complete workflow required for that phase.

Conceptually, this includes:

```text
Planning
→ Plan Debate
→ Implementation
→ Testing
→ Repairs
→ Review
→ Final Handover
→ Phase Completion
```

### Typical use

Use `/lr-phase` when you want Looprch to execute **one phase only** and then stop after that phase is completed.

This is useful when you want to review progress between phases or manually control when the next phase begins.

### Relationship with SEV3

The phase being executed comes from the SEV3 project definition.

Looprch uses the current phase, its requirements, dependencies, context, and related project information as the basis for execution.

---

## `/lr-auto`

### Purpose

Runs the project automatically through its phases.

Instead of stopping after one completed phase, Looprch continues to the next eligible phase and repeats the execution lifecycle.

### Typical use

Use `/lr-auto` when you want Looprch to continue executing the project with minimal manual intervention.

Conceptually:

```text
Phase 1
  ↓
Phase 2
  ↓
Phase 3
  ↓
...
  ↓
Final Phase
```

Each phase still goes through the normal planning, implementation, testing, review, and handover process.

---

## `/lr-pause`

### Purpose

Requests a controlled pause of the current Looprch execution.

The purpose is to stop further progress safely while preserving the existing project state.

### Typical use

Use it when you want to temporarily stop automatic or ongoing execution without losing the current project progress.

For example:

- you want to inspect the current implementation;
- you want to change model configuration;
- you need to stop work temporarily;
- you want to make a project/business decision before continuing.

---

## `/lr-resume`

### Purpose

Resumes a previously paused or interrupted Looprch execution.

Looprch continues from the stored project state rather than treating the project as a new execution.

### Typical use

Use it after:

- `/lr-pause`;
- an interrupted execution;
- a temporary external problem;
- a model/provider availability issue;
- reopening a project after a previous session ended.

The goal is continuity across long-running projects and multiple AI sessions.

---

## `/lr-review`

### Purpose

Performs an independent review of a phase.

It can be used to verify the current implementation or inspect a previously implemented phase.

### Typical use

Use it when you want an additional review or audit without rerunning the entire project lifecycle.

Examples:

- reviewing a completed phase;
- requesting a fresh technical review;
- checking implementation quality;
- validating a phase after external changes;
- auditing an older phase.

---

## `/lr-finish`

### Purpose

Completes the final project-closure process.

It ensures that the project's final SEV3 phase and overall completion activities are processed through Looprch.

### Typical use

Use it when the implementation phases are complete and you want Looprch to complete the final project closure and report the final evidence/state.

Conceptually, this represents the transition from:

```text
All implementation phases completed
                ↓
Final project verification / closure
                ↓
Project completed
```

---

## `/lr-worker`

### Purpose

Invokes the Looprch **Worker** helper for a bounded supporting task.

Worker is intended for auxiliary work such as:

- repository exploration;
- locating references;
- reading many files;
- dependency investigation;
- summarization;
- diff analysis;
- context preparation;
- bounded implementation assistance.

### Typical use

Use `/lr-worker` when a task can be separated from the main reasoning of the Lead, Planner, Implementer, Tester, or Reviewer.

For example:

```text
Planner
   ↓
Worker investigates authentication implementation
   ↓
Worker returns concise evidence
   ↓
Planner continues planning
```

Worker helps reduce unnecessary context consumption by the primary roles.

Worker is a supporting capability, not a replacement for the main Looprch roles.

---

# 3. Typical Command Flow

A normal project may use the commands approximately like this:

```text
/lr-init
   ↓
/lr-doctor
   ↓
/lr-status
   ↓
/lr-phase
   or
/lr-auto
```

During execution:

```text
/lr-status
/lr-worker
/lr-pause
/lr-resume
```

For additional verification:

```text
/lr-review
```

At the end of the project:

```text
/lr-finish
```

---

# 4. Relationship Between SEV3 and Looprch

SEV3 and Looprch are designed to work as two parts of the same overall software-development process.

## SEV3 responsibility

SEV3 defines the project.

It produces structured information such as:

- project requirements;
- implementation phases;
- phase objectives;
- dependencies;
- cross-phase context;
- contracts and interfaces;
- verification expectations;
- project research;
- implementation tracking information.

SEV3 answers:

> **What should be built, in what structure, and how should the project be divided?**

## Looprch responsibility

Looprch executes that definition.

It coordinates:

- Planner;
- Plan Debater;
- Implementer;
- Tester;
- Reviewer;
- Worker;
- project state;
- phase progress;
- handovers;
- execution evidence.

Looprch answers:

> **How do we coordinate the AI agents to correctly execute the project definition?**

The intended relationship is:

```text
Project idea
    ↓
SEV3
    ↓
Structured project definition
    ↓
Looprch
    ↓
AI execution lifecycle
    ↓
Completed project
```

The information generated by SEV3 should therefore be directly understandable and consumable by Looprch.

Looprch should not need to reconstruct the project definition that SEV3 already produced.

Likewise, SEV3 does not replace Looprch's execution orchestration.

They are complementary systems.

---

# 5. Relationship Between Looprch and delegate-skills

**delegate-skills** is an external open-source tool for delegating bounded work to coding-agent CLIs.

Official repository:

https://github.com/amElnagdy/delegate-skills

The key distinction is:

> **delegate-skills is an execution tool available to Looprch. It is not a stage in the Looprch lifecycle.**

Looprch owns the role, task, project context, and workflow. When a role is configured with `Delegate` invocation, delegate-skills can be used to deliver that bounded task to the configured external agent and return its result to Looprch.

Example:

```text
Looprch:
  Role = Implementer
  Agent = OpenCode
  Invocation = Delegate

Looprch prepares Implementer task/context
        ↓
delegate-skills
        ↓
configured OpenCode CLI
        ↓
agent result
        ↓
same Implementer workflow in Looprch continues
```

The lifecycle itself remains:

```text
Planner → Plan Debater → Implementer → Tester → Reviewer → Handover
```

delegate-skills may simply be the invocation mechanism underneath one or more of those roles.

A project can therefore mix invocation modes:

```text
Planner       → Codex      → Direct
Plan Debater  → Kimi       → Delegate
Implementer   → OpenCode   → Delegate
Tester        → Gemini     → Direct
Reviewer      → Codex      → Direct
```

These assignments should be established by project configuration and reused throughout project execution.

# 6. SEV3 + Looprch + delegate-skills

The systems should understand the contracts between them while keeping their responsibilities separate.

```text
SEV3
 │
 │ structured requirements, phases, dependencies, contracts, context
 ▼
Looprch
 │
 │ role needs its configured agent
 ▼
Invocation mode
 ├── Direct ───────────────────────────────┐
 └── Delegate → delegate-skills ───────────┤
                                           ▼
                                  Configured AI Agent
                                           │
                                           ▼
                               result returns to Looprch
```

| Component | Responsibility |
|---|---|
| **SEV3** | Define the project and provide its structured execution source |
| **Looprch** | Coordinate roles, phases, state, verification, repair, and completion |
| **Direct** | Invoke the configured agent directly |
| **Delegate** | Invoke a configured external agent through delegation |
| **delegate-skills** | Provide the tool used for supported Delegate execution |

SEV3 should produce information Looprch can consume without reconstructing the project specification.

Looprch should translate the relevant role task and context into the bounded input required by the selected invocation method.

When Delegate is selected, Looprch and delegate-skills should agree on the task, context, working directory, selected agent, and returned result. delegate-skills does not need to understand the complete Looprch lifecycle or read the entire SEV3 project; it receives the bounded work Looprch chooses to delegate.

# 7. Intended Overall Workflow

```text
User defines project
        ↓
SEV3 structures and defines the project
        ↓
SEV3 produces requirements and phases
        ↓
/lr-init
        ↓
Looprch connects to the SEV3 package
        ↓
User configures Role → Agent assignments
        ↓
Direct or Delegate is selected for each configured agent
        ↓
Looprch saves the project configuration
        ↓
Looprch executes phases
        ↓
Whenever a role needs an agent:
        ├── Direct → invoke configured agent directly
        └── Delegate → delegate-skills → configured external agent
        ↓
Result returns to the same Looprch role/workflow
        ↓
Testing / repair / review / handover
        ↓
Next SEV3 phase
        ↓
Final project closure
```

> **SEV3 defines the work. Looprch owns and coordinates the workflow. Direct or Delegate determines how Looprch invokes the selected agent. delegate-skills is an optional execution tool used when Delegate mode is selected.**
