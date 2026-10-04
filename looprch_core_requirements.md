# Looprch --- Core Requirements

## 1. Overview

Looprch is an AI software-development orchestration system that
coordinates specialized AI agents to implement a software project from
an existing structured specification.

Its core purpose is to manage project execution phase by phase until the
complete project is implemented.

> **The specification defines what must be built. Looprch coordinates
> the agents that build and verify it.**

## 2. Primary Goal

Looprch must coordinate the complete software implementation lifecycle
across multiple AI agents while maintaining project continuity,
progress, execution knowledge, and phase status.

## 3. Project Execution

For every project phase, Looprch coordinates: 1. understanding the phase
and relevant requirements; 2. implementation planning; 3. critical
review of the plan; 4. implementation; 5. testing; 6. correction of
discovered problems; 7. independent review; 8. final implementation
handover; 9. phase completion; 10. continuation to the next phase.

The process continues until all project phases are complete.

## 4. Lead

The **Lead** coordinates the overall execution process.

It tracks project state, invokes the appropriate agents, routes work and
results between them, follows progress, handles operational
coordination, and keeps the workflow moving.

## 5. Planner

The **Planner** understands the current phase and produces its
implementation plan using the relevant project requirements,
dependencies, existing implementation, and expected outcomes.

## 6. Plan Debater

The **Plan Debater** critically evaluates the proposed implementation
plan and identifies weaknesses, missing considerations, incorrect
assumptions, dependency problems, or architectural inconsistencies.

The Planner uses this feedback to finalize the plan.

## 7. Implementer

The **Implementer** executes the approved implementation plan and
produces the required project changes.

A phase may contain multiple implementation responsibilities, and
independent work may be handled by multiple Implementers when
appropriate.

## 8. Tester

The **Tester** independently verifies the implementation.

It determines the required testing work, executes tests, identifies
failures or missing behavior, and reports problems for correction.

Corrected work is tested again until the required behavior is verified.

## 9. Reviewer

The **Reviewer** independently evaluates the completed implementation
against the approved plan, project requirements, implementation quality,
relevant context, and verification results.

Problems identified during review return to the appropriate
implementation work for correction.

## 10. Worker

The **Worker** is a general-purpose supporting agent that can assist the
primary agents with separate work such as repository exploration,
information gathering, dependency analysis, large-context investigation,
comparison, repetitive analysis, context preparation, and bounded
implementation assistance.

Worker supports the primary agents but does not replace their
responsibilities.

## 11. Implementation Handover

After implementation, testing, corrections, and review are complete, the
responsible Implementer produces a final handover.

The handover preserves important implementation knowledge, including
what was completed, what changed, important technical decisions, and
information relevant to future work.

When multiple Implementers contribute to a phase, their work remains
individually traceable and can be combined into phase-level knowledge.

## 12. Project Continuity

Looprch maintains continuity throughout the project.

Relevant outcomes, decisions, dependencies, verification results,
handovers, and execution state from earlier work remain available to
later work when needed.

## 13. Execution State

Looprch maintains the current execution state of the project,
including: - current phase; - completed phases; - active work; -
responsible agents; - approved planning; - testing and review status; -
unresolved issues; - handovers; - execution evidence; - next work.

This allows project execution to continue consistently across multiple
AI sessions and over long-running projects.

## 14. Agent Sessions

Looprch manages the AI agent sessions involved in the project.

Agents may continue across related work when preserving their working
context is useful, and Looprch maintains the relationship between tasks,
agents, and sessions.

## 15. Model Configuration

Looprch allows different AI agents or models to be assigned to different
responsibilities.

Projects can define preferred and alternative models for primary roles
and supporting Workers.

## 16. Model Availability and Usage Awareness

Looprch can use model availability and usage information to support
operational scheduling decisions, including whether to use a preferred
model, another configured model, or wait for availability.

## 17. Parallel Work

Looprch can execute independent work concurrently when the project plan
allows it.

This can include parallel implementation responsibilities and parallel
Worker investigations.

Parallel results return to the main project workflow before phase
completion.

## 18. Testing and Repair

Testing is an iterative part of implementation.

Problems discovered during testing return to implementation, are
corrected, and are verified again until the required behavior is
achieved.

## 19. Review and Repair

Independent review is also iterative.

Problems identified during review return to the appropriate
implementation work, and affected verification is repeated after
correction.

## 20. Git Integration

Looprch uses Git as part of project execution and traceability.

Git records concrete project changes, while implementation handovers
preserve the semantic knowledge explaining what happened and why.

## 21. Phase Completion

A phase is complete after its planned work has been implemented and its
required testing, corrections, review, handover, and completion
activities are finished.

Looprch then continues to the next phase.

## 22. Project Completion

Looprch continues until the complete project plan has been executed.

At completion, the project has a traceable history of planning,
implementation, testing, repairs, reviews, handovers, phase outcomes,
and final project state.

## 23. Relationship with SEV3

SEV3 and Looprch have complementary responsibilities.

**SEV3 defines the project.**

It provides the structured requirements, implementation phases,
dependencies, project context, and planning information.

**Looprch executes the project.**

It consumes that project definition and coordinates the AI agents that
turn it into a completed implementation.

> **SEV3 defines the project correctly → Looprch executes it
> correctly.**
