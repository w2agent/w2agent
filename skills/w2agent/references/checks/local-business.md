---
id: local-business
checks:
  - local-business-nap-structured
  - local-business-hours-jsonld
fixBy: agent
---

# Fix guide: local business name, address, phone and hours in JSON-LD

## Passes when

Both checks only run on sites detected as local businesses. They read the JSON-LD on every audited page. The first item on a page whose `@type` is a local-business type decides for that page (blocks in document order; items inside `@graph` count). The accepted `@type` strings are `LocalBusiness`, `Restaurant`, `FoodEstablishment`, `Bakery`, `BarOrPub`, `CafeOrCoffeeShop`, `FastFoodRestaurant`, `Dentist`, `MedicalBusiness`, `Physician`, `Optician`, `HealthAndBeautyBusiness`, `BeautySalon`, `HairSalon`, `NailSalon`, `DaySpa`, `LegalService`, `Lawyer`, `Accountant`, `FinancialService`, `AutoRepair`, `AutomotiveBusiness`, `GasStation`, `HomeAndConstructionBusiness`, `Plumber`, `Electrician`, `HVACBusiness`, `Locksmith`, `ProfessionalService`, `SportsActivityLocation`, `Store`, `EntertainmentBusiness`, as a string or inside an array. An item with an empty `name` makes the whole page count as having none.

- `local-business-nap-structured`: counts three fields in the best page: `name` (non-empty string), `address` (an object with at least one non-empty string among `streetAddress`, `addressLocality`, `addressRegion`, `postalCode`, `addressCountry`; a plain string does not count) and `telephone` (non-empty string). Schema.org microdata with `itemprop` values also counts. 3 of 3 passes (100). Otherwise it is `partial` (33 or 67). It is `skip` when no page has local-business structured data.
- `local-business-hours-jsonld`: passes (100) when some page's local-business item has `openingHoursSpecification` with at least one valid entry. An entry is valid when it has a string `opens`, a string `closes` and a `dayOfWeek`. A single object or an array of objects both work. `dayOfWeek` may be one string or a list. The `openingHours` string form does not count. With local-business JSON-LD but no valid entry it is `fail` (0). It is `skip` when no page has local-business JSON-LD.

## Who fixes it

You do (`fixBy: agent`), for the fields the site already shows. `integrate` writes no JSON-LD on Next.js. A `skip` is a measurement gap, not a failed requirement: the `schema-org` guide says how to add the `LocalBusiness` block, and adding it makes these checks run. Once it exists, add the missing fields to that same block. A field the site does not show is an owner item.

## Fix (any framework)

1. Use the one `LocalBusiness` JSON-LD block that the `schema-org` guide puts on the home page. Add fields to that block. Do not add a second local-business block on the same page: only the first one is read.
2. `@type` is the one string `"LocalBusiness"`. A subtype such as `"Plumber"` passes these two checks but not `schema-org-type`, which matches `LocalBusiness` as a substring. Do not use an array.
3. `name`: the business name as the site shows it. It must not be empty.
4. `address`: an object `{"@type": "PostalAddress", "streetAddress", "addressLocality", "addressRegion", "postalCode"}` from the address in the page or footer. Leave out the parts the site does not show.
5. `telephone`: the phone number as the page shows it.
6. `openingHoursSpecification`: from the hours the page shows. One object per distinct time range. Use 24-hour `HH:MM` for `opens` and `closes`, and full English day names:

```json
"openingHoursSpecification": [
  {
    "@type": "OpeningHoursSpecification",
    "dayOfWeek": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    "opens": "09:00",
    "closes": "17:00"
  },
  {
    "@type": "OpeningHoursSpecification",
    "dayOfWeek": "Saturday",
    "opens": "10:00",
    "closes": "14:00"
  }
]
```

A day that the page shows as closed gets no entry. If the page shows no opening hours, add none: leave the check `fail` and report it as an owner item.

## Next.js (App Router)

`integrate` covers nothing for this check on Next.js. The block lives in the home `page.tsx`, from the `schema-org` guide. Extend that object:

```tsx
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  name: "Example Plumbing",
  url: "https://www.example.com/",
  telephone: "+1 555 010 0100",
  address: {
    "@type": "PostalAddress",
    streetAddress: "1 Main Street",
    addressLocality: "Springfield",
    addressRegion: "IL",
    postalCode: "62701",
  },
  openingHoursSpecification: [
    {
      "@type": "OpeningHoursSpecification",
      dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
      opens: "08:00",
      closes: "18:00",
    },
  ],
};
```

Every value above is a placeholder: replace it with what the site shows, and delete a key the site does not show. Keep the `<script type="application/ld+json">` pattern from the `schema-org` guide (escape `<` as `<`). Do not put this block in the root layout.

## Pitfalls

- Use only real data the site shows. Never invent a phone number, address, hours or `geo`. A missing field is better than a made-up one.
- Hours come from the stated opening hours only. "Emergency line available 24 hours" is not the business's opening hours.
- Do not add `openingHours` strings instead of `openingHoursSpecification`. They do not count.
- Do not add a nameless item or a second local-business block. The first one decides.
- Do not mark up a `ReserveAction` or booking URL the site does not have.
- Do not rewrite or move page copy to feed the markup.

## Verify

Build and serve the site, then run `audit <local url> --json`. Watch `local-business-nap-structured` and `local-business-hours-jsonld`: expected `pass`. If NAP is `partial`, the message says how many of the three fields were found: the site must show the missing one, otherwise report it. If hours stay `fail`, the page shows no hours, or an entry lacks `opens`, `closes` or `dayOfWeek`.
