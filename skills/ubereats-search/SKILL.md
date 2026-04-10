---
name: ubereats-search
description: Use when you need to search Uber Eats for a store, restaurant, product, or cuisine. Covers the top-of-page search bar, the quirks around search input focus and overlay rendering, filtering to grocery vs restaurants, and picking the right store from results. Only use within an active Uber Eats ordering flow — this is a sub-skill of ubereats-order.
---

# Uber Eats: Search

## Where to search from

The search bar lives at the top of every Uber Eats page. URL patterns that always work as a starting point:
- `https://www.ubereats.com/feed` — home feed, has search bar
- `https://www.ubereats.com/search` — search results page

Navigate via `mcp__playwright__browser_navigate` to one of these if you're lost.

## The search bar quirk

**This is the #1 reason Uber Eats automation fails.** The search "Search Uber Eats" input at the top isn't always immediately typeable. Clicking it often opens an overlay with a *different* input inside the overlay, and the original click target is no longer the one that receives text.

### Correct pattern

```
1. browser_snapshot (depth: 4) — get fresh refs
2. Locate the element described as "Search Uber Eats" OR with placeholder "Search Uber Eats"
3. browser_click on it — this may open an overlay
4. browser_snapshot (depth: 4) AGAIN — the overlay has new refs
5. In the new snapshot, find the input element that is FOCUSED and has an empty value
   (look for role="combobox" or role="searchbox" with no value)
6. browser_type on THAT ref, with the search query + slowly=false + submit=true
```

If `browser_type` fails with "element not found" or "element not interactable":
- Try `browser_fill_form` with a single field
- Try `browser_evaluate` with `() => { document.activeElement.value = 'your query'; document.activeElement.dispatchEvent(new Event('input', {bubbles:true})); }`
- As last resort: `browser_press_key` character by character (slow but always works)

## What to search for

### To find a GROCERY STORE (for food items + alcohol + produce)

Good queries (in order of preference):
- `Whole Foods` — carries grocery + beer/wine in most locations
- `Gopuff` — convenience + alcohol, fast delivery
- `Total Wine` — alcohol-only
- `Food Bazaar` / `Key Food` / `C-Town` — NYC grocery chains
- `Duane Reade` / `CVS` — last-resort convenience

### To find a RESTAURANT (for prepared food)

Search by cuisine (`pizza`, `ramen`, `sushi`, `tacos`) or by name (`Shake Shack`, `Joe's Pizza`).

### To find a SPECIFIC PRODUCT

Uber Eats top-level search supports product queries like `Modelo 12 pack` — it will return stores that carry it. This is often faster than browsing categories.

## Reading the results page

After submitting a search, `browser_snapshot` the results page. Look for:

1. **Store cards** — each has a name, cuisine/category, ETA, delivery fee, rating
2. **"Closed" / "Opens at X" badges** — skip these stores
3. **"Free delivery" or "$0 delivery fee"** — prefer when tied
4. **Distance / ETA** — shorter is better but not the deciding factor

### Pick the best store

Decision order:
1. Open + carries what you need + delivers to user's address + ETA ≤ 60 min = **use it**
2. If no perfect match, pick the one that carries the MOST items from the list (fewer multi-carts = less delivery fees)
3. Click the store card (`browser_click` on its name or main tile) to enter its page

## Filtering (if initial results are bad)

After search, Uber Eats shows filter chips near the top:
- `Grocery` / `Alcohol` / `Convenience` / `Restaurants` — click to filter
- `Delivery time` / `Rating` / `Price` — sort options

Use these when the initial feed has too many restaurants and you want grocery only.

## Dead ends and how to escape them

| Dead end | Escape |
|---|---|
| Search overlay won't close | Press `Escape` via `browser_press_key` |
| No results for query | Broaden the query (remove brand, use category: "beer" instead of "Modelo 12 pack") |
| "No stores deliver to your address" | The address is wrong OR the item category isn't deliverable locally. Snapshot, report, try a different category. |
| Search bar is not visible (mid-checkout) | Navigate back to `/feed` first |
| Infinite scroll loading forever | `browser_press_key` PageDown to trigger load, or navigate directly to a store URL if you know it |

## Confirming you're on the right store

Before adding to cart, `browser_snapshot` the store page and verify:
- Store name matches
- Delivery address shown is the user's default (do NOT change it)
- Store is marked "Open"
- There's a "Menu" or product grid visible

If any of these fail, back out and re-search.

Then invoke the `ubereats-add-to-cart` skill.
