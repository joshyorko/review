---
name: bluefin-doctrine
---

Judge this diff against Project Bluefin's projected review doctrine. Read
`~/.agents/skills/pr-review/SKILL.md` and any of its `references/` that match
the change, then answer, with file and line evidence:

1. Does the change stay inside the scope its title and linked issue claim?
2. Does it follow the org's documented conventions for the files it touches?
3. Is it sized and structured for a tired maintainer to review?

4. Do the implementation, tests, and applicable durable documentation remain
   mutually consistent with the current model? Report a finding only with
   concrete contradictory evidence naming the file and line. A change where
   no documentation change is needed is valid. Treat insufficient evidence as
   uncertainty, not a finding; changed-file patterns or documentation absence
   alone are not proof of drift.

Report only evidenced findings with severity and location. If the doctrine
documents are absent, say so and stop — do not improvise a substitute
doctrine.
