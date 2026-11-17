---
id: usage-preferences
checks:
  - usage-preference-declared
fixBy: owner
---

# Fix guide: declared AI usage preferences

## Passes when

`usage-preference-declared` passes (100) when the site declares at least one AI usage preference in any of five vocabularies:

- `Content-Signal` lines in `robots.txt` with at least one `key=value` pair;
- `Content-Usage` lines in `robots.txt`, with a parseable preference list;
- a `Content-Usage` HTTP response header on the home page, with a parseable preference list;
- a `License:` line in `robots.txt` whose value is an absolute URI (RSL);
- `/.well-known/tdmrep.json` (served as JSON): an array with at least one rule that has a string `location` and a `tdm-reservation` of 0 or 1 (TDMRep).

A `Content-Signal` block that a CDN adds to `robots.txt` also counts. The message then says "CDN-managed default", and the owner may not know it exists.

With none of these the status is `skip` (score 0): "no declaration found". It is never `fail`, and the check has weight 0, so it does not change the audit score. The pass message also reports what the site says about model training for the home page. A rule that names one crawler, or covers a path that does not include `/`, is listed in `details` but does not change that training statement.

## Who fixes it

The owner does (`fixBy: owner`). Whether a site allows AI training, AI search or AI input is a legal and business decision. Neither `audit` nor `integrate` can make it: `integrate` writes no preference of any kind, and the check never reads the choice as good or bad.

A `skip` means the site made no declaration. It is not a failed requirement and never authorizes an edit. Report it as "no AI usage preference declared (owner decision)".

## Fix (any framework)

Do not edit anything. For the final report:

1. Say the check is `skip` and no preference is declared.
2. Name the vocabularies and places in the list above, and say that each has its own grammar. Point to the specs, not to a recommended value.
3. Ask for the decision: what the owner permits for training, for AI search, and for user-initiated AI access.

Write nothing until the owner gives the policy in words. When they do, put it in the file or header the owner picks, in the exact syntax of that spec, and add the rule to the existing `robots.txt` only with the owner's approval (see the `robots-access` guide: an existing `robots.txt` is the owner's file).

## Pitfalls

- Do not add `Content-Signal: ai-train=no` or any other value as a default. A declaration is a published position. A wrong one costs the owner money or rights, in either direction.
- Do not read `skip` as a fault to be repaired and do not rewrite `robots.txt` to clear it.
- Do not create `/.well-known/tdmrep.json` on a guess. The check only reads it when it is served as JSON.
- Do not mix the vocabularies in one line. They have different grammars and values.

## Verify

After the owner declares a preference, run `audit <local url> --json`. Expected: `usage-preference-declared` is `pass`, and its message and `details` show the signals the check read. If it stays `skip`, the declaration is in a place the check does not read, or it does not parse; compare the syntax with the spec for that vocabulary.
