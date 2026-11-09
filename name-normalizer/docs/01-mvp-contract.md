# Local MVP Contract

## Goal

Automatically process one input string that represents a given name, surname,
or patronymic for speech synthesis.

## Input

- One user-entered string.
- The app never receives or reconstructs a full name.
- The production database is not connected during the MVP phase.

## Output

- One normalized string containing `+` stress markers; or
- `UNKNOWN` only for an obviously invalid value.

The visible result has no comments, explanation, Markdown, or extra lines.

## Stress Marker Contract

The MVP follows the current Word instruction: `+` is placed immediately before
the stressed vowel. Historical rows that place `+` before a consonant are not
treated as ground truth for prompt evaluation.

## MVP Scope

Included:

- local user input;
- spelling normalization and stress placement;
- handling of Latin spelling, obvious typos, and service text;
- a local result log;
- testing against a curated part of the historical CSV.

Excluded:

- direct production database access;
- full-name access or assembly;
- automatic physical deletion of records;
- public internet deployment.

## UNKNOWN Policy

`UNKNOWN` is returned only for unambiguous technical garbage, such as an empty
value, an Excel error, a string made only of symbols, or a value with no signs
of being a name. An unusual or rare name is not enough reason to return
`UNKNOWN`.

The MVP does not physically delete anything. It only returns a processed value
or `UNKNOWN`; any later database action belongs to the production integration.

## Automation Policy

There is no manual-review branch in the production decision flow. Every valid
input must receive an automatic best-effort normalized result. `UNKNOWN` is
reserved for deterministic, unambiguous garbage cases and is not a substitute
for model uncertainty.

## MVP Completion

The local app accepts one string, returns only a valid result, passes an agreed
test against historical data, and is ready for a management demonstration.
