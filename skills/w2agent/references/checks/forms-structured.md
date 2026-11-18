---
id: forms-structured
checks:
  - forms-structured
fixBy: agent
---

# Fix guide: labelled form fields

## Passes when

`forms-structured` looks at every `<form>` on every audited page. A form is well structured when each of its `input`, `select` and `textarea` fields has a `name` attribute and a label. `input` elements of type `hidden` or `submit` are skipped. Every other `input`, including `type="button"`, `reset`, `image` and `checkbox`, must have both. A label is one of:

- a `<label for="<id>">` that matches the field's `id`, when the field has an `id`;
- an enclosing `<label>`, when the field has no `id` (a field that has an `id` but sits inside a `<label>` without `for` does not count);
- an `aria-label` or `aria-labelledby` attribute.

The score is the share of well-structured forms across all pages. 80 or more passes, above 0 is `partial`, 0 is `fail`. A site with no forms is `skip` (not applicable): no edit.

## Who fixes it

You do (`fixBy: agent`). `integrate` changes no form markup. The edit adds missing attributes to existing fields. It never changes what a visitor sees or sends.

## Fix (any framework)

1. List the forms on the site and find the fields that lack a `name` or a label. The audit message gives the count of good forms, not which fail, so read the form components.
2. Add a `name` to each field that has none. Use the key the submit handler already reads. If the handler reads none (state-driven inputs), use a short lowercase key from the field's visible label (`email`, `phone`, `message`).
3. Give each field a label. Prefer wiring the existing visible label with `htmlFor` and `id`. Where the form shows no visible label (for example a placeholder only), add `aria-label` with the placeholder's own text.
4. Never rename an existing `name`: server handlers and form libraries read it.

## Next.js (App Router)

`integrate` covers nothing for this check on Next.js. Edit the form components. A form in a Client Component is still rendered into the server HTML, which the audit reads.

```tsx
<label htmlFor="contact-email">Email</label>
<input id="contact-email" name="email" type="email" />

<textarea name="message" aria-label="Message" />
```

- React's `htmlFor` becomes `for` in the HTML. Give the field and its label the same `id`. Use `useId()` for an `id` that stays unique when a component renders more than once.
- If the label wraps the field and the field also has an `id`, add `htmlFor` to the label as well, or drop the `id` when nothing else uses it.
- Server Actions read `formData.get("<name>")`. Match the `name` to that key.
- A form that already uses `aria-label` on each field needs only the missing `name`s.

## Pitfalls

- Do not change `type`, `value`, `onChange`, `action` or any handler.
- Do not add visible text, hide fields, or restructure the form. `aria-label` is enough for a field with no visible label.
- A third-party embed (an iframe form) is not in the audited HTML. It cannot be fixed here: report it.
- A form loaded only on the client (`dynamic(..., { ssr: false })`) is not in the audited HTML either.

## Verify

Build and serve the site, then run `audit <local url> --json`. Watch `forms-structured`: expected `pass` (80 or more). The message shows `N/M forms have proper labels and names`. If a form still fails, check for a field with an `id` and an unmatched wrapping `<label>`, an `input type="button"` without a `name` or label, and a field that has `name` but no label.
